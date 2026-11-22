// Offline-first sync engine.
//   serverState = last state confirmed by the server (persisted locally)
//   outbox      = operations made on this device not yet acknowledged
//   view        = serverState + outbox replayed (what the UI shows)
import * as kv from './kv.js';
import { loadState, cloneState, applyOp, findFreeSlot, normalizeSampleNumber } from '../shared/logic.js';
import { SAMPLE_TYPES } from '../shared/constants.js';

const MAX_LOCAL_EVENTS = 3000;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

export class Sync extends EventTarget {
  constructor() {
    super();
    this.settings = { user: '', serverUrl: '', accessCode: '', deviceId: '' };
    this.rev = 0;
    this.serverState = loadState();
    this.events = [];
    this.outbox = [];
    this.view = cloneState(this.serverState);
    this.status = 'idle'; // idle | syncing | offline | error | unauthorized
    this.lastSyncAt = null;
    this.lastError = '';
    this.conflicts = [];
    this._pushing = null;
    this._es = null;
    this._timer = null;
  }

  async init() {
    const [settings, snap, outbox, conflicts] = await Promise.all([kv.get('settings'), kv.get('snapshot'), kv.get('outbox'), kv.get('conflicts')]);
    Object.assign(this.settings, settings || {});
    if (!this.settings.deviceId) { this.settings.deviceId = uuid(); await kv.set('settings', this.settings); }
    if (snap) {
      this.rev = snap.rev || 0;
      this.serverState = loadState(snap.samples, snap.racks);
      this.events = snap.events || [];
      this.lastSyncAt = snap.lastSyncAt || null;
    }
    this.outbox = outbox || [];
    this.conflicts = conflicts || [];
    this._rebuild();
  }

  get apiBase() {
    const base = (this.settings.serverUrl || (/^https?:/.test(location.protocol) ? location.origin : '')).replace(/\/+$/, '');
    return base ? `${base}/api` : '';
  }

  async saveSettings(patch) {
    const serverChanged = patch.serverUrl !== undefined && patch.serverUrl !== this.settings.serverUrl;
    Object.assign(this.settings, patch);
    await kv.set('settings', this.settings);
    if (serverChanged) {
      // New server = new database. Keep unsent work in the outbox.
      this.rev = 0; this.serverState = loadState(); this.events = [];
      await this._saveSnapshot();
      this._rebuild();
    }
    this.restart();
  }

  start() {
    window.addEventListener('online', () => this.syncNow());
    window.addEventListener('offline', () => this._setStatus('offline'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.syncNow(); });
    this.restart();
  }

  restart() {
    this._connectStream();
    clearInterval(this._timer);
    this._timer = setInterval(() => this.syncNow(), 30000);
    this.syncNow();
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _setStatus(s, err = '') { this.status = s; this.lastError = err; this._emit('status'); }

  _rebuild() {
    const v = cloneState(this.serverState);
    for (const op of this.outbox) applyOp(v, op, { now: op.at });
    this.view = v;
    this._emit('change');
  }

  /** Recent activity, newest first, including not-yet-synced local actions. */
  activity() {
    const pending = [];
    const v = cloneState(this.serverState);
    for (const op of this.outbox) {
      const r = applyOp(v, op, { now: op.at });
      if (r.ok) for (const e of r.events) pending.push({ ...e, pending: true });
    }
    return [...pending.reverse(), ...[...this.events].reverse()];
  }

  /**
   * Record an action. It is checked against the current view, applied
   * immediately, queued, and pushed to the server when online.
   */
  submit(kind, data) {
    const op = { op_id: uuid(), kind, data: { ...data }, user: this.settings.user || 'unknown', device: this.settings.deviceId, at: new Date().toISOString() };
    // Resolve auto slot assignment on this device so the slot shown is the slot recorded.
    if (kind === 'store' && op.data.rack == null) {
      const s = this.view.samples.get(normalizeSampleNumber(op.data.sample_number));
      if (s && !s.deleted && s.rack == null && SAMPLE_TYPES[s.sample_type]?.storable) {
        const slot = findFreeSlot(this.view, s.sample_type);
        if (slot) Object.assign(op.data, slot);
      }
    }
    const trial = cloneState(this.view);
    const r = applyOp(trial, op, { now: op.at });
    if (!r.ok) return r;
    if (r.changedSamples.length === 0 && r.changedRacks.length === 0) return r; // no-op
    this.view = trial;
    this.outbox.push(op);
    kv.set('outbox', this.outbox);
    this._emit('change');
    this.push().catch(() => { /* stays queued; status shows offline */ });
    return r;
  }

  async _fetch(path, opts = {}) {
    if (!this.apiBase) throw Object.assign(new Error('No sync server configured'), { offline: true });
    const headers = { 'Content-Type': 'application/json', ...(this.settings.accessCode ? { 'X-Lucy-Code': this.settings.accessCode } : {}) };
    let res;
    try {
      res = await fetch(this.apiBase + path, { ...opts, headers, cache: 'no-store' });
    } catch (e) { throw Object.assign(new Error('Server unreachable'), { offline: true }); }
    if (res.status === 401) throw Object.assign(new Error('Access code required or incorrect'), { unauthorized: true });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    return res.json();
  }

  async syncNow() {
    try {
      await this.push();
      await this.pull();
    } catch { /* status already set */ }
  }

  push() {
    if (this._pushing) return this._pushing.then(() => (this.outbox.length ? this.push() : undefined));
    if (!this.outbox.length) return Promise.resolve();
    this._pushing = (async () => {
      const batch = this.outbox.slice(0, 200);
      this._setStatus('syncing');
      try {
        const { results } = await this._fetch('/ops', { method: 'POST', body: JSON.stringify({ ops: batch }) });
        const done = new Set();
        for (const res of results) {
          if (!res.op_id) continue;
          done.add(res.op_id);
          const op = batch.find((o) => o.op_id === res.op_id);
          if (!res.ok) this._notice('error', `Not saved: ${describeOp(op)} — ${res.error}`);
          else if (res.conflict) this._addConflict({ ...res.conflict, message: res.message, at: new Date().toISOString() });
        }
        this.outbox = this.outbox.filter((o) => !done.has(o.op_id));
        await kv.set('outbox', this.outbox);
        await this.pull();
      } catch (e) {
        this._handleError(e);
        throw e;
      } finally {
        this._pushing = null;
      }
    })();
    return this._pushing;
  }

  async pull() {
    try {
      const data = await this._fetch(`/changes?since=${this.rev}`);
      if (data.full) { this.serverState = loadState(data.samples, data.racks); this.events = data.events; }
      else if (data.rev !== this.rev || data.samples.length || data.racks.length) {
        const st = cloneState(this.serverState);
        for (const s of data.samples) st.samples.set(s.sample_number, { ...s, received: !!s.received, deleted: !!s.deleted });
        for (const r of data.racks) st.racks.set(r.id, r);
        const ids = new Set(this.events.map((e) => e.id));
        this.events = this.events.concat(data.events.filter((e) => !ids.has(e.id))).slice(-MAX_LOCAL_EVENTS);
        // Rebuild slot index from scratch: robust against moves.
        st.slots.clear();
        for (const s of st.samples.values()) if (!s.deleted && s.rack != null) st.slots.set(`${s.rack}:${s.row}:${s.col}`, s.sample_number);
        this.serverState = st;
      }
      this.rev = data.rev;
      this.lastSyncAt = new Date().toISOString();
      await this._saveSnapshot();
      this._rebuild();
      this._setStatus(this.outbox.length ? 'syncing' : 'idle');
    } catch (e) {
      this._handleError(e);
      throw e;
    }
  }

  _handleError(e) {
    if (e.unauthorized) this._setStatus('unauthorized', e.message);
    else if (e.offline) this._setStatus('offline', e.message);
    else this._setStatus('error', e.message);
  }

  async _saveSnapshot() {
    await kv.set('snapshot', {
      rev: this.rev, lastSyncAt: this.lastSyncAt, events: this.events,
      samples: [...this.serverState.samples.values()], racks: [...this.serverState.racks.values()],
    });
  }

  _connectStream() {
    if (this._es) { this._es.close(); this._es = null; }
    if (!this.apiBase || typeof EventSource === 'undefined') return;
    const q = this.settings.accessCode ? `?code=${encodeURIComponent(this.settings.accessCode)}` : '';
    const es = new EventSource(`${this.apiBase}/stream${q}`);
    es.addEventListener('rev', (ev) => {
      try { const { rev } = JSON.parse(ev.data); if (rev !== this.rev) this.syncNow(); } catch { /* ignore */ }
    });
    es.onopen = () => this.syncNow();
    this._es = es;
  }

  _notice(level, message) { this._emit('notice', { level, message }); }

  _addConflict(c) {
    this.conflicts.push(c);
    kv.set('conflicts', this.conflicts);
    this._emit('conflict', c);
  }

  dismissConflict(i) {
    this.conflicts.splice(i, 1);
    kv.set('conflicts', this.conflicts);
    this._emit('change');
  }

  async history(sampleNumber) {
    try { return (await this._fetch(`/samples/${encodeURIComponent(sampleNumber)}/history`)).events; }
    catch { return null; }
  }
}

function describeOp(op) {
  if (!op) return 'change';
  const n = op.data?.sample_number;
  const verbs = { receive: 'receive', store: 'store', retrieve: 'retrieve', update: 'edit', delete: 'delete', set_rack_type: 'rack change' };
  return `${verbs[op.kind] || op.kind}${n ? ` ${n}` : ''}`;
}

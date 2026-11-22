// Pure inventory rules shared by the sync server (authoritative) and every
// client (optimistic/offline). Records are treated as immutable: every change
// replaces the object in its Map, so cloning a state only copies the Maps.

import {
  RACK_COUNT, ROWS, COLS, SAMPLE_TYPES, defaultRackType, positionLabel,
} from './constants.js';

export function normalizeSampleNumber(v) {
  return String(v ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

export const slotKey = (rack, row, col) => `${rack}:${row}:${col}`;

export function createState() {
  const state = { samples: new Map(), racks: new Map(), slots: new Map() };
  for (let id = 1; id <= RACK_COUNT; id++) {
    state.racks.set(id, { id, sample_type: defaultRackType(id), updated_at: null, rev: 0 });
  }
  return state;
}

export function loadState(samples = [], racks = []) {
  const state = createState();
  for (const r of racks) state.racks.set(r.id, { ...r });
  for (const s of samples) state.samples.set(s.sample_number, normalizeRecord(s));
  indexSlots(state);
  return state;
}

export function normalizeRecord(s) {
  return { ...s, received: !!s.received, deleted: !!s.deleted };
}

export function indexSlots(state) {
  state.slots.clear();
  for (const s of state.samples.values()) {
    if (!s.deleted && s.rack != null) state.slots.set(slotKey(s.rack, s.row, s.col), s.sample_number);
  }
}

export function cloneState(state) {
  return { samples: new Map(state.samples), racks: new Map(state.racks), slots: new Map(state.slots) };
}

export function rackOccupancy(state, rackId) {
  let n = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (state.slots.has(slotKey(rackId, r, c))) n++;
  return n;
}

export function isValidSlot(rack, row, col) {
  return Number.isInteger(rack) && Number.isInteger(row) && Number.isInteger(col)
    && rack >= 1 && rack <= RACK_COUNT && row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

/** First empty slot (rack → row A..I → column 1..12) in a rack assigned to `type`. */
export function findFreeSlot(state, type, preferRack = null) {
  const racks = [...state.racks.values()].filter((r) => r.sample_type === type).map((r) => r.id).sort((a, b) => a - b);
  if (preferRack != null && racks.includes(preferRack)) racks.unshift(...racks.splice(racks.indexOf(preferRack), 1));
  for (const rack of racks) {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!state.slots.has(slotKey(rack, row, col))) return { rack, row, col };
      }
    }
  }
  return null;
}

function blankSample(n, now) {
  return {
    sample_number: n, sample_type: null, received: false, status: 'not_received',
    rack: null, row: null, col: null,
    received_at: null, received_by: null, stored_at: null, stored_by: null,
    retrieved_at: null, retrieved_by: null, notes: '',
    created_at: now, updated_at: now, rev: 0, deleted: false,
  };
}

const fail = (error) => ({ ok: false, error });

/**
 * Apply one operation. Validates fully before mutating, so a failed op leaves
 * the state untouched.
 *   op  = { op_id, kind, data, user, device, at }
 *   ctx = { now, rev }  (rev = server revision; null on clients)
 * Returns { ok, error?, message?, conflict?, sample?, changedSamples, changedRacks, events }.
 */
export function applyOp(state, op, ctx = {}) {
  const now = ctx.now || op.at || new Date().toISOString();
  const rev = ctx.rev ?? null;
  const user = String(op.user || 'unknown').slice(0, 60);
  const d = op.data || {};
  const changedSamples = [];
  const changedRacks = [];
  const events = [];

  const put = (s) => {
    const prev = state.samples.get(s.sample_number);
    if (prev && !prev.deleted && prev.rack != null) state.slots.delete(slotKey(prev.rack, prev.row, prev.col));
    const rec = { ...s, updated_at: now, rev };
    state.samples.set(rec.sample_number, rec);
    if (!rec.deleted && rec.rack != null) state.slots.set(slotKey(rec.rack, rec.row, rec.col), rec.sample_number);
    changedSamples.push(rec);
    return rec;
  };
  const log = (sample_number, action, detail, sample_type = null) => {
    events.push({ op_id: op.op_id || null, sample_number, sample_type, action, detail, user, device: op.device || null, at: now, rev });
  };
  const done = (sample, message, extra = {}) => ({ ok: true, sample, message, changedSamples, changedRacks, events, ...extra });

  switch (op.kind) {
    case 'receive': {
      const n = normalizeSampleNumber(d.sample_number);
      if (!n) return fail('Sample number is required.');
      if (n.length > 64) return fail('Sample number is too long.');
      const type = d.sample_type;
      if (!SAMPLE_TYPES[type]) return fail('Choose a sample type.');
      const existing = state.samples.get(n);
      const live = existing && !existing.deleted ? existing : null;
      const received = d.received !== false;
      if (live && live.rack != null && live.sample_type !== type) {
        return fail(`${n} is stored as ${SAMPLE_TYPES[live.sample_type].label} at ${positionLabel(live.rack, live.row, live.col)}. Retrieve it before changing its type.`);
      }
      const base = live || blankSample(n, now);
      const next = { ...base, sample_type: type, received, deleted: false };
      if (d.notes != null) next.notes = String(d.notes).slice(0, 500);
      if (received) {
        next.received_at = live?.received ? live.received_at : now;
        next.received_by = live?.received ? live.received_by : user;
        if (live?.rack != null) next.status = 'stored';
        else if (live?.received && live.status === 'retrieved') next.status = 'retrieved';
        else next.status = 'received';
      } else {
        next.received_at = null; next.received_by = null;
        next.status = 'not_received';
        next.rack = null; next.row = null; next.col = null;
      }
      const rec = put(next);
      log(n, received ? 'received' : 'not_received', SAMPLE_TYPES[type].label, type);
      if (live && live.rack != null && !received) log(n, 'removed', `Slot ${positionLabel(live.rack, live.row, live.col)} freed (marked not received)`, type);
      return done(rec, received ? `${n} logged as received (${SAMPLE_TYPES[type].label}).` : `${n} logged as NOT received.`);
    }

    case 'store': {
      const n = normalizeSampleNumber(d.sample_number);
      const s = state.samples.get(n);
      if (!s || s.deleted) return fail(`Sample ${n || '(blank)'} has not been received yet. Log it on the Receive screen first.`);
      if (!s.received) return fail(`${n} is marked as not received.`);
      const t = SAMPLE_TYPES[s.sample_type];
      if (!t?.storable) return fail(`${t?.label || 'This type'} samples do not have storage racks.`);

      const wanted = d.rack != null ? { rack: +d.rack, row: +d.row, col: +d.col } : null;
      if (wanted) {
        if (!isValidSlot(wanted.rack, wanted.row, wanted.col)) return fail('That slot does not exist.');
        const rackType = state.racks.get(wanted.rack)?.sample_type;
        if (rackType !== s.sample_type) {
          return fail(`Rack ${wanted.rack} is a ${SAMPLE_TYPES[rackType]?.label || 'different'} rack; ${n} is ${t.label}.`);
        }
        if (s.rack === wanted.rack && s.row === wanted.row && s.col === wanted.col) {
          return done(s, `${n} is already at ${positionLabel(s.rack, s.row, s.col)}.`);
        }
      } else if (s.rack != null) {
        return done(s, `${n} is already at ${positionLabel(s.rack, s.row, s.col)}.`);
      }

      let target = wanted;
      let conflict = null;
      const occupant = wanted && state.slots.get(slotKey(wanted.rack, wanted.row, wanted.col));
      if (!wanted || occupant) {
        // Free this sample's current slot for the search only if it is moving.
        target = findFreeSlot(state, s.sample_type, wanted?.rack ?? null);
        if (!target) return fail(`All ${t.label} racks are full. Assign another rack to ${t.label} in Settings.`);
        if (occupant) {
          conflict = { sample_number: n, requested: wanted, assigned: target, occupant };
        }
      }
      const moving = s.rack != null;
      const from = moving ? positionLabel(s.rack, s.row, s.col) : null;
      const rec = put({ ...s, rack: target.rack, row: target.row, col: target.col, status: 'stored', stored_at: now, stored_by: user });
      const where = positionLabel(rec.rack, rec.row, rec.col);
      log(n, moving ? 'moved' : 'stored', moving ? `${from} → ${where}` : where, s.sample_type);
      if (conflict) {
        const msg = `Slot ${positionLabel(wanted.rack, wanted.row, wanted.col)} was already taken by ${occupant}. ${n} was recorded at ${where} instead — please place the tube there.`;
        log(n, 'conflict', msg, s.sample_type);
        return done(rec, msg, { conflict });
      }
      return done(rec, `${n} stored at ${where}.`);
    }

    case 'retrieve': {
      const n = normalizeSampleNumber(d.sample_number);
      const s = state.samples.get(n);
      if (!s || s.deleted) return fail(`Sample ${n} not found.`);
      if (s.rack == null) return fail(`${n} is not currently in a rack.`);
      const from = positionLabel(s.rack, s.row, s.col);
      const rec = put({ ...s, rack: null, row: null, col: null, status: 'retrieved', retrieved_at: now, retrieved_by: user });
      const reason = d.reason ? ` — ${String(d.reason).slice(0, 200)}` : '';
      log(n, 'retrieved', `${from}${reason}`, s.sample_type);
      return done(rec, `${n} retrieved from ${from}.`);
    }

    case 'update': {
      const n = normalizeSampleNumber(d.sample_number);
      const s = state.samples.get(n);
      if (!s || s.deleted) return fail(`Sample ${n} not found.`);
      const next = { ...s };
      const changes = [];
      if (d.sample_type != null && d.sample_type !== s.sample_type) {
        if (!SAMPLE_TYPES[d.sample_type]) return fail('Unknown sample type.');
        if (s.rack != null) return fail(`Retrieve ${n} from its rack before changing its type.`);
        next.sample_type = d.sample_type;
        changes.push(`type → ${SAMPLE_TYPES[d.sample_type].label}`);
      }
      if (d.notes != null && d.notes !== s.notes) {
        next.notes = String(d.notes).slice(0, 500);
        changes.push('notes updated');
      }
      if (!changes.length) return done(s, 'No changes.');
      const rec = put(next);
      log(n, 'edited', changes.join(', '), rec.sample_type);
      return done(rec, `${n} updated.`);
    }

    case 'delete': {
      const n = normalizeSampleNumber(d.sample_number);
      const s = state.samples.get(n);
      if (!s || s.deleted) return fail(`Sample ${n} not found.`);
      const rec = put({ ...s, deleted: true, rack: null, row: null, col: null });
      log(n, 'deleted', s.rack != null ? `Was at ${positionLabel(s.rack, s.row, s.col)}` : '', s.sample_type);
      return done(rec, `${n} deleted.`);
    }

    case 'set_rack_type': {
      const id = +d.rack;
      const rack = state.racks.get(id);
      if (!rack) return fail('Unknown rack.');
      if (!SAMPLE_TYPES[d.sample_type]?.storable) return fail('Only SureSwab, Pap Swab and SST have storage racks.');
      if (rack.sample_type === d.sample_type) return done(null, 'No change.');
      const used = rackOccupancy(state, id);
      if (used > 0) return fail(`Rack ${id} still holds ${used} sample(s). Empty it before changing its type.`);
      const rec = { ...rack, sample_type: d.sample_type, updated_at: now, rev };
      state.racks.set(id, rec);
      changedRacks.push(rec);
      log(null, 'rack_type', `Rack ${id}: ${SAMPLE_TYPES[rack.sample_type].label} → ${SAMPLE_TYPES[d.sample_type].label}`, d.sample_type);
      return done(null, `Rack ${id} is now a ${SAMPLE_TYPES[d.sample_type].label} rack.`);
    }

    default:
      return fail(`Unknown operation "${op.kind}".`);
  }
}

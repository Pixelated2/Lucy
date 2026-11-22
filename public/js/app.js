import { Sync } from './sync.js';
import { scanBarcode } from './scanner.js';
import { h, toast, dialog, scanIcon, fmtTime, localDateKey } from './ui.js';
import {
  RACK_COUNT, ROWS, COLS, SLOTS_PER_RACK, ROW_LABELS, SAMPLE_TYPES, TYPE_KEYS, STORABLE_TYPES,
  STATUS_LABELS, positionLabel,
} from '../shared/constants.js';
import { normalizeSampleNumber, rackOccupancy, slotKey } from '../shared/logic.js';

const sync = new Sync();
const main = document.getElementById('main');
const ui = {
  receiveType: localStorage.getItem('lucy.receiveType') || 'sureswab',
  receiveReceived: true,
  autoStore: true,
  batch: false,
  lastResult: null,
  findQuery: '',
  rackFilter: 'all',
  moving: null, // sample number being moved (pick-a-slot mode)
  logTab: 'samples',
  logFilter: { from: localDateKey(new Date().toISOString()), to: localDateKey(new Date().toISOString()), type: 'all', received: 'all', q: '' },
};

// ---------- shared bits ----------
const typeChip = (type, extra = '') => {
  const t = SAMPLE_TYPES[type];
  if (!t) return h('span', { class: 'chip' }, 'Unknown');
  return h('span', { class: `chip ${extra}`, style: { '--c': t.color, '--ink': t.ink } }, t.label);
};
const statusBadge = (s) => h('span', { class: `badge st-${s.status}` }, STATUS_LABELS[s.status] || s.status);
const scanInto = async (input, after) => {
  const v = await scanBarcode();
  if (v) { input.value = v; input.dispatchEvent(new Event('input')); after?.(v); }
  else input.focus();
};
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };
const sampleOf = (n) => { const s = sync.view.samples.get(normalizeSampleNumber(n)); return s && !s.deleted ? s : null; };

function result(r, { quiet = false } = {}) {
  if (!r.ok) { toast(r.error, 'error', 5000); return false; }
  if (!quiet && r.message) toast(r.message, 'ok');
  return true;
}

function rackGrid(rackId, { highlight = null, onCell, compact = false } = {}) {
  const v = sync.view;
  const rack = v.racks.get(rackId);
  const grid = h('div', { class: `rack-grid${compact ? ' compact' : ''}`, role: 'grid', 'aria-label': `Rack ${rackId}` });
  grid.append(h('div', { class: 'cell head corner' }));
  for (let c = 0; c < COLS; c++) grid.append(h('div', { class: 'cell head' }, c + 1));
  for (let r = 0; r < ROWS; r++) {
    grid.append(h('div', { class: 'cell head' }, ROW_LABELS[r]));
    for (let c = 0; c < COLS; c++) {
      const n = v.slots.get(slotKey(rackId, r, c));
      const s = n ? v.samples.get(n) : null;
      const t = s ? SAMPLE_TYPES[s.sample_type] : null;
      const hl = highlight && highlight.row === r && highlight.col === c;
      const label = `${ROW_LABELS[r]}${c + 1}${n ? `: ${n}` : ': empty'}`;
      const cell = h(onCell ? 'button' : 'div', {
        class: `cell slot${s ? ' full' : ''}${hl ? ' hl' : ''}`,
        style: t ? { '--c': t.color } : null,
        title: label, 'aria-label': label, type: onCell ? 'button' : null,
        onclick: onCell ? () => onCell(r, c, s) : null,
      });
      grid.append(cell);
    }
  }
  grid.style.setProperty('--rack-c', SAMPLE_TYPES[rack?.sample_type]?.color || '#888');
  return grid;
}

function locationBlock(s) {
  if (s.rack != null) {
    return h('div', { class: 'loc' },
      h('div', { class: 'loc-big' }, h('span', {}, 'Rack ', h('b', {}, s.rack)), h('span', {}, 'Row ', h('b', {}, ROW_LABELS[s.row])), h('span', {}, 'Slot ', h('b', {}, s.col + 1))),
      rackGrid(s.rack, { highlight: { row: s.row, col: s.col }, compact: true }));
  }
  const t = SAMPLE_TYPES[s.sample_type];
  const why = !s.received ? 'Not received — no location.'
    : !t?.storable ? `${t?.label || 'This type'} samples are logged only (no storage rack).`
    : s.status === 'retrieved' ? `Retrieved ${fmtTime(s.retrieved_at)} by ${s.retrieved_by || '—'}.`
    : 'Received but not yet placed in a rack.';
  return h('div', { class: 'loc none' }, why);
}

// ---------- Find ----------
function viewFind() {
  const input = h('input', {
    id: 'find-input', class: 'big-input', type: 'search', inputmode: 'text', placeholder: 'Sample number',
    value: ui.findQuery, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Search sample number',
  });
  const out = h('div', { class: 'find-out' });
  const update = () => { ui.findQuery = input.value; out.replaceChildren(findResults(input.value)); };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const s = sampleOf(input.value); if (s) go(`#/sample/${encodeURIComponent(s.sample_number)}`); } });
  update();
  setTimeout(() => input.focus(), 0);
  return [
    h('h1', { class: 'page-title' }, 'Find a sample'),
    h('div', { class: 'search-bar' }, input,
      h('button', { class: 'btn primary icon-text', onclick: () => scanInto(input, () => { const s = sampleOf(input.value); if (s) go(`#/sample/${encodeURIComponent(s.sample_number)}`); }) }, scanIcon(), 'Scan')),
    out,
  ];
}

function findResults(q) {
  const n = normalizeSampleNumber(q);
  if (!n) return dashboard();
  const exact = sampleOf(n);
  const matches = [];
  for (const s of sync.view.samples.values()) {
    if (!s.deleted && s.sample_number !== n && s.sample_number.includes(n)) { matches.push(s); if (matches.length >= 25) break; }
  }
  const frag = h('div', {});
  if (exact) frag.append(sampleCard(exact));
  else frag.append(h('div', { class: 'card empty' }, h('p', {}, h('b', {}, n), ' was not found.'),
    h('button', { class: 'btn', onclick: () => { ui.prefillReceive = n; go('#/receive'); } }, 'Log it on Receive →')));
  if (matches.length) {
    frag.append(h('h3', { class: 'section' }, exact ? 'Similar numbers' : 'Partial matches'),
      h('ul', { class: 'list' }, matches.map(sampleRow)));
  }
  return frag;
}

function sampleRow(s) {
  return h('li', {}, h('a', { class: 'row-link', href: `#/sample/${encodeURIComponent(s.sample_number)}` },
    h('span', { class: 'swatch', style: { background: SAMPLE_TYPES[s.sample_type]?.color } }),
    h('span', { class: 'mono grow' }, s.sample_number),
    h('span', { class: 'muted' }, s.rack != null ? positionLabel(s.rack, s.row, s.col) : STATUS_LABELS[s.status])));
}

function dashboard() {
  const v = sync.view;
  const counts = Object.fromEntries(TYPE_KEYS.map((k) => [k, { stored: 0, total: 0 }]));
  const today = localDateKey(new Date().toISOString());
  let recvToday = 0, notRecvToday = 0;
  for (const s of v.samples.values()) {
    if (s.deleted || !counts[s.sample_type]) continue;
    counts[s.sample_type].total++;
    if (s.rack != null) counts[s.sample_type].stored++;
    const when = s.received_at || s.created_at;
    if (when && localDateKey(when) === today) s.received ? recvToday++ : notRecvToday++;
  }
  const cap = (type) => [...v.racks.values()].filter((r) => r.sample_type === type).length * SLOTS_PER_RACK;
  return h('div', {},
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, recvToday), h('span', {}, 'received today')),
      h('div', { class: 'stat' }, h('b', {}, notRecvToday), h('span', {}, 'not received today'))),
    h('h3', { class: 'section' }, 'Storage'),
    h('div', { class: 'type-summary' }, STORABLE_TYPES.map((k) => {
      const c = cap(k), used = counts[k].stored;
      return h('a', { class: 'card tsum', href: '#/racks', onclick: () => { ui.rackFilter = k; } },
        typeChip(k), h('div', { class: 'meter' }, h('i', { style: { width: `${c ? (used / c) * 100 : 0}%`, background: SAMPLE_TYPES[k].color } })),
        h('span', { class: 'muted' }, `${used} / ${c} slots used`));
    })),
    h('h3', { class: 'section' }, 'Recent activity'),
    activityList(sync.activity().slice(0, 8)));
}

function sampleCard(s) {
  const t = SAMPLE_TYPES[s.sample_type];
  const actions = h('div', { class: 'actions' });
  if (s.rack != null) {
    actions.append(
      h('button', { class: 'btn primary', onclick: () => retrieve(s) }, 'Retrieve'),
      h('button', { class: 'btn', onclick: () => { ui.moving = s.sample_number; go(`#/racks/${s.rack}`); } }, 'Move'));
  } else if (s.received && t?.storable) {
    actions.append(h('button', { class: 'btn primary', onclick: () => result(sync.submit('store', { sample_number: s.sample_number })) },
      s.status === 'retrieved' ? 'Return to rack' : 'Store in rack'));
    actions.append(h('button', { class: 'btn', onclick: () => { ui.moving = s.sample_number; go('#/racks'); } }, 'Choose slot'));
  } else if (!s.received) {
    actions.append(h('button', { class: 'btn primary', onclick: () => result(sync.submit('receive', { sample_number: s.sample_number, sample_type: s.sample_type, received: true })) }, 'Mark received'));
  }
  actions.append(
    h('button', { class: 'btn ghost', onclick: () => editSample(s) }, 'Edit'),
    h('button', { class: 'btn ghost danger-text', onclick: () => deleteSample(s) }, 'Delete'));

  return h('article', { class: 'card sample', style: { '--c': t?.color || '#888' } },
    h('header', { class: 'sample-head' },
      h('div', {}, h('div', { class: 'mono sample-num' }, s.sample_number), h('div', { class: 'chips' }, typeChip(s.sample_type), statusBadge(s))),
      h('a', { class: 'btn ghost small', href: `#/sample/${encodeURIComponent(s.sample_number)}` }, 'Details')),
    locationBlock(s),
    h('dl', { class: 'meta' },
      h('dt', {}, 'Received'), h('dd', {}, s.received ? `${fmtTime(s.received_at)} · ${s.received_by || '—'}` : 'No'),
      s.stored_at ? [h('dt', {}, 'Stored'), h('dd', {}, `${fmtTime(s.stored_at)} · ${s.stored_by || '—'}`)] : null,
      s.notes ? [h('dt', {}, 'Notes'), h('dd', {}, s.notes)] : null),
    actions);
}

async function retrieve(s) {
  const v = await dialog({
    title: `Retrieve ${s.sample_number}`,
    message: `Remove from ${positionLabel(s.rack, s.row, s.col)}. The slot becomes free.`,
    fields: [{ name: 'reason', label: 'Reason (optional)', placeholder: 'e.g. add-on test, discard' }],
    confirm: 'Retrieve',
  });
  if (v) result(sync.submit('retrieve', { sample_number: s.sample_number, reason: v.reason }));
}

async function editSample(s) {
  const v = await dialog({
    title: `Edit ${s.sample_number}`,
    fields: [
      { name: 'sample_type', label: 'Sample type', type: 'select', value: s.sample_type, options: TYPE_KEYS.map((k) => [k, `${SAMPLE_TYPES[k].label} (${SAMPLE_TYPES[k].colorName})`]) },
      { name: 'notes', label: 'Notes', type: 'textarea', value: s.notes || '' },
    ],
    confirm: 'Save',
  });
  if (v) result(sync.submit('update', { sample_number: s.sample_number, sample_type: v.sample_type, notes: v.notes }));
}

async function deleteSample(s) {
  const v = await dialog({ title: `Delete ${s.sample_number}?`, message: 'This removes the sample record for everyone and frees its slot. Use Retrieve for normal removals.', confirm: 'Delete', danger: true });
  if (v && result(sync.submit('delete', { sample_number: s.sample_number }))) go('#/find');
}

function viewSample(n) {
  const s = sampleOf(n);
  if (!s) return [h('h1', { class: 'page-title' }, 'Not found'), h('p', {}, `Sample ${n} does not exist.`), h('a', { class: 'btn', href: '#/find' }, '← Back to Find')];
  const hist = h('div', {}, activityList(sync.activity().filter((e) => e.sample_number === s.sample_number)));
  sync.history(s.sample_number).then((events) => {
    if (events?.length) hist.replaceChildren(activityList([...events].reverse()));
  });
  return [
    h('a', { class: 'back', href: '#/find' }, '← Find'),
    sampleCard(s),
    h('h3', { class: 'section' }, 'History'),
    hist,
  ];
}

// ---------- Receive ----------
function viewReceive() {
  const type = ui.receiveType;
  const t = SAMPLE_TYPES[type];
  const input = h('input', {
    id: 'receive-input', class: 'big-input', type: 'text', placeholder: 'Scan or type sample number', value: ui.prefillReceive || '',
    autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Sample number',
  });
  ui.prefillReceive = '';
  const notes = h('input', { type: 'text', placeholder: 'Notes (optional)', 'aria-label': 'Notes' });

  const submit = () => {
    const n = normalizeSampleNumber(input.value);
    if (!n) { toast('Scan or enter a sample number.', 'error'); input.focus(); return false; }
    const r = sync.submit('receive', { sample_number: n, sample_type: ui.receiveType, received: ui.receiveReceived, notes: notes.value || undefined });
    if (!result(r, { quiet: true })) return false;
    let msg = r.message, stored = null;
    const willStore = ui.receiveReceived && ui.autoStore && t.storable;
    if (willStore) {
      const s = sampleOf(n);
      if (s.rack == null) {
        const r2 = sync.submit('store', { sample_number: n });
        if (!result(r2, { quiet: true })) msg += ' Not placed in a rack.';
        else { stored = sampleOf(n); msg = r2.message; }
      } else stored = s;
    }
    ui.lastResult = { n, msg, stored: stored ? { rack: stored.rack, row: stored.row, col: stored.col } : null, type: ui.receiveType, received: ui.receiveReceived };
    if (navigator.vibrate) navigator.vibrate(40);
    render();
    return true;
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  setTimeout(() => input.focus(), 0);

  const scanFlow = async () => {
    const v = await scanBarcode({ title: `Scan ${t.label}` });
    if (!v) return;
    const inp = document.getElementById('receive-input');
    if (inp) inp.value = v;
    const ok = (() => { input.value = v; return submit(); })();
    if (ok && ui.batch) setTimeout(scanFlow, 700);
  };

  const typePicker = h('div', { class: 'type-picker', role: 'radiogroup', 'aria-label': 'Sample type' }, TYPE_KEYS.map((k) => {
    const tt = SAMPLE_TYPES[k];
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(k === type), class: `type-btn${k === type ? ' on' : ''}`,
      style: { '--c': tt.color, '--ink': tt.ink },
      onclick: () => { ui.receiveType = k; localStorage.setItem('lucy.receiveType', k); render(); },
    }, h('b', {}, tt.label), h('small', {}, `${tt.colorName}${tt.storable ? ' · racked' : ' · log only'}`));
  }));

  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Received status' },
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(ui.receiveReceived), class: ui.receiveReceived ? 'on ok' : '', onclick: () => { ui.receiveReceived = true; render(); } }, '✓ Received'),
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(!ui.receiveReceived), class: !ui.receiveReceived ? 'on bad' : '', onclick: () => { ui.receiveReceived = false; render(); } }, '✗ Not received'));

  const lr = ui.lastResult;
  const last = lr ? h('div', { class: `card result ${lr.received ? '' : 'neg'}`, style: { '--c': SAMPLE_TYPES[lr.type].color } },
    h('div', { class: 'result-head' }, h('span', { class: 'mono sample-num' }, lr.n), typeChip(lr.type)),
    lr.stored ? h('div', { class: 'place' }, 'Place in ', h('b', {}, `Rack ${lr.stored.rack}`), ' · Row ', h('b', {}, ROW_LABELS[lr.stored.row]), ' · Slot ', h('b', {}, lr.stored.col + 1)) : h('p', {}, lr.msg),
    lr.stored ? rackGrid(lr.stored.rack, { highlight: lr.stored, compact: true }) : null) : null;

  return [
    h('h1', { class: 'page-title' }, 'Receive samples'),
    h('div', { class: 'card' },
      h('h3', { class: 'label' }, '1 · Sample type'), typePicker,
      h('h3', { class: 'label' }, '2 · Status'), seg,
      h('h3', { class: 'label' }, '3 · Sample number'),
      h('div', { class: 'search-bar' }, input, h('button', { class: 'btn icon-text', type: 'button', onclick: scanFlow }, scanIcon(), 'Scan')),
      notes,
      h('div', { class: 'opts' },
        t.storable && ui.receiveReceived ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.autoStore, onchange: (e) => { ui.autoStore = e.target.checked; } }), `Assign a ${t.label} rack slot`) : null,
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ui.batch, onchange: (e) => { ui.batch = e.target.checked; } }), 'Keep camera scanning')),
      h('button', { class: 'btn primary wide', style: { '--c': t.color }, onclick: submit }, ui.receiveReceived ? `Log ${t.label} as received` : `Log ${t.label} as NOT received`)),
    last,
    h('h3', { class: 'section' }, 'Logged today'),
    todayLog(),
  ];
}

function todayLog() {
  const today = localDateKey(new Date().toISOString());
  const rows = [...sync.view.samples.values()]
    .filter((s) => !s.deleted && localDateKey(s.received_at || s.updated_at) === today)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing logged yet today.');
  const by = Object.fromEntries(TYPE_KEYS.map((k) => [k, { y: 0, n: 0 }]));
  for (const s of rows) if (by[s.sample_type]) s.received ? by[s.sample_type].y++ : by[s.sample_type].n++;
  return h('div', {},
    h('div', { class: 'tally' }, TYPE_KEYS.filter((k) => by[k].y || by[k].n).map((k) =>
      h('span', { class: 'tally-item' }, typeChip(k), ` ${by[k].y} received`, by[k].n ? h('span', { class: 'bad-text' }, ` · ${by[k].n} not`) : null))),
    h('ul', { class: 'list' }, rows.slice(0, 50).map(sampleRow)),
    rows.length > 50 ? h('a', { href: '#/log', class: 'muted' }, `View all ${rows.length} in Log →`) : null);
}

// ---------- Racks ----------
function viewRacks() {
  const v = sync.view;
  const moving = ui.moving ? sampleOf(ui.moving) : null;
  const filter = moving ? moving.sample_type : ui.rackFilter;
  const racks = [...v.racks.values()].sort((a, b) => a.id - b.id).filter((r) => filter === 'all' || r.sample_type === filter);
  return [
    h('h1', { class: 'page-title' }, 'Racks'),
    moveBanner(moving),
    moving ? null : h('div', { class: 'filters' },
      [['all', 'All racks'], ...STORABLE_TYPES.map((k) => [k, SAMPLE_TYPES[k].label])].map(([k, l]) =>
        h('button', { class: `pill${ui.rackFilter === k ? ' on' : ''}`, style: k !== 'all' ? { '--c': SAMPLE_TYPES[k].color } : null, onclick: () => { ui.rackFilter = k; render(); } }, l))),
    h('div', { class: 'rack-cards' }, racks.map((r) => {
      const used = rackOccupancy(v, r.id);
      const t = SAMPLE_TYPES[r.sample_type];
      return h('a', { class: 'card rack-card', href: `#/racks/${r.id}`, style: { '--c': t.color } },
        h('div', { class: 'rack-no' }, h('small', {}, 'Rack'), h('b', {}, r.id)),
        h('div', { class: 'grow' }, typeChip(r.sample_type),
          h('div', { class: 'meter' }, h('i', { style: { width: `${(used / SLOTS_PER_RACK) * 100}%`, background: t.color } })),
          h('span', { class: 'muted' }, used === SLOTS_PER_RACK ? 'Full' : `${used} / ${SLOTS_PER_RACK} used · ${SLOTS_PER_RACK - used} free`)));
    })),
  ];
}

function moveBanner(moving) {
  if (!moving) return null;
  return h('div', { class: 'banner' }, h('span', {}, 'Choose an empty slot for ', h('b', { class: 'mono' }, moving.sample_number), ` (${SAMPLE_TYPES[moving.sample_type].label})`),
    h('button', { class: 'btn ghost small', onclick: () => { ui.moving = null; render(); } }, 'Cancel'));
}

function viewRack(id) {
  const v = sync.view;
  const rack = v.racks.get(id);
  if (!rack) return [h('p', {}, 'Unknown rack.'), h('a', { href: '#/racks' }, '← Racks')];
  const t = SAMPLE_TYPES[rack.sample_type];
  const used = rackOccupancy(v, id);
  const moving = ui.moving ? sampleOf(ui.moving) : null;

  const onCell = async (row, col, s) => {
    if (s) {
      if (moving && s.sample_number !== moving.sample_number) { toast(`${ROW_LABELS[row]}${col + 1} holds ${s.sample_number}. Pick an empty slot.`, 'error'); return; }
      if (!moving) go(`#/sample/${encodeURIComponent(s.sample_number)}`);
      return;
    }
    if (moving) {
      if (result(sync.submit('store', { sample_number: moving.sample_number, rack: id, row, col }))) {
        const n = moving.sample_number; ui.moving = null; go(`#/sample/${encodeURIComponent(n)}`);
      }
      return;
    }
    const vals = await dialog({
      title: `Store in Rack ${id} · ${ROW_LABELS[row]}${col + 1}`,
      message: `${t.label} rack. The sample must already be logged as received.`,
      fields: [{ name: 'n', label: 'Sample number', placeholder: 'Scan or type', scan: true, caps: true }],
      confirm: 'Store here', onScan: () => scanBarcode(),
    });
    if (vals?.n) result(sync.submit('store', { sample_number: vals.n, rack: id, row, col }));
  };

  const list = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const n = v.slots.get(slotKey(id, r, c));
    if (n) list.push(h('li', {}, h('a', { class: 'row-link', href: `#/sample/${encodeURIComponent(n)}` }, h('span', { class: 'pos mono' }, `${ROW_LABELS[r]}${c + 1}`), h('span', { class: 'mono grow' }, n))));
  }
  return [
    h('a', { class: 'back', href: '#/racks' }, '← All racks'),
    moveBanner(moving),
    h('div', { class: 'rack-title', style: { '--c': t.color } },
      h('h1', { class: 'page-title' }, `Rack ${id}`), typeChip(rack.sample_type), h('span', { class: 'muted' }, `${used} / ${SLOTS_PER_RACK} used`),
      h('span', { class: 'spacer' }),
      h('a', { class: 'btn ghost small', href: `#/racks/${id > 1 ? id - 1 : RACK_COUNT}`, 'aria-label': 'Previous rack' }, '‹'),
      h('a', { class: 'btn ghost small', href: `#/racks/${id < RACK_COUNT ? id + 1 : 1}`, 'aria-label': 'Next rack' }, '›')),
    h('p', { class: 'muted hint' }, moving ? 'Tap an empty slot to move the sample there.' : 'Tap a filled slot to see the sample, or an empty slot to store one there. Rows A–I × slots 1–12.'),
    h('div', { class: 'grid-wrap' }, rackGrid(id, { onCell })),
    h('h3', { class: 'section' }, 'Contents'),
    list.length ? h('ul', { class: 'list cols' }, list) : h('p', { class: 'muted' }, 'This rack is empty.'),
  ];
}

// ---------- Log ----------
function viewLog() {
  const tabs = h('div', { class: 'filters' },
    h('button', { class: `pill${ui.logTab === 'samples' ? ' on' : ''}`, onclick: () => { ui.logTab = 'samples'; render(); } }, 'Receiving log'),
    h('button', { class: `pill${ui.logTab === 'activity' ? ' on' : ''}`, onclick: () => { ui.logTab = 'activity'; render(); } }, 'Activity'));
  return [h('h1', { class: 'page-title' }, 'Log'), tabs, ui.logTab === 'samples' ? receivingLog() : activityView()];
}

function filteredSamples() {
  const f = ui.logFilter;
  const q = normalizeSampleNumber(f.q);
  return [...sync.view.samples.values()].filter((s) => {
    if (s.deleted) return false;
    const day = localDateKey(s.received_at || s.created_at || s.updated_at);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (f.type !== 'all' && s.sample_type !== f.type) return false;
    if (f.received === 'yes' && !s.received) return false;
    if (f.received === 'no' && s.received) return false;
    if (q && !s.sample_number.includes(q)) return false;
    return true;
  }).sort((a, b) => (b.received_at || b.created_at || '').localeCompare(a.received_at || a.created_at || ''));
}

function receivingLog() {
  const f = ui.logFilter;
  const set = (k) => (e) => { f[k] = e.target.value; refresh(); };
  const body = h('div', {});
  const refresh = () => {
    const rows = filteredSamples();
    const yes = rows.filter((s) => s.received).length;
    body.replaceChildren(
      h('p', { class: 'muted' }, `${rows.length} sample(s) · ${yes} received · ${rows.length - yes} not received`),
      rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Sample #', 'Type', 'Received', 'Location / status', 'Logged', 'By'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.slice(0, 500).map((s) => h('tr', { onclick: () => go(`#/sample/${encodeURIComponent(s.sample_number)}`) },
          h('td', { class: 'mono' }, s.sample_number), h('td', {}, typeChip(s.sample_type)),
          h('td', {}, s.received ? h('span', { class: 'ok-text' }, '✓ Yes') : h('span', { class: 'bad-text' }, '✗ No')),
          h('td', {}, s.rack != null ? positionLabel(s.rack, s.row, s.col) : STATUS_LABELS[s.status]),
          h('td', {}, fmtTime(s.received_at || s.created_at)), h('td', {}, s.received_by || '—')))))) : h('p', {}, 'No samples match.'),
      rows.length > 500 ? h('p', { class: 'muted' }, 'Showing first 500. Export CSV for all.') : null);
  };
  refresh();
  return h('div', {},
    h('div', { class: 'card filter-bar' },
      h('label', {}, 'From', h('input', { type: 'date', value: f.from, onchange: set('from') })),
      h('label', {}, 'To', h('input', { type: 'date', value: f.to, onchange: set('to') })),
      h('label', {}, 'Type', h('select', { onchange: set('type') }, [['all', 'All types'], ...TYPE_KEYS.map((k) => [k, SAMPLE_TYPES[k].label])].map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)))),
      h('label', {}, 'Received', h('select', { onchange: set('received') }, [['all', 'All'], ['yes', 'Received'], ['no', 'Not received']].map(([v, l]) => h('option', { value: v, selected: f.received === v }, l)))),
      h('label', {}, 'Search', h('input', { type: 'search', value: f.q, placeholder: 'Sample #', oninput: set('q') })),
      h('div', { class: 'filter-actions' },
        h('button', { class: 'btn ghost small', onclick: () => { f.from = ''; f.to = ''; render(); } }, 'All dates'),
        h('button', { class: 'btn small', onclick: exportCsv }, 'Export CSV'))),
    body);
}

function exportCsv() {
  const rows = filteredSamples();
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = ['sample_number', 'sample_type', 'tube_color', 'received', 'status', 'rack', 'row', 'slot', 'received_at', 'received_by', 'stored_at', 'stored_by', 'retrieved_at', 'retrieved_by', 'notes'];
  const lines = [header.join(',')].concat(rows.map((s) => [
    s.sample_number, SAMPLE_TYPES[s.sample_type]?.label, SAMPLE_TYPES[s.sample_type]?.colorName, s.received ? 'yes' : 'no', s.status,
    s.rack ?? '', s.row != null ? ROW_LABELS[s.row] : '', s.col != null ? s.col + 1 : '',
    s.received_at, s.received_by, s.stored_at, s.stored_by, s.retrieved_at, s.retrieved_by, s.notes,
  ].map(esc).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `lucy-locates-${localDateKey(new Date().toISOString())}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const ACTION_LABELS = { received: 'Received', not_received: 'Not received', stored: 'Stored', moved: 'Moved', retrieved: 'Retrieved', removed: 'Removed', edited: 'Edited', deleted: 'Deleted', rack_type: 'Rack changed', conflict: 'Slot conflict' };

function activityList(events) {
  if (!events.length) return h('p', { class: 'muted' }, 'No activity yet.');
  return h('ul', { class: 'list activity' }, events.map((e) => h('li', { class: e.pending ? 'pending' : '' },
    h('span', { class: `act act-${e.action}` }, ACTION_LABELS[e.action] || e.action),
    e.sample_number ? h('a', { class: 'mono', href: `#/sample/${encodeURIComponent(e.sample_number)}` }, e.sample_number) : null,
    h('span', { class: 'grow muted detail' }, e.detail || ''),
    h('span', { class: 'muted when' }, `${fmtTime(e.at)} · ${e.user || '—'}${e.pending ? ' · not synced' : ''}`))));
}

function activityView() {
  return activityList(sync.activity().slice(0, 300));
}

// ---------- Settings ----------
function viewSettings() {
  const s = sync.settings;
  const name = h('input', { type: 'text', value: s.user, placeholder: 'Your name or initials', 'aria-label': 'Your name' });
  const server = h('input', { type: 'url', value: s.serverUrl, placeholder: `Default: ${location.origin}`, 'aria-label': 'Sync server address' });
  const code = h('input', { type: 'password', value: s.accessCode, placeholder: 'Only if your lab set one', 'aria-label': 'Access code', autocomplete: 'off' });
  const v = sync.view;
  const st = { idle: 'Synced', syncing: 'Syncing…', offline: 'Offline — changes are saved on this device', error: `Sync error: ${sync.lastError}`, unauthorized: 'Access code needed' }[sync.status];

  return [
    h('h1', { class: 'page-title' }, 'Settings'),
    h('section', { class: 'card' },
      h('h2', {}, 'You'),
      h('label', { class: 'field' }, h('span', {}, 'Name shown on everything you log'), name),
      h('button', { class: 'btn primary', onclick: async () => { await sync.saveSettings({ user: name.value.trim() }); toast('Saved', 'ok'); render(); } }, 'Save name')),
    h('section', { class: 'card' },
      h('h2', {}, 'Sync'),
      h('p', {}, h('b', {}, st), sync.lastSyncAt ? h('span', { class: 'muted' }, ` · last synced ${fmtTime(sync.lastSyncAt)}`) : null),
      h('p', { class: 'muted' }, `${sync.outbox.length} change(s) waiting to upload · database revision ${sync.rev}`),
      h('label', { class: 'field' }, h('span', {}, 'Sync server address'), server),
      h('label', { class: 'field' }, h('span', {}, 'Lab access code'), code),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => { await sync.saveSettings({ serverUrl: server.value.trim(), accessCode: code.value }); toast('Sync settings saved', 'ok'); } }, 'Save & connect'),
        h('button', { class: 'btn', onclick: () => sync.syncNow() }, 'Sync now'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Rack assignments'),
      h('p', { class: 'muted' }, 'Each of the 20 racks (9 rows × 12 slots = 108) holds one sample type. A rack must be empty before its type can change. ThinPrep, CBC and Urine are logged only.'),
      h('div', { class: 'rack-assign' }, [...v.racks.values()].sort((a, b) => a.id - b.id).map((r) => {
        const used = rackOccupancy(v, r.id);
        return h('label', { class: 'ra', style: { '--c': SAMPLE_TYPES[r.sample_type].color } },
          h('span', {}, `Rack ${r.id}`),
          h('select', { disabled: used > 0, title: used > 0 ? `${used} sample(s) in rack` : '', onchange: (e) => { if (!result(sync.submit('set_rack_type', { rack: r.id, sample_type: e.target.value }))) render(); } },
            STORABLE_TYPES.map((k) => h('option', { value: k, selected: r.sample_type === k }, SAMPLE_TYPES[k].label))),
          used ? h('small', { class: 'muted' }, `${used} in use`) : null);
      }))),
    h('section', { class: 'card' },
      h('h2', {}, 'Install on your device'),
      h('ul', { class: 'install' },
        h('li', {}, h('b', {}, 'Android: '), 'open in Chrome → menu ⋮ → ', h('i', {}, 'Install app'), '.'),
        h('li', {}, h('b', {}, 'iPhone / iPad: '), 'open in Safari → Share → ', h('i', {}, 'Add to Home Screen'), '.'),
        h('li', {}, h('b', {}, 'Windows: '), 'open in Edge or Chrome → install icon in the address bar.'),
        h('li', {}, h('b', {}, 'Chromebook: '), 'open in Chrome → install icon in the address bar.')),
      installButton()),
    h('p', { class: 'muted center' }, 'Lucy Locates v1.0'),
  ];
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
function installButton() {
  if (!deferredInstall) return null;
  return h('button', { class: 'btn primary', onclick: async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); } }, 'Install Lucy Locates');
}

// ---------- shell ----------
function conflictsBanner() {
  if (!sync.conflicts.length) return null;
  return h('div', { class: 'conflicts' }, sync.conflicts.map((c, i) => h('div', { class: 'banner warn', role: 'alert' },
    h('span', {}, '⚠ ', c.message),
    h('button', { class: 'btn small', onclick: () => sync.dismissConflict(i) }, 'Done'))));
}

const ROUTES = [
  [/^#\/find$/, viewFind, 'find'],
  [/^#\/sample\/(.+)$/, (m) => viewSample(decodeURIComponent(m[1])), 'find'],
  [/^#\/receive$/, viewReceive, 'receive'],
  [/^#\/racks$/, viewRacks, 'racks'],
  [/^#\/racks\/(\d+)$/, (m) => viewRack(+m[1]), 'racks'],
  [/^#\/log$/, viewLog, 'log'],
  [/^#\/settings$/, viewSettings, 'settings'],
];

let lastHash = '';
function render() {
  const hash = location.hash || '#/find';
  let route = ROUTES.find(([re]) => re.test(hash));
  if (!route) { location.hash = '#/find'; return; }
  const m = hash.match(route[0]);
  const active = document.activeElement;
  const keepFocus = hash === lastHash && active && active.id && main.contains(active) ? { id: active.id, pos: active.selectionStart } : null;
  const scroll = hash === lastHash ? window.scrollY : 0;
  main.replaceChildren(conflictsBanner() || '', ...[route[1](m)].flat().filter(Boolean));
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('on', a.dataset.tab === route[2]);
  if (keepFocus) { const el = document.getElementById(keepFocus.id); if (el) { el.focus(); try { el.setSelectionRange(keepFocus.pos, keepFocus.pos); } catch { /* n/a */ } } }
  window.scrollTo(0, scroll);
  lastHash = hash;
}

function renderStatus() {
  const pill = document.getElementById('sync-pill');
  const n = sync.outbox.length;
  const map = {
    idle: ['ok', 'Synced'], syncing: ['busy', n ? `Syncing ${n}` : 'Syncing'],
    offline: ['off', n ? `Offline · ${n} pending` : 'Offline'], error: ['bad', 'Sync error'], unauthorized: ['bad', 'Access code'],
  };
  const [cls, text] = map[sync.status] || map.idle;
  pill.className = `sync-pill ${cls}`;
  pill.textContent = text;
  pill.title = sync.lastError || (sync.lastSyncAt ? `Last synced ${fmtTime(sync.lastSyncAt)}` : '');
  document.getElementById('user-btn').textContent = sync.settings.user || 'Set name';
}

// Re-render on remote changes, but never while the user is typing in a dialog.
let pending = 0;
function scheduleRender() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => { if (!document.querySelector('dialog[open], .scanner')) render(); renderStatus(); });
}

async function askName() {
  const v = await dialog({ title: 'Welcome to Lucy Locates', message: 'Enter your name or initials. It is recorded with every sample you log.', fields: [{ name: 'user', label: 'Name or initials', value: sync.settings.user }], confirm: 'Continue', cancel: null });
  if (v?.user?.trim()) { await sync.saveSettings({ user: v.user.trim() }); renderStatus(); }
  else return askName();
}

async function boot() {
  await sync.init();
  sync.addEventListener('change', scheduleRender);
  sync.addEventListener('status', renderStatus);
  sync.addEventListener('notice', (e) => toast(e.detail.message, e.detail.level, 7000));
  sync.addEventListener('conflict', (e) => { toast(e.detail.message, 'error', 10000); scheduleRender(); });
  window.addEventListener('hashchange', () => { render(); });
  document.getElementById('sync-pill').onclick = () => go('#/settings');
  document.getElementById('user-btn').onclick = () => go('#/settings');
  render();
  renderStatus();
  sync.start();
  if (!sync.settings.user) askName();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();

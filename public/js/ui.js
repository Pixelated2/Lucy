// Small DOM helpers: element builder, toasts, dialogs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(message, level = 'info', ms = 3500) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/**
 * Modal form. fields: [{ name, label, type, value, options:[[v,label]], placeholder, scan }]
 * Resolves with values object, or null on cancel.
 */
export function dialog({ title, message, fields = [], confirm = 'OK', cancel = 'Cancel', danger = false, onScan }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dlg' });
    const form = h('form', { method: 'dialog' });
    const inputs = {};
    form.append(h('h2', {}, title));
    if (message) form.append(typeof message === 'string' ? h('p', { class: 'muted' }, message) : message);
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { name: f.name, rows: 3, placeholder: f.placeholder || '' }, f.value || '');
      } else {
        input = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: 'off', autocapitalize: f.caps ? 'characters' : 'off', spellcheck: 'false' });
      }
      inputs[f.name] = input;
      const row = h('div', { class: 'field-row' }, input);
      if (f.scan && onScan) {
        row.append(h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Scan barcode', onclick: async () => { const v = await onScan(); if (v) { input.value = v; input.focus(); } } }, scanIcon()));
      }
      form.append(h('label', { class: 'field' }, h('span', {}, f.label), row));
    }
    const actions = h('div', { class: 'dlg-actions' },
      cancel ? h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, cancel) : null,
      h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, confirm));
    form.append(actions);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.value;
      close(out);
    });
    dlg.append(form);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    let closed = false;
    function close(v) { if (closed) return; closed = true; dlg.close(); dlg.remove(); resolve(v); }
    document.body.append(dlg);
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export function scanIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M16 8v8"/>';
  return s;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function localDateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

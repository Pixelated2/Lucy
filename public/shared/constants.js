// Shared by the browser app and the sync server.

export const RACK_COUNT = 20;
export const ROWS = 9;   // width: 9 spaces  (rows A–I)
export const COLS = 12;  // length: 12 spaces (columns 1–12)
export const SLOTS_PER_RACK = ROWS * COLS; // 108

export const ROW_LABELS = 'ABCDEFGHI'.split('');

// `storable` = has its own dedicated storage racks.
export const SAMPLE_TYPES = {
  sureswab: { label: 'SureSwab',  color: '#F28C28', ink: '#1b1b1b', colorName: 'Orange', storable: true },
  pap:      { label: 'Pap Swab',  color: '#2E9E4F', ink: '#ffffff', colorName: 'Green',  storable: true },
  sst:      { label: 'SST',       color: '#D62828', ink: '#ffffff', colorName: 'Red',    storable: true },
  thinprep: { label: 'ThinPrep',  color: '#EC6FA8', ink: '#1b1b1b', colorName: 'Pink',   storable: false },
  cbc:      { label: 'CBC',       color: '#7B3FB5', ink: '#ffffff', colorName: 'Purple', storable: false },
  urine:    { label: 'Urine',     color: '#F2C500', ink: '#1b1b1b', colorName: 'Yellow', storable: false },
};

export const TYPE_KEYS = Object.keys(SAMPLE_TYPES);
export const STORABLE_TYPES = TYPE_KEYS.filter((k) => SAMPLE_TYPES[k].storable);

// Default rack assignment: 1–7 SureSwab, 8–14 Pap Swab, 15–20 SST (changeable in Settings).
export function defaultRackType(rackId) {
  if (rackId <= 7) return 'sureswab';
  if (rackId <= 14) return 'pap';
  return 'sst';
}

export const STATUS_LABELS = {
  not_received: 'Not received',
  received: 'Received — not in a rack',
  stored: 'Stored',
  retrieved: 'Retrieved / removed',
};

export function positionLabel(rack, row, col) {
  if (rack == null) return '—';
  return `Rack ${rack} · ${ROW_LABELS[row]}${col + 1}`;
}

export function positionCode(rack, row, col) {
  if (rack == null) return '';
  return `R${String(rack).padStart(2, '0')}-${ROW_LABELS[row]}${String(col + 1).padStart(2, '0')}`;
}

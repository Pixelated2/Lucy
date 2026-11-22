import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RACK_COUNT, defaultRackType } from '../public/shared/constants.js';

const SAMPLE_COLS = [
  'sample_number', 'sample_type', 'received', 'status', 'rack', 'row', 'col',
  'received_at', 'received_by', 'stored_at', 'stored_by', 'retrieved_at', 'retrieved_by',
  'notes', 'created_at', 'updated_at', 'rev', 'deleted',
];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS racks (
      id INTEGER PRIMARY KEY, sample_type TEXT NOT NULL, updated_at TEXT, rev INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS samples (
      sample_number TEXT PRIMARY KEY, sample_type TEXT, received INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, rack INTEGER, row INTEGER, col INTEGER,
      received_at TEXT, received_by TEXT, stored_at TEXT, stored_by TEXT,
      retrieved_at TEXT, retrieved_by TEXT, notes TEXT,
      created_at TEXT, updated_at TEXT, rev INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS samples_slot ON samples(rack, row, col) WHERE rack IS NOT NULL AND deleted = 0;
    CREATE INDEX IF NOT EXISTS samples_rev ON samples(rev);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT, sample_number TEXT, sample_type TEXT,
      action TEXT NOT NULL, detail TEXT, user TEXT, device TEXT, at TEXT NOT NULL, rev INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_rev ON events(rev);
    CREATE INDEX IF NOT EXISTS events_sample ON events(sample_number);
    CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, result TEXT NOT NULL, at TEXT NOT NULL);
  `);
  const insRack = db.prepare('INSERT OR IGNORE INTO racks (id, sample_type, rev) VALUES (?, ?, 0)');
  for (let id = 1; id <= RACK_COUNT; id++) insRack.run(id, defaultRackType(id));

  const upsertSample = db.prepare(`
    INSERT INTO samples (${SAMPLE_COLS.join(',')}) VALUES (${SAMPLE_COLS.map(() => '?').join(',')})
    ON CONFLICT(sample_number) DO UPDATE SET ${SAMPLE_COLS.slice(1).map((c) => `${c}=excluded.${c}`).join(',')}`);
  const upsertRack = db.prepare('UPDATE racks SET sample_type = ?, updated_at = ?, rev = ? WHERE id = ?');
  const insEvent = db.prepare(`INSERT INTO events (op_id, sample_number, sample_type, action, detail, user, device, at, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getOp = db.prepare('SELECT result FROM ops WHERE op_id = ?');
  const insOp = db.prepare('INSERT INTO ops (op_id, result, at) VALUES (?, ?, ?)');
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  const toRow = (s) => SAMPLE_COLS.map((c) => {
    const v = s[c];
    if (c === 'received' || c === 'deleted') return v ? 1 : 0;
    return v === undefined ? null : v;
  });

  return {
    raw: db,
    getRev: () => Number(getMeta.get('rev')?.value || 0),
    setRev: (rev) => setMeta.run('rev', String(rev)),
    allSamples: () => db.prepare('SELECT * FROM samples').all(),
    allRacks: () => db.prepare('SELECT * FROM racks ORDER BY id').all(),
    samplesSince: (rev) => db.prepare('SELECT * FROM samples WHERE rev > ?').all(rev),
    racksSince: (rev) => db.prepare('SELECT * FROM racks WHERE rev > ? ORDER BY id').all(rev),
    eventsSince: (rev, limit) => db.prepare('SELECT * FROM (SELECT * FROM events WHERE rev > ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(rev, limit),
    eventsForSample: (n) => db.prepare('SELECT * FROM events WHERE sample_number = ? ORDER BY id').all(n),
    getOpResult: (id) => { const r = getOp.get(id); return r ? JSON.parse(r.result) : null; },
    persist({ samples, racks, events, opId, result, rev, at }) {
      for (const s of samples) upsertSample.run(...toRow(s));
      for (const r of racks) upsertRack.run(r.sample_type, r.updated_at, r.rev, r.id);
      for (const e of events) insEvent.run(e.op_id, e.sample_number, e.sample_type, e.action, e.detail, e.user, e.device, e.at, e.rev);
      if (opId) insOp.run(opId, JSON.stringify(result), at);
      setMeta.run('rev', String(rev));
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}

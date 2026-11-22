// Usage: node backup-snapshot.mjs <live.db> <snapshot.db>
// Takes a consistent copy while the app keeps running, then verifies it.
import { DatabaseSync } from 'node:sqlite';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: backup-snapshot.mjs <live.db> <snapshot.db>'); process.exit(2); }

const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
db.close();

const copy = new DatabaseSync(out, { readOnly: true });
const check = Object.values(copy.prepare('PRAGMA integrity_check').get())[0];
if (check !== 'ok') { console.error(`Backup failed integrity check: ${check}`); process.exit(1); }
const { n } = copy.prepare('SELECT COUNT(*) AS n FROM samples').get();
copy.close();
console.log(`Snapshot holds ${n} sample record(s)`);

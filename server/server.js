// Lucy Locates sync server: serves the app and keeps every device's database in sync.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { loadState, applyOp } from '../public/shared/logic.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const VENDOR = { '/vendor/zxing.min.js': join(ROOT, 'node_modules/@zxing/library/umd/index.min.js') };
const MAX_BODY = 2 * 1024 * 1024;
const MAX_OPS_PER_BATCH = 500;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export function createServer({ dbFile, accessCode = '' } = {}) {
  const db = openDb(dbFile);
  let state = loadState(db.allSamples(), db.allRacks());
  let rev = db.getRev();
  const streams = new Set();

  const codeOk = (given) => {
    if (!accessCode) return true;
    const a = Buffer.from(String(given || '')), b = Buffer.from(accessCode);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((ok, bad) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { bad(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { bad(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', bad);
  });

  const broadcast = () => {
    const msg = `event: rev\ndata: ${JSON.stringify({ rev })}\n\n`;
    for (const res of streams) res.write(msg);
  };

  function processOp(op) {
    if (!op || typeof op !== 'object' || typeof op.op_id !== 'string' || !op.op_id || op.op_id.length > 100) {
      return { op_id: op?.op_id ?? null, ok: false, error: 'Malformed operation.' };
    }
    const prior = db.getOpResult(op.op_id);
    if (prior) return { ...prior, duplicate: true };

    const now = new Date().toISOString();
    const nextRev = rev + 1;
    const r = applyOp(state, op, { now, rev: nextRev });
    const result = {
      op_id: op.op_id, ok: r.ok, error: r.error, message: r.message, conflict: r.conflict || null,
      sample: r.sample ? { sample_number: r.sample.sample_number, rack: r.sample.rack, row: r.sample.row, col: r.sample.col, status: r.sample.status } : null,
    };
    try {
      db.transaction(() => {
        if (r.ok) db.persist({ samples: r.changedSamples, racks: r.changedRacks, events: r.events, opId: op.op_id, result, rev: nextRev, at: now });
        else db.persist({ samples: [], racks: [], events: [], opId: op.op_id, result, rev, at: now });
      });
      if (r.ok) rev = nextRev;
    } catch (err) {
      console.error('persist failed; reloading state', err);
      state = loadState(db.allSamples(), db.allRacks());
      return { op_id: op.op_id, ok: false, error: 'Server storage error — please retry.' };
    }
    return result;
  }

  async function serveStatic(req, res, pathname) {
    let file = VENDOR[pathname];
    if (!file) {
      const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
      file = join(PUBLIC, rel || 'index.html');
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
    }
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const ext = extname(file);
      res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' || pathname === '/sw.js' ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      // SPA fallback
      if (!extname(pathname)) return serveStatic(req, res, '/index.html');
      json(res, 404, { error: 'Not found' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lucy-Code');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (p.startsWith('/api/')) {
        if (p === '/api/health') return json(res, 200, { ok: true, name: 'Lucy Locates', rev, protected: !!accessCode });
        if (!codeOk(req.headers['x-lucy-code'] ?? url.searchParams.get('code'))) return json(res, 401, { error: 'Access code required or incorrect.' });

        if (p === '/api/changes' && req.method === 'GET') {
          const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
          const samples = db.samplesSince(since).filter((s) => since > 0 || !s.deleted);
          return json(res, 200, {
            rev, full: since === 0, samples, racks: since === 0 ? db.allRacks() : db.racksSince(since),
            events: db.eventsSince(since, since === 0 ? 1000 : 5000),
          });
        }
        if (p === '/api/ops' && req.method === 'POST') {
          const body = await readBody(req);
          const ops = Array.isArray(body.ops) ? body.ops : [];
          if (ops.length > MAX_OPS_PER_BATCH) return json(res, 413, { error: `At most ${MAX_OPS_PER_BATCH} operations per request.` });
          const before = rev;
          const results = ops.map(processOp);
          if (rev !== before) broadcast();
          return json(res, 200, { rev, results });
        }
        if (p.startsWith('/api/samples/') && p.endsWith('/history') && req.method === 'GET') {
          const n = decodeURIComponent(p.slice('/api/samples/'.length, -'/history'.length)).toUpperCase();
          return json(res, 200, { events: db.eventsForSample(n) });
        }
        if (p === '/api/stream' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`retry: 3000\nevent: rev\ndata: ${JSON.stringify({ rev })}\n\n`);
          streams.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 25000);
          req.on('close', () => { clearInterval(ping); streams.delete(res); });
          return;
        }
        return json(res, 404, { error: 'Unknown endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, p);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
      if (!err.status) console.error(err);
    }
  });

  server.on('close', () => { for (const s of streams) s.end(); db.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const dbFile = process.env.LUCY_DB || join(ROOT, 'data', 'lucy.db');
  const server = createServer({ dbFile, accessCode: process.env.LUCY_ACCESS_CODE || '' });
  server.listen(port, host, () => {
    console.log(`Lucy Locates running at http://localhost:${port}  (database: ${dbFile})`);
    if (!process.env.LUCY_ACCESS_CODE) console.log('Tip: set LUCY_ACCESS_CODE to require a lab access code.');
  });
}

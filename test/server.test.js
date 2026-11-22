import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/server.js';

async function start(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-'));
  const dbFile = join(dir, 'test.db');
  const server = createServer({ dbFile, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((r) => server.close(r)).then(() => rmSync(dir, { recursive: true, force: true }));
  return { base, dbFile, server, stop, dir };
}
const post = (base, ops, headers = {}) => fetch(`${base}/api/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ops }) }).then((r) => r.json());
const get = (base, path, headers = {}) => fetch(base + path, { headers }).then((r) => r.json());

test('two devices sync through the server; ops are idempotent', async () => {
  const { base, stop } = await start();
  try {
    const opA = { op_id: 'a1', kind: 'receive', data: { sample_number: 'SS100', sample_type: 'sureswab' }, user: 'Ann' };
    const opB = { op_id: 'a2', kind: 'store', data: { sample_number: 'SS100', rack: 1, row: 0, col: 0 }, user: 'Ann' };
    const r = await post(base, [opA, opB]);
    assert.ok(r.results.every((x) => x.ok));
    assert.equal(r.rev, 2);

    const again = await post(base, [opA, opB]); // retry after flaky network
    assert.equal(again.rev, 2);
    assert.ok(again.results.every((x) => x.duplicate));

    // Device B pulls everything
    const full = await get(base, '/api/changes?since=0');
    assert.equal(full.samples.length, 1);
    assert.equal(full.samples[0].rack, 1);
    assert.equal(full.racks.length, 20);
    assert.equal(full.events.length, 2);

    // Device B (offline earlier) also chose slot 1:A1 for another sample → conflict resolved by server
    const c = await post(base, [
      { op_id: 'b1', kind: 'receive', data: { sample_number: 'SS200', sample_type: 'sureswab' }, user: 'Bo' },
      { op_id: 'b2', kind: 'store', data: { sample_number: 'SS200', rack: 1, row: 0, col: 0 }, user: 'Bo' },
    ]);
    assert.ok(c.results[1].ok);
    assert.equal(c.results[1].conflict.occupant, 'SS100');
    assert.deepEqual([c.results[1].sample.rack, c.results[1].sample.row, c.results[1].sample.col], [1, 0, 1]);

    const inc = await get(base, '/api/changes?since=2');
    assert.deepEqual(inc.samples.map((s) => s.sample_number).sort(), ['SS200']);
    const hist = await get(base, '/api/samples/ss200/history');
    assert.deepEqual(hist.events.map((e) => e.action), ['received', 'stored', 'conflict']);
  } finally { await stop(); }
});

test('data survives restart', async () => {
  const s1 = await start();
  await post(s1.base, [
    { op_id: 'x1', kind: 'receive', data: { sample_number: 'P1', sample_type: 'pap' }, user: 'A' },
    { op_id: 'x2', kind: 'store', data: { sample_number: 'P1' }, user: 'A' },
  ]);
  await new Promise((r) => s1.server.close(r));
  const server = createServer({ dbFile: s1.dbFile });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const full = await get(base, '/api/changes?since=0');
    assert.equal(full.rev, 2);
    assert.equal(full.samples[0].rack, 8);
    // Slot index restored: next Pap goes to A2
    const r = await post(base, [
      { op_id: 'x3', kind: 'receive', data: { sample_number: 'P2', sample_type: 'pap' }, user: 'A' },
      { op_id: 'x4', kind: 'store', data: { sample_number: 'P2' }, user: 'A' },
    ]);
    assert.equal(r.results[1].sample.col, 1);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(s1.dir, { recursive: true, force: true });
  }
});

test('access code is enforced', async () => {
  const { base, stop } = await start({ accessCode: 'lab42' });
  try {
    assert.equal((await fetch(`${base}/api/changes?since=0`)).status, 401);
    assert.equal((await fetch(`${base}/api/changes?since=0`, { headers: { 'X-Lucy-Code': 'lab42' } })).status, 200);
    assert.equal((await get(base, '/api/health')).protected, true);
  } finally { await stop(); }
});

test('serves the app and the scanner library', async () => {
  const { base, stop } = await start();
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Lucy Locates/);
    const z = await fetch(`${base}/vendor/zxing.min.js`);
    assert.equal(z.status, 200);
    const trav = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(trav.status, 200);
  } finally { await stop(); }
});

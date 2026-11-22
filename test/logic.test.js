import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyOp, findFreeSlot, rackOccupancy, cloneState } from '../public/shared/logic.js';
import { RACK_COUNT, SLOTS_PER_RACK } from '../public/shared/constants.js';

let seq = 0;
const op = (kind, data, user = 'tester') => ({ op_id: `op-${++seq}`, kind, data, user, at: new Date().toISOString() });

test('20 racks of 108 slots; default types', () => {
  const s = createState();
  assert.equal(s.racks.size, RACK_COUNT);
  assert.equal(SLOTS_PER_RACK, 108);
  assert.equal(s.racks.get(1).sample_type, 'sureswab');
  assert.equal(s.racks.get(8).sample_type, 'pap');
  assert.equal(s.racks.get(20).sample_type, 'sst');
});

test('receive + store assigns first free slot in a rack of the right type', () => {
  const s = createState();
  assert.ok(applyOp(s, op('receive', { sample_number: ' ab123 ', sample_type: 'pap' })).ok);
  const r = applyOp(s, op('store', { sample_number: 'AB123' }));
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.sample.rack, r.sample.row, r.sample.col], [8, 0, 0]);
  assert.equal(r.sample.status, 'stored');
  applyOp(s, op('receive', { sample_number: 'AB124', sample_type: 'pap' }));
  const r2 = applyOp(s, op('store', { sample_number: 'AB124' }));
  assert.deepEqual([r2.sample.rack, r2.sample.row, r2.sample.col], [8, 0, 1]);
});

test('log-only types cannot be racked; not-received is logged', () => {
  const s = createState();
  assert.ok(applyOp(s, op('receive', { sample_number: 'U1', sample_type: 'urine' })).ok);
  assert.match(applyOp(s, op('store', { sample_number: 'U1' })).error, /do not have storage racks/);
  const nr = applyOp(s, op('receive', { sample_number: 'C1', sample_type: 'cbc', received: false }));
  assert.equal(nr.sample.status, 'not_received');
  assert.equal(nr.events[0].action, 'not_received');
  assert.match(applyOp(s, op('store', { sample_number: 'C1' })).error, /not received/);
});

test('cannot store into a rack of another type or an unknown sample', () => {
  const s = createState();
  applyOp(s, op('receive', { sample_number: 'S1', sample_type: 'sst' }));
  assert.match(applyOp(s, op('store', { sample_number: 'S1', rack: 1, row: 0, col: 0 })).error, /SureSwab rack/);
  assert.match(applyOp(s, op('store', { sample_number: 'NOPE' })).error, /has not been received/);
});

test('occupied slot request falls back to next free slot and reports a conflict', () => {
  const s = createState();
  for (const n of ['A', 'B']) applyOp(s, op('receive', { sample_number: n, sample_type: 'sureswab' }));
  applyOp(s, op('store', { sample_number: 'A', rack: 2, row: 3, col: 4 }));
  const r = applyOp(s, op('store', { sample_number: 'B', rack: 2, row: 3, col: 4 }));
  assert.ok(r.ok);
  assert.ok(r.conflict);
  assert.equal(r.conflict.occupant, 'A');
  assert.equal(r.sample.rack, 2); // prefers the same rack
  assert.notDeepEqual([r.sample.row, r.sample.col], [3, 4]);
});

test('retrieve frees slot; move; full racks error', () => {
  const s = createState();
  applyOp(s, op('receive', { sample_number: 'X', sample_type: 'sst' }));
  applyOp(s, op('store', { sample_number: 'X' }));
  const m = applyOp(s, op('store', { sample_number: 'X', rack: 16, row: 8, col: 11 }));
  assert.equal(m.events[0].action, 'moved');
  assert.equal(rackOccupancy(s, 15), 0);
  assert.equal(rackOccupancy(s, 16), 1);
  const r = applyOp(s, op('retrieve', { sample_number: 'X', reason: 'add-on' }));
  assert.ok(r.ok);
  assert.equal(r.sample.rack, null);
  assert.equal(rackOccupancy(s, 16), 0);

  // fill all SST racks (15–20 = 6 racks)
  for (let i = 0; i < 6 * SLOTS_PER_RACK; i++) {
    applyOp(s, op('receive', { sample_number: `F${i}`, sample_type: 'sst' }));
    assert.ok(applyOp(s, op('store', { sample_number: `F${i}` })).ok);
  }
  assert.equal(findFreeSlot(s, 'sst'), null);
  applyOp(s, op('receive', { sample_number: 'OVER', sample_type: 'sst' }));
  assert.match(applyOp(s, op('store', { sample_number: 'OVER' })).error, /racks are full/);
});

test('rack type can only change when empty; failed ops do not mutate state', () => {
  const s = createState();
  applyOp(s, op('receive', { sample_number: 'P', sample_type: 'sureswab' }));
  applyOp(s, op('store', { sample_number: 'P' }));
  const before = cloneState(s);
  assert.match(applyOp(s, op('set_rack_type', { rack: 1, sample_type: 'sst' })).error, /still holds/);
  assert.deepEqual([...s.racks.values()], [...before.racks.values()]);
  assert.ok(applyOp(s, op('set_rack_type', { rack: 2, sample_type: 'sst' })).ok);
  assert.match(applyOp(s, op('set_rack_type', { rack: 3, sample_type: 'urine' })).error, /Only SureSwab/);
});

test('type change blocked while stored', () => {
  const s = createState();
  applyOp(s, op('receive', { sample_number: 'Z', sample_type: 'sureswab' }));
  applyOp(s, op('store', { sample_number: 'Z' }));
  assert.match(applyOp(s, op('update', { sample_number: 'Z', sample_type: 'pap' })).error, /Retrieve/);
  assert.match(applyOp(s, op('receive', { sample_number: 'Z', sample_type: 'pap' })).error, /Retrieve it/);
});

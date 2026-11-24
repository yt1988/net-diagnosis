// The exact UDP / QUIC client's pure helpers (src/rtc.mjs, copied from speed-test). The rest needs a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lossOf, quicVerdict, compareSides } from '../src/rtc.mjs';

test('UDP loss: both ways, and split into there and back by the server’s count', () => {
  assert.equal(lossOf(0, 0, []), null);
  const a = lossOf(100, 98, Array(97).fill(20));
  assert.equal(Math.round(a.loss * 10) / 10, 3);
  assert.equal(Math.round(a.up * 10) / 10, 2);
  assert.equal(Math.round(a.down * 100) / 100, 1.02);
  assert.equal(a.jit, 0);
  const b = lossOf(10, null, [10, 30, 20]);
  assert.equal(b.up, null); assert.equal(b.down, null); assert.equal(b.jit, 15); assert.equal(b.rtt, 20);
});

test('QUIC verdict: works, slowed, blocked, cannot check, server unreachable', () => {
  assert.equal(quicVerdict({ api: false }), 'na');
  assert.equal(quicVerdict({ api: true, wt: null, ws: null }), 'down');
  assert.equal(quicVerdict({ api: true, wt: null, ws: { rtt: 50 } }), 'blocked');
  assert.equal(quicVerdict({ api: true, wt: { rtt: 52, lost: 0 }, ws: { rtt: 50 } }), 'ok');
  assert.equal(quicVerdict({ api: true, wt: { rtt: 120, lost: 0 }, ws: { rtt: 50 } }), 'slow');
  assert.equal(quicVerdict({ api: true, wt: { rtt: 50, lost: 0.4 }, ws: { rtt: 50 } }), 'slow');
});

test('the two echoes: which side loses packets, or one side not measured', () => {
  assert.equal(compareSides(null, null).side, 'none');
  assert.equal(compareSides(null, 0.5).side, 'partial');
  assert.equal(compareSides(0.5, null).side, 'partial');
  assert.equal(compareSides(0.5, 0.2).side, 'same');
  assert.equal(compareSides(0.2, 4).side, 'border');
  assert.equal(compareSides(4, 0.2).side, 'domestic');
  assert.equal(compareSides(4, 7).side, 'both');
  assert.equal(compareSides(1, 0.9).side, 'domestic'); // 1% is already bad: the threshold the help uses
});

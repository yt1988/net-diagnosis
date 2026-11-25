// The exact UDP / QUIC client's pure helpers (src/rtc.mjs, copied from speed-test). The rest needs a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rtcSides, lossOf, quicVerdict, compareSides } from '../src/rtc.mjs';

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

// The page's endpoints come from the site: <meta name="ms-rtc"> with comma lists, mainland China first.
const doc = (content) => ({ querySelector: (sel) => (content == null || sel !== 'meta[name="ms-rtc"]' ? null : { getAttribute: () => content }) });

test('rtcSides: no injected meta means no echoes (the block hides)', () => {
  assert.deepEqual(rtcSides(doc(null)), []);
  assert.deepEqual(rtcSides({ querySelector: () => null }), []);
  assert.deepEqual(rtcSides(undefined), []); // Node has no document: the same degradation the page gets
});

test('rtcSides: the two lists keep their order, and a path missing a key is dropped', () => {
  const two = rtcSides(doc('sig=https://a:2087,https://b:2087;ice=a:40100-40101,b:40100-40101;wt=https://a:40101,https://b:40101'));
  assert.deepEqual(two.map((s) => s.sig), ['https://a:2087', 'https://b:2087']);
  assert.deepEqual(two.map((s) => s.wt), ['https://a:40101/wt', 'https://b:40101/wt']);
  assert.equal(two[0].ice, 'a:40100-40101');
  assert.equal(two[1].ice, 'b:40100-40101');
  const one = rtcSides(doc('sig=https://a:2087;ice=a:40100-40101;wt=https://a:40101'));
  assert.deepEqual(one.map((s) => s.sig), ['https://a:2087']);
  assert.deepEqual(rtcSides(doc('sig=https://a:2087')), []); // no wt: that path cannot be tested
  assert.deepEqual(rtcSides(doc('wt=https://a:40101')), []);
  assert.deepEqual(rtcSides(doc('')), []);
  // the contract's own form, host:port without a scheme: sig gets https, wt gets https and /wt
  const bare = rtcSides(doc('sig=a:2087,b:2087;ice=a:40100-40101,b:40100-40101;wt=a:40101,b:40101'));
  assert.deepEqual(bare.map((s) => s.sig), ['https://a:2087', 'https://b:2087']);
  assert.deepEqual(bare.map((s) => s.wt), ['https://a:40101/wt', 'https://b:40101/wt']);
});

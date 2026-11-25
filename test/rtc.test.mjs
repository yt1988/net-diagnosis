// The exact UDP / QUIC client's pure helpers (src/rtc.mjs, copied from speed-test). The rest needs a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rtcSides, lossOf, quicVerdict, compareSides, authToken, tokenFresh, refreshToken, ensureToken, wsUrl, offerWithAuth } from '../src/rtc.mjs';

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

// Endpoint auth: the shell signs a short-lived token into <meta name="ms-auth">.
const metaDoc = (content) => {
  let v = content;
  const el = { getAttribute: () => v, setAttribute: (_n, x) => { v = x; } };
  return { doc: { querySelector: (sel) => (sel === 'meta[name="ms-auth"]' ? el : null) }, value: () => v };
};

test('auth token: read from the meta, fresh only with a minute left', () => {
  const { doc } = metaDoc('v1.1000.n.rtc.hmac');
  assert.equal(authToken(doc), 'v1.1000.n.rtc.hmac');
  assert.equal(authToken(undefined), '');
  assert.equal(tokenFresh('v1.' + (1000 + 300) + '.n.rtc.h', 1000), true);
  assert.equal(tokenFresh('v1.' + (1000 + 59) + '.n.rtc.h', 1000), false);
  assert.equal(tokenFresh('garbage', 1000), false);
});

test('offerWithAuth: no token, a token, one retry after 401, never a loop', async () => {
  const calls = [];
  const impl = () => async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return { status: 401, ok: false }; };
  let refresh = 0;
  calls.length = 0;
  let r = await offerWithAuth('u', {}, { token: '', refresh: async () => { refresh++; return 'v1.b'; } }, impl());
  assert.equal(r.res.status, 401); assert.equal(calls.length, 1); assert.equal(calls[0].auth, undefined); assert.equal(refresh, 0);
  calls.length = 0; refresh = 0;
  r = await offerWithAuth('u', {}, { token: 'v1.a', refresh: async () => { refresh++; return 'v1.b'; } }, impl());
  assert.equal(calls.length, 2); assert.equal(refresh, 1);
  assert.equal(calls[0].auth, 'Bearer v1.a'); assert.equal(calls[1].auth, 'Bearer v1.b');
  calls.length = 0;
  r = await offerWithAuth('u', {}, { token: 'v1.a', refresh: async () => '' }, impl());
  assert.equal(calls.length, 1); assert.equal(refresh, 1);
});

test('offerWithAuth: a 200 carries the token once', async () => {
  const calls = [];
  const impl = async (url, init) => { calls.push(init.headers.authorization); return { status: 200, ok: true }; };
  const r = await offerWithAuth('u', {}, { token: 'v1.a' }, impl);
  assert.equal(r.res.status, 200); assert.deepEqual(calls, ['Bearer v1.a']);
});

test('refreshToken updates the meta; wsUrl carries the token', async () => {
  const { doc, value } = metaDoc('v1.old.n.rtc.h');
  const t = await refreshToken(doc, async () => ({ ok: true, json: async () => ({ token: 'v1.new.n.rtc.h' }) }));
  assert.equal(t, 'v1.new.n.rtc.h'); assert.equal(value(), 'v1.new.n.rtc.h');
  assert.equal(await refreshToken(doc, async () => ({ ok: false })), '');
  assert.equal(wsUrl('wss://h:2087/ws', ''), 'wss://h:2087/ws');
  assert.equal(wsUrl('wss://h:2087/ws', 'a b'), 'wss://h:2087/ws?token=a%20b');
  assert.equal(wsUrl('wss://h/ws?x=1', 't'), 'wss://h/ws?x=1&token=t');
});

test('ensureToken: no meta sends nothing, a fresh token stays, a stale one is replaced once', async () => {
  let calls = 0;
  const impl = async () => { calls++; return { ok: true, json: async () => ({ token: 'v1.' + (100000 + 300) + '.n.rtc.h' }) }; };
  const none = { querySelector: () => null };
  assert.equal(await ensureToken(none, impl), ''); assert.equal(calls, 0);
  const { doc: fresh } = metaDoc('v1.' + (Math.floor(Date.now() / 1000) + 300) + '.n.rtc.h');
  assert.match(await ensureToken(fresh, impl), /^v1\./); assert.equal(calls, 0);
  const { doc: stale, value } = metaDoc('v1.1000.n.rtc.h');
  const t = await ensureToken(stale, impl); assert.match(t, /^v1\./); assert.equal(calls, 1); assert.equal(value(), t);
  const { doc: stale2 } = metaDoc('v1.1000.n.rtc.h');
  assert.equal(await ensureToken(stale2, async () => ({ ok: false })), ''); // stale and no replacement: send nothing
});

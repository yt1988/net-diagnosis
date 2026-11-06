import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quantile, windowStats, stunLoss, statusOf, udpStatusOf, attribute, mos, mosLevel, gaming, Incidents, WINDOW_MS, proxyHint, confidence, bloatGrade, bloatLevel,
} from '../src/lib.mjs';

test('quantile and window stats', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  const w = windowStats([{ ms: 10 }, { ms: 12 }, { ms: null }, { ms: 30 }]);
  assert.equal(w.n, 4); assert.equal(w.ok, 3); assert.equal(w.fails, 1); assert.equal(w.min, 10); assert.equal(w.med, 12);
});

// Replay of the validated run: LiteServer, incoming STUN answers dropped at random in 5-minute phases.
test('stunLoss reads back injected loss (LiteServer run, 2026-11-06)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/stun-loss-2026-11-06.json', import.meta.url), 'utf8'));
  for (const t of fx.targets.filter((t) => !t.url.includes('miwifi'))) {
    const inPhase = (i) => t.probes.filter((p) => p.at >= fx.phases[i].t + 5000 && p.at < fx.phases[i + 1].t);
    const base = stunLoss(inPhase(0)).base;
    let prev = -1;
    for (let i = 0; i < fx.phases.length - 1; i++) {
      const r = stunLoss(inPhase(i), base);
      const want = fx.phases[i].injected;
      assert.ok(Math.abs(r.lossPct - want) <= 2.5, `${t.url} at ${want}%: inferred ${r.lossPct.toFixed(2)}%`);
      assert.ok(r.lossPct >= prev - 0.5, `${t.url}: loss should rise with the injected rate`);
      prev = r.lossPct;
    }
  }
});

test('stunLoss: counting only the first answer would hide the loss (two sockets)', () => {
  // two answers per probe; every 10th probe loses the IPv4 answer once (it comes 250 ms later)
  const probes = Array.from({ length: 100 }, (_, i) => ({ answers: i % 10 ? [5, 8] : [5, 258] }));
  const r = stunLoss(probes);
  assert.equal(r.expected, 2);
  assert.ok(Math.abs(r.lossPct - (10 / 210) * 100) < 0.01, String(r.lossPct));
});

test('stunLoss: a missing answer is 4 lost sends; slow-but-not-retransmitted is not loss', () => {
  // 200 ms: 180 over the base, nearest the 250 ms step but 70 off it (more than the 60 ms tolerance): a delay
  const probes = [{ answers: [20] }, { answers: [] }, { answers: [20] }, { answers: [20] }, { answers: [200] }];
  const r = stunLoss(probes, 20);
  assert.equal(r.slow, 1);
  assert.equal(r.sends, 4 + 4); assert.equal(Math.round(r.lossPct), 50);
});

test('statusOf thresholds', () => {
  const steady = windowStats([20, 21, 22, 21, 20].map((ms) => ({ ms })));
  assert.equal(statusOf(steady, { floor: 20 }).status, 'ok');
  const jittery = windowStats([20, 140, 30, 200, 25].map((ms) => ({ ms })));
  assert.equal(statusOf(jittery, { floor: 20 }).status, 'bad');
  const slower = windowStats([95, 100, 98, 97, 99].map((ms) => ({ ms })));
  assert.equal(statusOf(slower, { floor: 20 }).status, 'bad');
  assert.deepEqual(statusOf(windowStats([{ ms: null }, { ms: null }])), { status: 'down', why: ['timeouts'] });
  assert.equal(statusOf(windowStats([{ ms: 20 }, { ms: null }, { ms: 21 }, { ms: 20 }, { ms: 22 }, { ms: 20 }]), { floor: 20 }).status, 'warn');
  const farButSteady = windowStats([180, 182, 181, 183, 180].map((ms) => ({ ms })));
  assert.equal(statusOf(farButSteady, { floor: 180 }).status, 'ok', 'a long path is not a problem by itself');
  assert.equal(statusOf(farButSteady, { floor: 180, near: true }).status, 'bad', 'but the nearest location should be near');
  assert.equal(udpStatusOf({ probes: 10, answered: 0 }).status, 'down');
});

// ---------- labelled scenarios: the verdict each fault must produce ----------
const T = (id, status, med = 30) => ({ id, status, med, why: [] });
const okNear = [T('cf', 'ok', 8)], okFar = [T('tyo', 'ok', 220), T('fra', 'ok', 20), T('iad', 'ok', 90)];
const base = { online: true, hidden: false, lagP95: 20, near: okNear, far: okFar, svc: [], udp: { status: 'ok', lossPct: 0 } };
const scenarios = [
  ['nothing wrong', {}, 'ok'],
  ['offline', { online: false }, 'offline'],
  ['busy device', { lagP95: 400 }, 'device'],
  ['local Wi-Fi or access: every path worse', { near: [T('cf', 'bad')], far: okFar.map((t) => ({ ...t, status: 'bad' })) }, 'local'],
  ['cross-border / backbone: near fine, far worse', { far: [T('tyo', 'bad'), T('fra', 'bad'), T('iad', 'ok')] }, 'crossborder'],
  ['one service down, others fine', { svc: [T('steam', 'down'), T('github', 'ok'), T('chatgpt', 'ok')] }, 'service'],
  ['UDP throttled, TCP fine', { udp: { status: 'bad', lossPct: 12 } }, 'udp'],
  ['UDP blocked', { udp: { status: 'down', lossPct: 100 } }, 'udp'],
  ['UDP much slower than TCP to the same location', { udpRef: 200, tcpRef: 60 }, 'udp-slow'],
  ['nearest Cloudflare location alone', { near: [T('cf', 'bad')] }, 'service'],
  ['proxy entry: domestic fine, everything through the proxy worse',
    { proxied: true, direct: [T('baidu', 'ok', 9)], near: [T('cf', 'bad', 300)], far: okFar.map((t) => ({ ...t, status: 'bad' })) }, 'proxy-entry'],
  ['proxy exit: domestic and the proxy hop fine, beyond it worse',
    { proxied: true, direct: [T('baidu', 'ok', 9)], near: [T('cf', 'ok', 60)], far: [T('tyo', 'bad'), T('fra', 'bad'), T('iad', 'bad')] }, 'proxy-exit'],
  ['your side, router worse too → Wi-Fi or home network',
    { near: [T('cf', 'bad')], far: okFar.map((t) => ({ ...t, status: 'bad' })), gw: { id: 'gw', status: 'bad', med: 120 } }, 'wifi'],
  ['your side, router fine → the ISP connection',
    { near: [T('cf', 'bad')], far: okFar.map((t) => ({ ...t, status: 'bad' })), gw: { id: 'gw', status: 'ok', med: 3 } }, 'access'],
  ['IPv6 alone losing, IPv4 fine', { ipv6: { status: 'bad', lossPct: 9 }, ipv4: { status: 'ok', lossPct: 0 } }, 'ipv6'],
  ['proxied, but the line itself is bad: domestic worse too',
    { proxied: true, direct: [T('baidu', 'bad', 300)], near: [T('cf', 'bad', 400)], far: okFar }, 'local'],
];
for (const [name, patch, want] of scenarios) {
  test(`scenario: ${name} → ${want}`, () => {
    const v = attribute({ ...base, ...patch });
    assert.equal(v.key, want, JSON.stringify(v));
    assert.ok(v.conf >= 1 && v.conf <= 3);
  });
}

test('router thresholds and bufferbloat grades', () => {
  const router = windowStats([3, 4, 3, 5, 4].map((ms) => ({ ms })));
  assert.equal(statusOf(router, { floor: 3, lan: true }).status, 'ok');
  assert.equal(statusOf(windowStats([90, 95, 92, 91, 93].map((ms) => ({ ms }))), { floor: 90, lan: true }).status, 'bad', 'a router 90 ms away is a Wi-Fi problem');
  assert.equal(bloatGrade(3), 'A+'); assert.equal(bloatGrade(45), 'B'); assert.equal(bloatGrade(500), 'F');
  assert.equal(bloatLevel('A'), 'good'); assert.equal(bloatLevel('C'), 'fair'); assert.equal(bloatLevel('F'), 'poor');
});

test('scores', () => {
  assert.ok(mos(30, 2, 0) > 4.3);
  assert.equal(mosLevel(mos(30, 2, 0)), 'good');
  assert.equal(mosLevel(mos(300, 40, 5)), 'poor');
  assert.equal(gaming({ spikes: 1, minutes: 10, loss: 0, jitter: 3 }).level, 'good');
  assert.equal(gaming({ spikes: 30, minutes: 10, loss: 4, jitter: 40 }).level, 'poor');
});

test('incidents open after 2 bad windows and close after 3 good ones', () => {
  const inc = new Incidents();
  const bad = { key: 'local', conf: 2, evidence: [] }, ok = { key: 'ok', conf: 3, evidence: [] };
  let t = 0;
  assert.equal(inc.feed((t += WINDOW_MS), bad), null);
  assert.equal(inc.feed((t += WINDOW_MS), bad), 'opened');
  assert.equal(inc.list.length, 1);
  assert.equal(inc.list[0].start, WINDOW_MS - WINDOW_MS);
  inc.feed((t += WINDOW_MS), ok); inc.feed((t += WINDOW_MS), ok);
  assert.equal(inc.feed((t += WINDOW_MS), ok), 'closed');
  assert.equal(inc.list[0].open, false);
  inc.feed((t += WINDOW_MS), bad); inc.feed((t += WINDOW_MS), ok);
  assert.equal(inc.list.length, 1, 'a single bad window is not an incident');
});

test('proxy hint and confidence', () => {
  assert.deepEqual(proxyHint({ tz: 'Asia/Shanghai', exitCountry: 'JP' }), { home: 'CN', exit: 'JP' });
  assert.equal(proxyHint({ tz: 'Asia/Shanghai', exitCountry: 'CN' }), null);
  assert.equal(proxyHint({ tz: 'Europe/Paris', exitCountry: 'US' }), null);
  assert.equal(confidence(3, 1), 2);
  assert.equal(confidence(2, 7), 3);
});

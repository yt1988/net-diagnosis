// Pure logic for the diagnosis: statistics, STUN loss inference, the state of each target in a time window, which
// segment of the path is at fault, scenario scores and the incident log. No browser APIs, so all of it is
// unit-tested (test/lib.test.mjs), including replays of labelled scenarios.

export const WINDOW_MS = 5000;

// ---------- statistics ----------
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
export const median = (a) => quantile([...a].sort((x, y) => x - y), 0.5);
// mean change between consecutive values, in the order measured
export const jitterOf = (a) => (a.length < 2 ? null : a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1));

// HTTPS samples of one target in one window: { ms } for an answer, { ms: null } for a timeout or error
export function windowStats(samples) {
  const ok = samples.filter((s) => s.ms != null).map((s) => s.ms);
  const sorted = [...ok].sort((a, b) => a - b);
  return {
    n: samples.length, ok: ok.length, fails: samples.length - ok.length,
    min: sorted[0] ?? null, med: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), jitter: jitterOf(ok),
  };
}

// ---------- STUN: UDP round trip and loss ----------
// libwebrtc retransmits a STUN request 250 ms after the first send, then after 500 ms and 1000 ms more, so an answer
// whose first k requests were lost arrives near RTT + RETX[k]. Every server-reflexive answer counts as one request:
// with IPv4 and IPv6 (or two interfaces) each socket asks on its own, and the first answer hides a loss on the other.
// Validated 2026-11-06 by dropping incoming STUN answers on a Linux VPS: 2 / 5 / 10 % injected read back as
// 1.3–2.0 / 4.4–4.8 / 8.2–9.1 %.
export const RETX = [0, 250, 750, 1750];
export const STUN_TIMEOUT_MS = 3000; // past this the 4th send is lost too: a missing answer counts as 4 of 4 lost

// probes: [{ answers: [ms, …] }] (an empty list: nothing came back). base: the no-retransmission round trip; by
// default the 10th percentile of every answer.
export function stunLoss(probes, base = null) {
  const counts = {};
  for (const p of probes) counts[p.answers.length] = (counts[p.answers.length] || 0) + 1;
  const expected = Number(Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1) || 1;
  const all = probes.flatMap((p) => p.answers).sort((a, b) => a - b);
  if (base == null) base = quantile(all, 0.1);
  const tol = Math.max(60, Math.min(100, (base ?? 0) * 0.5)); // capped: on a 200 ms path half the base took jitter for loss
  let sends = 0, lost = 0, slow = 0;
  const clean = [];
  for (const p of probes) {
    for (const ms of p.answers) {
      const ex = ms - base;
      let k = 0, err = Infinity;
      RETX.forEach((c, i) => { const d = Math.abs(ex - c); if (d < err) { err = d; k = i; } });
      if (k > 0 && err > tol) { k = 0; slow++; } // slow, but not on a retransmission step: a delay, not a loss
      sends += k + 1; lost += k;
      if (k === 0) clean.push(ms);
    }
    const miss = Math.max(0, expected - p.answers.length);
    sends += 4 * miss; lost += 4 * miss;
  }
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    probes: probes.length, answered: probes.filter((p) => p.answers.length).length, expected, base,
    lossPct: sends ? (lost / sends) * 100 : null, sends, slow,
    med: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), jitter: jitterOf(clean),
  };
}

// ---------- the state of one target in one window ----------
// ok · warn · bad · down (nothing answered) · none (not measured). floor: the best this target has done this
// session (its window minimum), which stands in for the path's own length. near: a target that should be close,
// so a high round trip alone is a problem.
// lan: the home router, which answers in a few ms when the Wi-Fi is fine.
export function statusOf(w, { floor = null, near = false, lan = false } = {}) {
  if (!w || !w.n) return { status: 'none' };
  if (!w.ok) return { status: 'down', why: ['timeouts'] };
  const f = floor ?? w.min;
  const fail = w.fails / w.n, spread = w.p90 - w.min, excess = w.med - f;
  const why = [];
  let status = 'ok';
  const bad = (k) => { status = 'bad'; why.push(k); };
  const warn = (k) => { if (status === 'ok') status = 'warn'; why.push(k); };
  if (fail >= 0.2) bad('timeouts'); else if (fail > 0) warn('timeouts');
  if (spread > Math.max(60, f)) bad('jitter'); else if (spread > Math.max(30, f * 0.5)) warn('jitter');
  if (excess > Math.max(50, f * 0.6)) bad('slower'); else if (excess > Math.max(25, f * 0.3)) warn('slower');
  if (lan) { if (w.med > 80) bad('far'); else if (w.med > 30) warn('far'); }
  else if (near) { if (w.med > 150) bad('far'); else if (w.med > 80) warn('far'); }
  return { status, why: [...new Set(why)] };
}

export function udpStatusOf(u) {
  if (!u || !u.probes) return { status: 'none' };
  if (!u.answered) return { status: 'down', why: ['udp-blocked'] };
  if (u.lossPct >= 5) return { status: 'bad', why: ['loss'] };
  if (u.lossPct >= 2) return { status: 'warn', why: ['loss'] };
  return { status: 'ok', why: [] };
}

const isBad = (s) => s === 'bad' || s === 'down';

// ---------- which segment is at fault ----------
// snap: {
//   online, hidden, lagP95,                       the device and the page
//   direct: [t], near: [t], far: [t], svc: [t],  HTTPS targets: { id, status, med, … }
//     direct: reached without the proxy (only known when a proxy is detected: the domestic sites)
//     near:   the nearest Cloudflare location (through the proxy when there is one)
//     far:    distant single-location cloud regions
//   proxied,                                      the exit Cloudflare sees is not the visitor's own network
//   udp: { status, lossPct, med }, tcpRef, udpRef  UDP through STUN; round trips to the same Cloudflare location
// }
// → { key, conf: 1 low · 2 medium · 3 high, evidence: [{ k, … }] }
// keys: ok · offline · hidden · device · local · proxy-entry · proxy-exit · crossborder · service · udp · udp-slow · unknown
// With the home router measured (s.gw), "your side" splits: the router worse too = Wi-Fi or the home network;
// the router fine = the ISP connection beyond it.
export function attribute(s) {
  const v = attributePath(s);
  if (v.key === 'local' && s.gw && s.gw.status !== 'none') {
    if (isBad(s.gw.status)) return { key: 'wifi', conf: Math.max(v.conf, 2), evidence: [{ k: 'gw-bad', gw: [s.gw] }, ...v.evidence] };
    if (s.gw.status === 'ok') return { key: 'access', conf: Math.max(v.conf, 2), evidence: [{ k: 'gw-ok', gw: [s.gw] }, ...v.evidence] };
  }
  if (v.key === 'ok' && s.ipv6 && s.ipv4 && isBad(s.ipv6.status) && s.ipv4.status === 'ok') {
    return { key: 'ipv6', conf: s.ipv6.status === 'down' ? 3 : 2, evidence: [{ k: 'ipv6-bad', lossPct: s.ipv6.lossPct, status: s.ipv6.status }, { k: 'ipv4-ok', lossPct: s.ipv4.lossPct }] };
  }
  return v;
}

function attributePath(s) {
  const ev = [];
  const bads = (arr) => arr.filter((t) => isBad(t.status));
  const share = (arr) => (arr.length ? bads(arr).length / arr.length : 0);
  const pick = (arr) => arr.map((t) => ({ id: t.id, med: t.med, status: t.status, why: t.why }));
  if (s.online === false) return { key: 'offline', conf: 3, evidence: [{ k: 'offline' }] };
  if (s.hidden) return { key: 'hidden', conf: 1, evidence: [{ k: 'hidden' }] };
  if (s.lagP95 != null && s.lagP95 > 150) return { key: 'device', conf: 2, evidence: [{ k: 'lag', ms: Math.round(s.lagP95) }] };

  const near = s.near || [], far = s.far || [], direct = s.direct || [], svc = s.svc || [];
  const nearBad = share(near) >= 0.5, farBad = far.length > 0 && share(far) >= 0.5;

  if (s.proxied && direct.length) {
    const directBad = share(direct) >= 0.5;
    if (directBad && (nearBad || farBad)) {
      ev.push({ k: 'all-paths', direct: pick(direct), near: pick(near), far: pick(bads(far)) });
      return { key: 'local', conf: nearBad && farBad ? 3 : 2, evidence: ev };
    }
    if (!directBad && nearBad) {
      ev.push({ k: 'direct-ok', direct: pick(direct) }, { k: 'proxy-near-bad', near: pick(near) });
      return { key: 'proxy-entry', conf: farBad ? 3 : 2, evidence: ev };
    }
    if (!directBad && !nearBad && farBad) {
      ev.push({ k: 'direct-ok', direct: pick(direct) }, { k: 'near-ok', near: pick(near) }, { k: 'far-bad', far: pick(bads(far)) });
      return { key: 'proxy-exit', conf: share(far) === 1 && far.length > 1 ? 3 : 2, evidence: ev };
    }
    if (directBad) {
      ev.push({ k: 'direct-bad', direct: pick(bads(direct)) });
      return { key: 'service', conf: 1, evidence: ev, ids: bads(direct).map((t) => t.id) };
    }
  } else {
    if (nearBad && farBad) {
      ev.push({ k: 'all-paths', near: pick(near), far: pick(bads(far)) });
      return { key: 'local', conf: share(far) === 1 ? 3 : 2, evidence: ev };
    }
    if (!nearBad && farBad) {
      ev.push({ k: 'near-ok', near: pick(near) }, { k: 'far-bad', far: pick(bads(far)) });
      return { key: 'crossborder', conf: far.length > 1 && share(far) === 1 ? 3 : 2, evidence: ev };
    }
    if (nearBad && !farBad && far.length) {
      // everything past the near location is fine, so the line itself is: the near location's own trouble
      ev.push({ k: 'near-only', near: pick(bads(near)), far: pick(far) });
      return { key: 'service', conf: 1, evidence: ev, ids: bads(near).map((t) => t.id) };
    }
    if (nearBad) {
      ev.push({ k: 'all-paths', near: pick(near) });
      return { key: 'local', conf: 1, evidence: ev };
    }
  }

  const svcBad = bads(svc);
  if (svcBad.length && svcBad.length < svc.length) {
    ev.push({ k: 'service-bad', svc: pick(svcBad) }, { k: 'others-ok', n: svc.length - svcBad.length });
    return { key: 'service', conf: svcBad.length === 1 ? 3 : 2, evidence: ev, ids: svcBad.map((t) => t.id) };
  }
  if (svc.length > 1 && svcBad.length === svc.length) {
    ev.push({ k: 'service-bad', svc: pick(svcBad) });
    return { key: 'unknown', conf: 1, evidence: ev };
  }

  if (s.udp && isBad(s.udp.status)) {
    ev.push({ k: 'udp-loss', lossPct: s.udp.lossPct, status: s.udp.status }, { k: 'tcp-ok' });
    return { key: 'udp', conf: s.udp.status === 'down' ? 3 : 2, evidence: ev };
  }
  if (s.udpRef != null && s.tcpRef != null && s.udpRef > s.tcpRef * 1.5 + 30) {
    ev.push({ k: 'udp-slower', udp: Math.round(s.udpRef), tcp: Math.round(s.tcpRef) });
    return { key: 'udp-slow', conf: 1, evidence: ev };
  }
  return { key: 'ok', conf: 3, evidence: [] };
}

// ---------- scenario scores ----------
// Calls: ITU-T G.107 E-model, the usual simplified form. rtt and jitter in ms, loss in %.
export function mos(rtt, jitter, loss) {
  if (rtt == null) return null;
  const d = rtt / 2 + 2 * (jitter || 0) + 10;
  let r = d < 160 ? 93.2 - d / 40 : 93.2 - (d - 120) / 10;
  r -= 2.5 * (loss || 0);
  r = Math.max(0, Math.min(100, r));
  return 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
}
export const mosLevel = (m) => (m == null ? null : m >= 4 ? 'good' : m >= 3.6 ? 'fair' : 'poor');

// Games: hiccups per 10 minutes (round trips 100 ms above the best, or UDP retransmissions), loss and jitter
export function gaming({ spikes, minutes, loss, jitter }) {
  if (!minutes) return null;
  const per10 = (spikes / minutes) * 10;
  const level = per10 <= 2 && (loss ?? 0) < 1 && (jitter ?? 0) < 15 ? 'good' : per10 <= 6 && (loss ?? 0) < 3 && (jitter ?? 0) < 30 ? 'fair' : 'poor';
  return { per10, level };
}

// Loaded latency: how much the round trip rises while the line is full (bufferbloat), graded on Waveform's scale
export function bloatGrade(rise) {
  if (rise == null) return null;
  return rise < 5 ? 'A+' : rise < 30 ? 'A' : rise < 60 ? 'B' : rise < 200 ? 'C' : rise < 400 ? 'D' : 'F';
}
export const bloatLevel = (g) => (g == null ? null : g === 'A+' || g === 'A' ? 'good' : g === 'B' || g === 'C' ? 'fair' : 'poor');

// Pages: setting up a connection (DNS, TCP, TLS, any proxy hop) to the nearest location
export const pageLevel = (setupMs) => (setupMs == null ? null : setupMs < 250 ? 'good' : setupMs < 600 ? 'fair' : 'poor');

// ---------- incidents ----------
// A verdict other than ok for 2 windows in a row opens an incident; 3 ok windows close it.
export class Incidents {
  constructor() { this.list = []; this.cur = null; this.badRun = 0; this.okRun = 0; this.pending = null; }
  feed(t, v) {
    const bad = v.key !== 'ok' && v.key !== 'hidden';
    if (bad) {
      this.okRun = 0; this.badRun++;
      if (this.badRun === 1) this.pending = t - WINDOW_MS;
      if (!this.cur && this.badRun >= 2) {
        this.cur = { start: this.pending, end: t, keys: {}, key: v.key, conf: v.conf, evidence: v.evidence, ids: v.ids, open: true };
        this.list.unshift(this.cur);
      }
      if (this.cur) {
        this.cur.end = t;
        this.cur.keys[v.key] = (this.cur.keys[v.key] || 0) + 1;
        this.cur.key = Object.entries(this.cur.keys).sort((a, b) => b[1] - a[1])[0][0];
        if (v.key === this.cur.key) { this.cur.evidence = v.evidence; this.cur.conf = Math.max(this.cur.conf, v.conf); if (v.ids) this.cur.ids = v.ids; }
      }
      return this.cur && this.badRun === 2 ? 'opened' : null;
    }
    this.badRun = 0;
    if (this.cur && ++this.okRun >= 3) { this.cur.open = false; this.cur = null; return 'closed'; }
    return null;
  }
}

// A verdict held for 3+ windows with broad support is firm; a single window is a hint.
export function confidence(base, heldWindows) { return Math.max(1, Math.min(3, base - (heldWindows < 2 ? 1 : 0) + (heldWindows >= 6 ? 1 : 0))); }

// ---------- proxy hint ----------
// The time zone's country against the exit country Cloudflare sees. Only the zones that matter most here; others: unknown.
const TZ = {
  'Asia/Shanghai': 'CN', 'Asia/Chongqing': 'CN', 'Asia/Harbin': 'CN', 'Asia/Urumqi': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Singapore': 'SG', 'Europe/Moscow': 'RU', 'Asia/Tehran': 'IR', 'Europe/Istanbul': 'TR',
};
export const tzCountry = (tz) => TZ[tz] || null;
export function proxyHint({ tz, exitCountry }) {
  const home = tzCountry(tz);
  if (!home || !exitCountry) return null;
  return home !== exitCountry ? { home, exit: exitCountry } : null;
}

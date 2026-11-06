// A result in a link: /r/<code> (or /<lang>/r/<code>). The Worker reads the code for the link's preview title; the
// page reads it to show the result. It holds the verdict, the numbers and each lane's states, never an address: the
// country and the Cloudflare location only when the visitor ticks the box. Services the visitor added are named
// by their host.
//
// Format 1: 1~<time, base 36 s>~<verdict>~<confidence 1-3>~<run length, base 36 s>~<d: diagnosis, m: monitoring>
//   ~<nearby ms>~<jitter ms>~<UDP loss %>~<call MOS>   (tenths, base 36; empty: not measured)
//   ~<games g/f/p>~<hiccups, base 36>~<page setup ms, base 36>~<loaded grade: A+ as P>~<loaded rise ms, base 36>
//   ~<country or ->~<Cloudflare location or ->~<names the verdict is about, joined by _ or ->~<incidents, base 36>
//   ~<lane states: device.gw.direct.near.far.udp.svc, one letter per stretch of time, x: no such lane>
//   ~<what the near lane stood for: n nearby, d domestic sites, p the proxy server>

export const FORMAT = 1;
export const LANES = ['device', 'gw', 'direct', 'near', 'far', 'udp', 'svc'];
export const KEYS = ['ok', 'offline', 'hidden', 'device', 'local', 'wifi', 'access', 'proxy-entry', 'proxy-exit', 'crossborder', 'service', 'udp', 'udp-slow', 'ipv6', 'unknown'];
const ST = { ok: 'o', warn: 'w', bad: 'b', down: 'd', gap: 'g', none: 'n' };
const ST_R = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k]));
const LV = { good: 'g', fair: 'f', poor: 'p' }, LV_R = { g: 'good', f: 'fair', p: 'poor' };
const NEAR_AS = { near: 'n', direct: 'd', near_proxy: 'p' }, NEAR_AS_R = { n: 'near', d: 'direct', p: 'near_proxy' };
export const CELLS = 24; // a lane's stretch on the card and the shared page

const n36 = (v, k = 10) => (v == null || !Number.isFinite(v) ? '' : Math.max(0, Math.round(v * k)).toString(36));
const p36 = (s, k = 10) => (s === '' ? null : /^[0-9a-z]{1,8}$/.test(s) ? parseInt(s, 36) / k : NaN);
const name = (s) => String(s).replace(/^c:/, '').replace(/[^A-Za-z0-9.-]/g, '').slice(0, 40);

// A lane's windows squeezed into at most CELLS letters, the worst state of each stretch
export function squeeze(states, n = CELLS) {
  if (states.length <= n) return states;
  const rank = { none: 0, gap: 1, ok: 2, warn: 3, bad: 4, down: 5 }, out = [];
  for (let i = 0; i < n; i++) {
    const part = states.slice(Math.floor((i * states.length) / n), Math.floor(((i + 1) * states.length) / n));
    out.push(part.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'none'));
  }
  return out;
}

// { ts, key, conf, secs, mon, near, jitter, loss, mos, game, spikes, setup, grade, rise, cc, colo, ids, incidents, lanes, nearAs }
export function encode(r) {
  const lanes = LANES.map((k) => (r.lanes?.[k] ? squeeze(r.lanes[k]).map((s) => ST[s] || 'n').join('') || 'n' : 'x')).join('.');
  return [FORMAT, Math.round(r.ts / 1000).toString(36), KEYS.includes(r.key) ? r.key : 'unknown', Math.min(3, Math.max(1, r.conf || 1)),
    n36(r.secs, 1), r.mon ? 'm' : 'd', n36(r.near), n36(r.jitter), n36(r.loss), n36(r.mos), LV[r.game] || '', n36(r.spikes, 1), n36(r.setup, 1),
    r.grade === 'A+' ? 'P' : r.grade || '', n36(r.rise, 1), /^[A-Z]{2}$/.test(r.cc || '') ? r.cc : '-', /^[A-Z]{3}$/.test(r.colo || '') ? r.colo : '-',
    (r.ids || []).map(name).filter(Boolean).slice(0, 4).join('_') || '-', n36(r.incidents || 0, 1), lanes, NEAR_AS[r.nearAs] || 'n'].join('~');
}

// code → the result, or null when this page can't read it
export function decode(code) {
  if (typeof code !== 'string' || code.length > 600) return null;
  const p = code.split('~');
  if (p[0] !== '1' || p.length !== 21 || !/^[ndp]$/.test(p[20]) || !/^[0-9a-z]{1,8}$/.test(p[1]) || !KEYS.includes(p[2]) || !/^[123]$/.test(p[3]) || !/^[dm]$/.test(p[5])) return null;
  const lanes = p[19].split('.');
  if (lanes.length !== LANES.length || !lanes.every((s) => s === 'x' || /^[owbdgn]{1,24}$/.test(s))) return null;
  if (!/^(|[gfp])$/.test(p[10]) || !/^(|A|P|B|C|D|F)$/.test(p[13]) || !/^([A-Z]{2}|-)$/.test(p[15]) || !/^([A-Z]{3}|-)$/.test(p[16]) || !/^(-|[A-Za-z0-9._-]{1,170})$/.test(p[17])) return null;
  const r = {
    v: 1, ts: parseInt(p[1], 36) * 1000, key: p[2], conf: +p[3], secs: p36(p[4], 1), mon: p[5] === 'm',
    near: p36(p[6]), jitter: p36(p[7]), loss: p36(p[8]), mos: p36(p[9]), game: LV_R[p[10]] || null, spikes: p36(p[11], 1), setup: p36(p[12], 1),
    grade: p[13] === 'P' ? 'A+' : p[13] || null, rise: p36(p[14], 1), cc: p[15] === '-' ? '' : p[15], colo: p[16] === '-' ? '' : p[16],
    ids: p[17] === '-' ? [] : p[17].split('_').filter(Boolean), incidents: p36(p[18], 1),
    nearAs: NEAR_AS_R[p[20]],
    lanes: Object.fromEntries(LANES.map((k, i) => [k, lanes[i] === 'x' ? null : [...lanes[i]].map((c) => ST_R[c])])),
  };
  if (['secs', 'near', 'jitter', 'loss', 'mos', 'spikes', 'setup', 'rise', 'incidents'].some((k) => Number.isNaN(r[k])) || r.secs == null) return null;
  return r;
}

// /r/<code> or /<lang folder>/r/<code> → { slug, code }, or null
export function sharePath(pathname) {
  const m = /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?r\/([0-9A-Za-z~._-]+)\/?$/.exec(pathname);
  return m ? { slug: m[1] || '', code: decodeURIComponent(m[2]) } : null;
}

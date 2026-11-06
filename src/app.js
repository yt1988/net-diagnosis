// Network Diagnosis: the page. The worker (worker-probe.js) keeps the schedule and runs the HTTPS probes; this file
// runs STUN when told, judges every 5-second window with src/lib.mjs, and draws the verdict, the lanes and the log.
// Two modes: a diagnosis (DURATION_MS, a first verdict at PRELIM_MS) or monitoring (until Stop).
// On demand: the home router (Chrome's local network permission), loaded latency (fills the line for 10 s) and an
// exact UDP / QUIC test against rtc.1ms.dog (src/rtc.mjs).
import { NEAR, META, DIRECT, FAR, SERVICES, STUN, STUN_DIRECT, GATEWAYS } from './targets.mjs';
import { stun, stunOverhead, meta } from './probes.mjs';
import { udp as rtcUdp, quic as rtcQuic } from './rtc.mjs';
import {
  WINDOW_MS, windowStats, statusOf, udpStatusOf, stunLoss, attribute, mos, mosLevel, gaming, pageLevel, Incidents, confidence,
  proxyHint, tzCountry, median, RETX, bloatGrade, bloatLevel,
} from './lib.mjs';

const L = window.L1MS, D = JSON.parse(document.getElementById('data').textContent);
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (k, v) => { let s = L[k]; if (s == null) return k; if (v) s = String(s).replace(/\{(\w+)\}/g, (m, x) => (v[x] ?? m)); return s; };
const nameOf = (n) => (typeof n === 'string' ? n : n[D.lang] || n.other);
const ms0 = (x) => (x == null ? '–' : Math.round(x));
const pct = (x) => (x == null ? '–' : x.toFixed(1) + '%');
const zh = D.lang.startsWith('zh');
const SEP = zh ? '；' : '; ', PAREN = zh ? ['（', '）'] : [' (', ')'], AND = zh ? '、' : ', ';
const K = { theme: 'netdiag:theme', lang: 'netdiag:lang', svcs: 'netdiag:svcs', custom: 'netdiag:custom' };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hms = (ms) => new Date(ms).toLocaleTimeString(D.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBad = (s) => s === 'bad' || s === 'down';

/* ---------- theme, language, dialogs (synced across the 1ms.dog tools) ---------- */
const thBtn = $('#theme'), TH = ['system', 'light', 'dark'];
function applyTheme(th) {
  if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme');
  thBtn.dataset.th = th;
}
thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set(K.theme, n); applyTheme(n); };
applyTheme(TH.includes(store.get(K.theme)) ? store.get(K.theme) : 'system');
$('#lang').onchange = (e) => { const l = e.target.value; store.set(K.lang, l); location.href = D.paths[l] + location.search; };
function openDlg(id) { hideTip(); $('#' + id).hidden = false; document.documentElement.style.overflow = 'hidden'; $('#' + id + ' [data-close]').focus(); }
function closeDlg() { $$('.scrim').forEach((s) => { s.hidden = true; }); document.documentElement.style.overflow = ''; }
$$('[data-close]').forEach((b) => { b.onclick = closeDlg; });
$$('.scrim').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) closeDlg(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDlg(); hideTip(); } });
const helpN = $$('#helpNav [data-hq]').length;
let helpIdx = 0;
$('#helpSel').innerHTML = $$('#helpNav [data-hq]').map((b, i) => `<option value="${i}">${i + 1} / ${helpN} · ${esc(b.textContent)}</option>`).join('');
function showHelp(i) {
  helpIdx = (i + helpN) % helpN;
  $$('#helpNav [data-hq]').forEach((b) => b.setAttribute('aria-selected', +b.dataset.hq === helpIdx));
  $$('#helpC [data-hqb]').forEach((a) => { a.hidden = +a.dataset.hqb !== helpIdx; });
  $('#helpSel').value = helpIdx;
}
$('#helpBtn').onclick = () => { showHelp(helpIdx); openDlg('help'); };
$$('#helpNav [data-hq]').forEach((b) => { b.onclick = () => showHelp(+b.dataset.hq); });
$('#helpSel').onchange = (e) => showHelp(+e.target.value);
$$('[data-hstep]').forEach((b) => { b.onclick = () => showHelp(helpIdx + +b.dataset.hstep); });

/* ---------- tooltips: hover with a mouse, tap on a touch screen; below the element unless there is no room ---------- */
const tip = document.createElement('div');
tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
document.body.append(tip);
let tipEl = null;
function showTip(el) {
  tipEl = el;
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const y = r.bottom + 8 + h <= innerHeight - 8 ? r.bottom + 8 : Math.max(8, r.top - h - 8);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() { tip.hidden = true; tipEl = null; }
document.addEventListener('pointerover', (e) => { if (e.pointerType !== 'mouse') return; const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip) showTip(el); });
document.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && tipEl && !tipEl.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip && tipEl !== el && !el.matches('button')) showTip(el); else if (!e.target.closest('.tip')) hideTip(); });
document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip && el.matches(':focus-visible')) showTip(el); });
document.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive: true });

/* ---------- services: the built-in list plus the visitor's own, kept in this browser ---------- */
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
let custom = (() => { try { const v = JSON.parse(store.get(K.custom)); return Array.isArray(v) ? v.filter((s) => s && s.id && s.url) : []; } catch { return []; } })();
let picked = (() => { try { const v = JSON.parse(store.get(K.svcs)); if (Array.isArray(v)) return new Set(v); } catch {} return new Set(SERVICES.filter((s) => s.on).map((s) => s.id)); })();
const services = () => [...SERVICES, ...custom];
const saveSvcs = () => { store.set(K.svcs, JSON.stringify([...picked])); store.set(K.custom, JSON.stringify(custom)); syncServices(); };
// a local copy for the built-in services, the site's own favicon for the visitor's; a letter when there is none
const icon = (s) => `<span class="fav" data-l="${esc((s.name || '?').slice(0, 1).toUpperCase())}"><img src="${esc(s.icon || `https://${hostOf(s.url)}/favicon.ico`)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer"></span>`;
function wireIcons(root) {
  root.querySelectorAll('.fav img').forEach((img) => {
    const ok = () => img.classList.add('ok');
    img.onerror = () => img.remove();
    if (img.complete && img.naturalWidth) ok(); else img.onload = ok;
  });
}
function drawServices() {
  $('#svcList').innerHTML = services().map((s) => {
    const mine = s.id.startsWith('c:');
    return `<span class="chip${mine ? ' mine' : ''}"><button type="button" class="chip-b" data-svc="${esc(s.id)}" aria-pressed="${picked.has(s.id)}">${icon(s)}${esc(s.name)}</button>${mine ? `<button type="button" class="chip-x" data-rm="${esc(s.id)}" aria-label="${esc(t('svc_rm', { name: s.name }))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg></button>` : ''}</span>`;
  }).join('');
  wireIcons($('#svcList'));
  $$('#svcList [data-svc]').forEach((b) => {
    b.onclick = () => { const id = b.dataset.svc; if (picked.has(id)) picked.delete(id); else picked.add(id); b.setAttribute('aria-pressed', picked.has(id)); saveSvcs(); drawSvcLane(); };
  });
  $$('#svcList [data-rm]').forEach((b) => {
    b.onclick = () => { custom = custom.filter((s) => s.id !== b.dataset.rm); picked.delete(b.dataset.rm); saveSvcs(); drawServices(); };
  });
  drawSvcLane();
}
// the services lane names what it follows: icons next to the name, the full list in its tooltip
function drawSvcLane() {
  const on = services().filter((s) => picked.has(s.id));
  $('#svcIcons').innerHTML = on.slice(0, 6).map(icon).join('') + (on.length > 6 ? `<span class="more">+${on.length - 6}</span>` : '');
  wireIcons($('#svcIcons'));
  $('[data-lane="svc"] .ln-k').dataset.tip = t('lane_tip_svc') + '\n' + (on.length ? on.map((s) => s.name).join(AND) : t('svc_none'));
  if (!running()) { const st = $('[data-lane="svc"] .ln-st'); st.textContent = on.length ? t('st_none') : t('svc_none'); }
}
// the best of 3 tries, or null when the site never answers
async function bestOf(url) {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000), t0 = performance.now();
    try {
      await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Math.random().toString(36).slice(2), { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      best = best == null ? performance.now() - t0 : Math.min(best, performance.now() - t0);
    } catch {} finally { clearTimeout(timer); }
  }
  return best;
}
// A bare domain often redirects (bing.com → www.bing.com: 2.1 s against 0.25 s, and a redirect fails in the
// worker), so both spellings are tried and the faster one that answers is kept.
$('#svcForm').onsubmit = async (e) => {
  e.preventDefault();
  const raw = $('#svcIn').value.trim(), msg = $('#svcErr');
  let u = null;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw); } catch {}
  if (!u || u.protocol !== 'https:' || !u.hostname.includes('.')) { msg.dataset.k = 'err'; msg.textContent = t('svc_bad'); return; }
  const given = u.pathname !== '/' || u.search ? [u.href] : [];
  const hosts = given.length ? [] : [u.host, ...(u.hostname.startsWith('www.') ? [] : ['www.' + u.host])];
  const cands = [...given, ...hosts.map((h) => `https://${h}/favicon.ico`)];
  const known = services().find((s) => cands.includes(s.url) || hosts.includes(hostOf(s.url)));
  if (known) { picked.add(known.id); saveSvcs(); $('#svcIn').value = ''; drawServices(); return; }
  msg.dataset.k = ''; msg.textContent = t('svc_checking');
  $('#svcForm button').disabled = true;
  const times = await Promise.all(cands.map(bestOf));
  $('#svcForm button').disabled = false;
  const i = times.reduce((b, ms, j) => (ms != null && (b < 0 || ms < times[b]) ? j : b), -1);
  if (i < 0) { msg.dataset.k = 'err'; msg.textContent = t('svc_dead', { host: u.hostname }); return; }
  const url = cands[i], host = hostOf(url), id = 'c:' + host;
  if (!services().some((s) => s.id === id)) custom.push({ id, name: host.replace(/^www\./, ''), url });
  picked.add(id);
  saveSvcs();
  msg.textContent = '';
  $('#svcIn').value = '';
  drawServices();
};
$('#svcEdit').onclick = () => openDlg('svcs');

/* ---------- the run ---------- */
const PRELIM_MS = 20000, DURATION_MS = 120000, LANE_CELLS = 72; // the lanes show 6 minutes of 5-second windows
// 10 s or 400 MB, whichever comes first (a 674 Mbps line reached 300 MB in 3.5 s, too short to read)
const LOAD = { url: NEAR.url.replace(/\?.*$/, ''), secs: 10, maxBytes: 400e6, rampMs: 1000 };
const S = {
  mode: 'idle', sel: 'diag', t0: 0, targets: [], stuns: [], overhead: 0, meta: null, home: null, cn: false, proxied: false, exit: '',
  windows: [], inc: new Incidents(), marks: [], worker: null, stunI: 0, lag: null, fast: true, last: null, pub4: null, pub6: null,
  proto: { n: 0, h3: 0 }, gw: null, load: null, udpx: null,
};
const running = () => S.mode === 'run';
const continuous = () => S.sel === 'mon';

const newTarget = (key, id, name, url, group, near, extra = {}) => ({ key, id, name, url, group, near, samples: [], floor: null, ...extra });
const svcTargets = () => services().filter((s) => picked.has(s.id)).map((s) => newTarget('svc:' + s.id, s.id, s.name, s.url, 'svc', false));
function plan() {
  // while the line is filled on purpose, the nearby round trip is asked 4 times a second: the test is short
  const loading = S.load && !S.load.done;
  const near = loading ? 250 : S.fast ? 500 : 1000, slow = S.fast ? 2000 : 5000;
  return S.targets.map((tg) => ({ id: tg.key, url: tg.url, every: tg.group === 'near' || tg.group === 'direct' ? near : slow }));
}
function startWorker() { S.worker.postMessage({ cmd: 'start', plan: plan(), stunEvery: S.fast ? 500 : 1000, window: WINDOW_MS }); }
// services picked or dropped during a run are measured (or dropped) at once
function syncServices() {
  if (!running() || !S.worker) return;
  const want = svcTargets(), keep = S.targets.filter((x) => x.group !== 'svc' || want.some((w) => w.key === x.key));
  S.targets = [...keep, ...want.filter((w) => !keep.some((k) => k.key === w.key))];
  startWorker();
}

async function begin() {
  if (running()) { finish(); return; }
  hideTip();
  Object.assign(S, { mode: 'run', t0: Date.now(), windows: [], inc: new Incidents(), marks: [], stunI: 0, lag: null, last: null, fast: true, pub4: null, pub6: null, proto: { n: 0, h3: 0 }, load: null });
  if (S.gw) Object.assign(S.gw, { samples: [], floor: null });
  document.body.dataset.run = 'on';
  $('#incC').hidden = false;
  resetLanes();
  drawIncidents();
  numbers(null);
  verdict({ key: 'running' });
  tickButton();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  S.home = tzCountry(tz);
  // Cloudflare's view of the exit, and the browser's own STUN overhead, before the first window closes
  const [m, oh] = await Promise.all([meta(META), stunOverhead().catch(() => 0)]);
  if (!running()) return; // stopped while asking
  S.meta = m; S.overhead = oh;
  const hint = proxyHint({ tz, exitCountry: m?.country });
  const cn = (S.cn = S.home === 'CN' || m?.country === 'CN');
  S.proxied = !!hint && cn;
  S.exit = [m && t('info_exit', { org: m.org || 'AS' + m.asn, colo: m.colo || '?' }), hint && t('info_proxy', { home: region(hint.home), exit: region(hint.exit) })].filter(Boolean).join(' · ');
  // the nearest location gets an absolute bar only where it should be near (not from mainland China: it is abroad)
  S.targets = [
    newTarget('near:cf', NEAR.id, NEAR.name, NEAR.url, 'near', !cn && !hint),
    ...(cn ? DIRECT.CN : []).map((d) => newTarget('direct:' + d.id, d.id, nameOf(d.name), d.url, 'direct', true)),
    ...FAR.map((f) => newTarget('far:' + f.id, f.id, t('far_' + f.id), f.url, 'far', false)),
    ...svcTargets(),
  ];
  S.stuns = [...STUN, ...(cn ? STUN_DIRECT.CN : [])].map((s) => ({ ...s, probes: [] }));
  // with a proxy in mainland China domestic sites get their own lane and "nearby" is the proxy server; without
  // one, domestic sites are the nearby lane and Cloudflare (abroad) joins the distant one
  $('[data-lane="direct"]').hidden = !(cn && S.proxied);
  const nearKey = cn ? (S.proxied ? 'near_proxy' : 'direct') : 'near';
  $('[data-lane="near"] .ln-k').textContent = t('lane_' + nearKey);
  $('[data-lane="near"] .ln-k').dataset.tip = t('lane_tip_' + nearKey);
  verdict({ key: 'running' });
  S.worker = new Worker(D.worker);
  S.worker.onmessage = onWorker;
  startWorker();
  findGateway();
}

function region(cc) {
  if (cc === 'TW') return { 'zh-CN': '中国台湾', 'zh-TW': '中國台灣' }[D.lang] || 'Taiwan, China';
  try { return new Intl.DisplayNames([D.lang], { type: 'region' }).of(cc); } catch { return cc; }
}

// network changes seen during a run: shown in the log and on the device lane
function mark(k, detail = '') { if (running()) { S.marks.push({ t: Date.now(), k, detail }); drawIncidents(); } }
addEventListener('online', () => mark('online'));
addEventListener('offline', () => mark('offline'));
const conn = navigator.connection;
let connWas = conn ? `${conn.type || ''}${conn.type && conn.effectiveType ? ' · ' : ''}${conn.effectiveType || ''}` : '';
conn?.addEventListener?.('change', () => {
  const now = `${conn.type || ''}${conn.type && conn.effectiveType ? ' · ' : ''}${conn.effectiveType || ''}`;
  if (now !== connWas) mark('conn', `${connWas || '?'} → ${now || '?'}`);
  connWas = now;
});

function onWorker({ data: m }) {
  if (!running()) return;
  if (m.type === 'sample') {
    const tg = S.targets.find((x) => x.key === m.id);
    if (!tg) return;
    tg.samples.push({ t: m.t, ms: m.ms });
    if (m.cold && m.ms != null) tg.coldMs = m.ms; // setup ≈ the first request less a warm one
    if (tg.group === 'near' && m.proto) { S.proto.n++; if (/^h3/.test(m.proto)) S.proto.h3++; }
    if (tg.samples.length > 4000) tg.samples.splice(0, 2000);
  } else if (m.type === 'stun') {
    probeGateway();
    if (!S.stuns.length) return;
    const s = S.stuns[S.stunI++ % S.stuns.length];
    if (s.busy) return;
    s.busy = true;
    stun(s.url).then((r) => {
      s.busy = false;
      s.probes.push({ t: Date.now(), answers: r.answers.map((x) => Math.max(0, x - S.overhead)), v6: r.v6 || [], hosts: r.hosts });
      if (s.probes.length > 4000) s.probes.splice(0, 2000);
      // the public address changing mid-run: a new IP from the ISP, a switch between networks, a proxy reconnecting
      if (s.ref) {
        if (r.pub4 && S.pub4 && r.pub4 !== S.pub4) mark('ip4');
        if (r.pub6 && S.pub6 && r.pub6 !== S.pub6) mark('ip6');
        S.pub4 = r.pub4 || S.pub4; S.pub6 = r.pub6 || S.pub6;
      }
    });
  } else if (m.type === 'tick') {
    S.lag = m.lag;
    onWindow(m.t);
  } else if (m.type === 'load') {
    onLoaded(m);
  }
}

// ---------- the home router (optional) ----------
// Chrome asks the visitor to allow this page to reach the local network; an http request to a private address is
// then allowed from an https page. Each answer, or a quick refusal, is one round trip to the router.
// → { ms, web }: web = the router answered over http; otherwise a refusal after a round trip (ms) or nothing (null)
async function gwTry(ip, timeout = 2000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout), t0 = performance.now();
  try {
    await fetch(`http://${ip}/?_=${Math.random().toString(36).slice(2)}`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal, targetAddressSpace: 'local' });
    return { ms: performance.now() - t0, web: true };
  } catch {
    const ms = performance.now() - t0;
    return { ms: ms > 3 && ms < timeout - 50 ? ms : null, web: false }; // at once: blocked; at the timeout: nothing there
  } finally { clearTimeout(timer); }
}
const gwOnce = async (ip, timeout) => (await gwTry(ip, timeout)).ms;
// Found by itself when a run starts: every common address at once, a real web answer first (a missing subnet can
// come back as a quick "unreachable" from the router upstream), then the fastest. Nothing found: no lane.
async function findGateway() {
  if (S.gw || S.gwLooking) return;
  S.gwLooking = true;
  const rs = await Promise.all(GATEWAYS.map(async (ip) => ({ ip, ...(await gwTry(ip, 1500)) })));
  S.gwLooking = false;
  const ok = rs.filter((r) => r.ms != null).sort((a, b) => (b.web - a.web) || a.ms - b.ms);
  if (!ok.length || !running()) return;
  S.gw = { ip: ok[0].ip, samples: [], floor: null, busy: false };
  const li = $('[data-lane="gw"]');
  li.hidden = false;
  li.querySelector('.ln-k').dataset.tip = t('lane_tip_gw', { ip: ok[0].ip });
}
async function probeGateway() {
  const g = S.gw;
  if (!g || g.busy) return;
  g.busy = true;
  const ms = await gwOnce(g.ip);
  g.busy = false;
  g.samples.push({ t: Date.now(), ms });
  if (g.samples.length > 4000) g.samples.splice(0, 2000);
}

// ---------- judging ----------
function groupStatus(list) {
  const st = list.map((x) => x.status).filter((s) => s !== 'none');
  if (!st.length) return 'none';
  const bad = st.filter(isBad).length;
  if (bad / st.length >= 0.5) return st.every((s) => s === 'down') ? 'down' : 'bad';
  return bad || st.includes('warn') ? 'warn' : 'ok';
}
// services read alike everywhere: jitter alone is "so-so", not "worse"
const soften = (x) => (x.status === 'bad' && x.why?.length === 1 && x.why[0] === 'jitter' ? { ...x, status: 'warn' } : x);
// one address family's share of the STUN answers
const family = (probes, six) => probes.map((p) => ({ answers: p.answers.filter((_, i) => !!p.v6[i] === six) }));

// The state of every target, UDP, the router and the device over [from, to]. Each target's floor is its best window so far.
function snapshot(from, to, { updateFloor = true, span = false } = {}) {
  const tgs = S.targets.map((tg) => {
    // in 5-second windows, distant paths and services (asked every 5 s once the run settles) have one answer per
    // window: they are judged over the last 30 s. The first two answers on a new connection run slow (it is still
    // warming up): left out.
    const f = !span && !S.fast && (tg.group === 'far' || tg.group === 'svc') ? Math.min(from, to - 30000) : from;
    const ss = tg.samples.filter((s, i) => s.t > f && s.t <= to && i >= 2);
    const w = windowStats(ss);
    if (updateFloor && w.min != null) tg.floor = tg.floor == null ? w.min : Math.min(tg.floor, w.min);
    return { key: tg.key, id: tg.id, name: tg.name, group: tg.group, ...w, ...statusOf(w, { floor: tg.floor, near: tg.near }) };
  });
  const byG = (g) => tgs.filter((x) => x.group === g);
  // UDP over the last minute (or the run so far): enough answers to read a loss rate
  const ufrom = Math.max(S.t0, to - 60000);
  const recent = S.stuns.map((s) => ({ s, ps: s.probes.filter((p) => p.t > ufrom && p.t <= to) }));
  // No local UDP address at all: the browser itself keeps WebRTC off UDP (an anti-leak extension, a policy). That
  // says nothing about the network, so UDP is "can't measure", not "blocked" (seen 2026-11-06 in a real Chrome).
  const all = recent.flatMap(({ ps }) => ps);
  const browserOff = all.length >= 4 && all.every((p) => !p.hosts && !p.answers.length);
  const usSt = recent.map(({ s, ps }) => { const u = stunLoss(ps); return { id: s.id, ref: s.ref, ...u, ...(browserOff ? { status: 'none' } : udpStatusOf(u)) }; });
  const measured = usSt.filter((u) => u.status !== 'none');
  const fam = (six) => {
    const rs = recent.map(({ ps }) => stunLoss(family(ps, six))).filter((u) => u.answered > 0);
    if (!rs.length) return null;
    const st = rs.map((u) => ({ ...u, ...udpStatusOf(u) }));
    return { status: groupStatus(st), lossPct: median(st.map((u) => u.lossPct ?? 0)) };
  };
  const ref = usSt.find((u) => u.ref), near = byG('near')[0];
  let gw = null;
  if (S.gw) {
    const w = windowStats(S.gw.samples.filter((s) => s.t > from && s.t <= to));
    if (updateFloor && w.min != null) S.gw.floor = S.gw.floor == null ? w.min : Math.min(S.gw.floor, w.min);
    gw = { id: 'gw', name: t('lane_gw'), ...w, ...statusOf(w, { floor: S.gw.floor, lan: true }) };
  }
  const local = S.cn && !S.proxied; // see judge()
  return {
    near: local ? byG('direct') : byG('near'), direct: local ? [] : byG('direct'), far: local ? [...byG('far'), ...byG('near')] : byG('far'), svc: byG('svc').map(soften), gw,
    udp: { status: groupStatus(measured), lossPct: measured.length ? median(measured.map((u) => u.lossPct ?? 0)) : null, med: ref?.med ?? null, browserOff },
    ipv4: browserOff ? null : fam(false), ipv6: browserOff ? null : fam(true),
    tcpRef: near?.med ?? null, udpRef: ref?.med ?? null,
    lagP95: document.visibilityState === 'hidden' ? null : S.lag,
  };
}

// From mainland China without a proxy the nearest Cloudflare location is abroad: domestic sites are the near
// reference and Cloudflare joins the distant paths (done in snapshot()).
function judge(sn, early = false) {
  const v = attribute({
    online: navigator.onLine, hidden: false, lagP95: sn.lagP95, proxied: S.proxied, udp: sn.udp, tcpRef: sn.tcpRef, udpRef: sn.udpRef,
    near: sn.near, far: sn.far, direct: sn.direct, gw: sn.gw, ipv4: sn.ipv4, ipv6: sn.ipv6,
    // early on a service's "best so far" is a single lucky answer, so only timeouts count
    svc: sn.svc.map((x) => (early && isBad(x.status) && !(x.status === 'down' || x.why?.includes('timeouts')) ? { ...x, status: 'warn' } : x)),
  });
  if (v.key === 'service') {
    // slower but answering: medium at most; timeouts or nothing at all can be sure
    const hard = sn.svc.concat(sn.near, sn.direct).some((x) => v.ids?.includes(x.id) && (x.status === 'down' || x.why?.includes('timeouts')));
    if (early || !hard) v.conf = Math.min(v.conf, 2);
  }
  return v;
}

function onWindow(now) {
  if (!running()) return;
  const elapsed = now - S.t0;
  if (S.fast && elapsed >= PRELIM_MS) { S.fast = false; startWorker(); } // the first 20 s ask twice as often
  const sn = snapshot(now - WINDOW_MS, now);
  // a window the page slept through (too few answers from the nearest location) is a gap, not a verdict
  const gap = (sn.near[0]?.n ?? 0) < 2 && !S.fast;
  const v = gap ? { key: 'gap', conf: 0, evidence: [] } : judge(sn, elapsed < 60000);
  let held = 1;
  for (let i = S.windows.length - 1; i >= 0 && S.windows[i].v.key === v.key; i--) held++;
  if (!gap) v.conf = confidence(v.conf, held);
  S.windows.push({ t: now, v });
  if (S.windows.length > 2000) S.windows.splice(0, 1000);
  drawLanes(sn, gap, now);
  // the load test fills the line on purpose: its windows say nothing about the line itself
  const loading = S.load && !S.load.done;
  if (!gap && !loading && elapsed >= PRELIM_MS) {
    const ev = S.inc.feed(now, v);
    if (ev === 'opened') notify(S.inc.list[0]);
    if (ev || S.inc.cur) drawIncidents();
  }
  // the headline: the run so far (from 20 s on), or the last minute once monitoring passes 2 minutes
  if (elapsed >= PRELIM_MS && !loading) {
    const from = elapsed <= DURATION_MS ? S.t0 + 1500 : now - 60000;
    const span = snapshot(from, now, { updateFloor: false, span: true });
    const hv = judge(span, elapsed < 60000);
    hv.conf = confidence(hv.conf, elapsed >= DURATION_MS ? 6 : 2);
    S.last = hv;
    verdict(hv, elapsed < DURATION_MS ? 'prelim' : continuous() ? 'monitor' : 'final');
    numbers(spanScores(elapsed <= DURATION_MS ? S.t0 : now - 10 * 60000, now), span);
  }
  title(v.key);
  if (elapsed >= DURATION_MS && !continuous()) finish();
}

function finish() {
  S.worker?.postMessage({ cmd: 'stop' });
  S.worker?.terminate();
  S.worker = null;
  S.mode = 'done';
  document.body.dataset.run = '';
  tickButton();
  if (S.last) verdict(S.last, 'final');
  else verdict({ key: 'idle' });
  if (S.load && !S.load.done) S.load = null;
  drawExtras();
  title('ok');
}

// scores over [from, to]: calls (MOS), games (hiccups), web pages (connection setup)
function spanScores(from, to) {
  from = Math.max(from, S.t0 + 1500);
  // the visitor's own line: domestic sites in mainland China, the nearest Cloudflare location elsewhere
  const near = S.targets.find((x) => x.group === (S.cn ? 'direct' : 'near')) || S.targets[0];
  const inLoad = (tt) => S.load && tt >= S.load.t0 && tt <= (S.load.t1 || Infinity);
  const ss = near ? near.samples.filter((s, i) => s.t > from && s.t <= to && i >= 2 && s.ms != null && !inLoad(s.t)).map((s) => s.ms) : [];
  const floor = near?.floor ?? (ss.length ? Math.min(...ss) : null);
  const w = windowStats(ss.map((ms) => ({ ms })));
  const ref = S.stuns.find((s) => s.ref) || S.stuns[0];
  const probes = ref ? ref.probes.filter((p) => p.t > from && p.t <= to) : [];
  const off = probes.length >= 4 && probes.every((p) => !p.hosts && !p.answers.length); // the browser keeps WebRTC off UDP
  const u = ref && !off ? stunLoss(probes) : null;
  let retx = 0;
  if (u && u.base != null) for (const p of probes) for (const a of p.answers) if (a - u.base > RETX[1] - 60) retx++;
  const spikes = (floor == null ? 0 : ss.filter((x) => x > floor + 100).length) + retx;
  const minutes = (to - from) / 60000;
  // a new connection costs this much more than a request on an open one: the first request of every target
  // (one of them is almost always new), less that target's usual answer
  const setups = S.targets.map((tg) => {
    if (tg.coldMs == null) return null;
    const warm = median(tg.samples.filter((s, i) => i >= 2 && s.ms != null).map((s) => s.ms));
    return warm == null ? null : tg.coldMs - warm;
  }).filter((x) => x != null && x >= 5);
  const setup = setups.length ? median(setups) : null;
  return {
    call: mos(u?.med ?? w.med, w.jitter, u?.lossPct ?? 0), game: gaming({ spikes, minutes, loss: u?.lossPct ?? 0, jitter: w.jitter ?? 0 }),
    spikes, minutes, setup, nearMed: w.med, jitter: w.jitter, loss: u?.lossPct ?? null,
  };
}

/* ---------- on demand: loaded latency and the exact UDP / QUIC test ---------- */
function startLoad() {
  if (!running() || (S.load && !S.load.done)) return;
  const near = S.targets.find((x) => x.group === (S.cn ? 'direct' : 'near'));
  const idle = median(near.samples.filter((s, i) => i >= 2 && s.ms != null && s.t > Date.now() - 30000).map((s) => s.ms));
  S.load = { t0: Date.now(), t1: null, idle, done: false };
  startWorker();
  S.worker.postMessage({ cmd: 'load', url: LOAD.url, secs: LOAD.secs, maxBytes: LOAD.maxBytes });
  drawExtras();
}
function onLoaded(m) {
  const near = S.targets.find((x) => x.group === (S.cn ? 'direct' : 'near'));
  Object.assign(S.load, { t1: Date.now(), bytes: m.bytes, mbps: (m.bytes * 8) / (m.ms * 1000), done: true });
  if (running()) startWorker(); // back to the usual pace
  // round trips while the line was full, after its first second (the downloads ramp up)
  const loaded = median(near.samples.filter((s) => s.ms != null && s.t > S.load.t0 + LOAD.rampMs && s.t <= S.load.t1).map((s) => s.ms));
  S.load.loaded = loaded;
  S.load.rise = loaded != null && S.load.idle != null ? Math.max(0, loaded - S.load.idle) : null;
  S.load.grade = bloatGrade(S.load.rise);
  drawExtras();
}
async function startUdpx() {
  if (S.udpx?.run) return;
  S.udpx = { run: true };
  drawExtras();
  const u = rtcUdp();
  await sleep(20000);
  const r = await u.stop();
  const q = await rtcQuic().catch(() => ({ verdict: 'down' }));
  S.udpx = { run: false, state: r.state, p: r.phases?.[0] || null, q: q.verdict };
  drawExtras();
}

/* ---------- drawing ---------- */
const why = (x) => (x.why?.length ? PAREN[0] + x.why.map((w) => t('why_' + w)).join(AND) + PAREN[1] : '');
const listOf = (items) => items.map((x) => `${x.name ?? x.id} ${x.status === 'down' ? t('st_down') : ms0(x.med) + ' ms'}${why(x)}`).join(SEP);
const LEVEL = { ok: 'ok', 'udp-slow': 'warn', unknown: 'warn', hidden: 'warn', ipv6: 'warn', running: 'run', idle: 'idle' };
const nameIn = (id) => S.targets.find((x) => x.id === id)?.name || id;
const evText = (e) => {
  if (e.k === 'udp-loss') return e.status === 'down' ? t('ev_udp-blocked') : t('ev_udp-loss', { loss: (e.lossPct ?? 0).toFixed(1) });
  if (e.k === 'ipv6-bad' || e.k === 'ipv4-ok') return t('ev_' + e.k, { loss: (e.lossPct ?? 0).toFixed(1) });
  const named = (e.near || e.far || e.direct || e.svc || e.gw || []).map((x) => ({ ...x, name: x.name || nameIn(x.id) }));
  return t('ev_' + e.k, { list: listOf(named), n: e.n, udp: e.udp, tcp: e.tcp, ms: e.ms });
};

function verdict(v, state) {
  const box = $('#verdict');
  box.dataset.lv = LEVEL[v.key] || 'bad';
  if (v.key === 'idle' || v.key === 'running') {
    $('#vH').textContent = t(v.key === 'idle' ? (continuous() ? 'v_idle_mon' : 'v_idle') : 'v_running');
    $('#vState').textContent = v.key === 'running' ? t(continuous() ? 'st_measuring_mon' : 'st_measuring') : ' ';
    $('#vExit').textContent = (v.key === 'running' && S.exit) || '';
    $('#ev').innerHTML = '';
    $('#sugL').innerHTML = '';
    $('#sug').dataset.on = '';
    $('#evc').dataset.on = '';
    $('#evc').hidden = false;
    return;
  }
  $('#vH').textContent = t('v_' + v.key, { names: (v.ids || []).map(nameIn).join(' / ') });
  const el = Date.now() - S.t0;
  const st = state === 'prelim' ? t('st_prelim') : state === 'monitor' ? t('st_monitor', { t: clock(el), n: S.inc.list.length }) : t('st_final', { t: clock(el) });
  $('#vState').textContent = st + ' · ' + t('conf_' + (v.conf || 1));
  $('#vExit').textContent = S.exit || '';
  // why and what to try, 3 lines each; with no evidence (all fine) the suggestions take the whole row
  const ev = (v.evidence || []).slice(0, 3);
  $('#ev').innerHTML = ev.map((e) => `<li>${esc(evText(e))}</li>`).join('');
  $('#evc').dataset.on = ev.length ? '1' : '';
  $('#evc').hidden = !ev.length;
  const sug = (L['s_' + v.key] || []).filter((s, i) => !(v.key === 'ok' && i === 0 && continuous())).slice(0, 3);
  $('#sug').dataset.on = sug.length ? '1' : '';
  $('#sugL').innerHTML = sug.map((s) => `<li>${esc(s)}</li>`).join('');
}

let lastScores = null;
function numbers(sc) {
  lastScores = sc;
  const put = (k, lv, val, detail) => {
    const li = $(`[data-s="${k}"]`);
    li.dataset.lv = lv || '';
    li.querySelector('b').textContent = val ?? '–';
    li.querySelector('em').textContent = detail || ' ';
  };
  $('[data-c="near"] b').textContent = sc?.nearMed == null ? '–' : Math.round(sc.nearMed) + ' ms';
  $('[data-c="jitter"] b').textContent = sc?.jitter == null ? '–' : sc.jitter.toFixed(1) + ' ms';
  if (!sc) { ['call', 'game', 'page'].forEach((k) => put(k, null)); drawExtras(); return; }
  const call = mosLevel(sc.call), game = sc.game?.level ?? null, page = pageLevel(sc.setup);
  put('call', call, call && t('lv_' + call), sc.call == null ? '' : t('sc_call_v', { v: sc.call.toFixed(1) }));
  // a short stretch: the count itself, over how long it was measured (20 s scaled up to 10 minutes says little)
  const span = sc.minutes < 1 ? t('dur_s', { n: Math.round(sc.minutes * 60) }) : t('dur_m', { n: Math.round(sc.minutes) });
  put('game', game, game && t('lv_' + game), !sc.game ? '' : sc.minutes < 5 ? t('sc_game_q', { n: sc.spikes, span }) : t('sc_game_v', { n: Math.round(sc.game.per10) }));
  put('page', page, page && t('lv_' + page), sc.setup == null ? t('sc_page_na') : t('sc_page_v', { ms: Math.round(sc.setup) }));
  drawExtras();
}

// UDP loss (estimated, or exact once rtc.1ms.dog was asked) and loaded latency, each with its own button
function drawExtras() {
  const u = S.udpx, card = $('[data-c="udp"]');
  card.querySelector('b').textContent = u && !u.run && u.p ? pct(u.p.loss) : lastScores?.loss == null ? '–' : pct(lastScores.loss);
  const ub = $('#udpxBtn');
  ub.disabled = !!u?.run;
  ub.textContent = u?.run ? t('udpx_run') : u && !u.run ? (u.p ? t('udpx_done', { up: pct(u.p.up), down: pct(u.p.down), q: t('q_' + u.q) }) : t('udpx_na')) : t('udpx_btn');
  const ld = S.load, li = $('[data-s="load"]');
  const lb = $('#loadBtn');
  li.dataset.lv = ld?.done ? bloatLevel(ld.grade) || '' : '';
  li.querySelector('b').textContent = ld?.done ? (ld.grade ? `${ld.grade} · +${Math.round(ld.rise)} ms` : '–') : '–';
  lb.hidden = !!ld?.done;
  lb.disabled = !running() || !!ld;
  lb.textContent = ld && !ld.done ? t('load_run') : running() ? t('load_btn') : t('load_idle');
  li.querySelector('em').textContent = ld?.done ? t('load_v', { mb: Math.round(ld.bytes / 1e6), mbps: Math.round(ld.mbps) }) : ' ';
}
$('#loadBtn').onclick = startLoad;
$('#udpxBtn').onclick = startUdpx;

function resetLanes() {
  $$('.ln-tl').forEach((el) => { el.innerHTML = '<i></i>'.repeat(LANE_CELLS); });
  $$('.ln-st').forEach((el) => { el.textContent = t('st_none'); el.dataset.st = 'none'; el.dataset.tip = ''; });
  drawSvcLane();
}

// one cell per lane per window; its tooltip says when, how it was, and why. The lane's current numbers sit in the
// tooltip of its state word.
function drawLanes(sn, gap, now) {
  const laneName = (k) => $(`[data-lane="${k}"] .ln-k`).textContent;
  const group = (list) => {
    const off = list.filter((x) => x.status !== 'ok' && x.status !== 'none');
    return { st: groupStatus(list), now: list.map((x) => `${x.name} ${x.status === 'down' ? t('st_down') : ms0(x.med) + ' ms'}`).join('\n'), why: (off.length ? off : list).map((x) => `${x.name} ${x.status === 'down' ? t('st_down') : ms0(x.med) + ' ms'}${why(x)}`).join('\n') };
  };
  const dev = sn.lagP95 == null ? { st: 'none', now: '', why: '' } : { st: sn.lagP95 > 150 ? 'bad' : sn.lagP95 > 50 ? 'warn' : 'ok', now: t('ev_lag', { ms: ms0(sn.lagP95) }), why: t('ev_lag', { ms: ms0(sn.lagP95) }) };
  const fam = [sn.ipv4 && `IPv4 ${pct(sn.ipv4.lossPct)}`, sn.ipv6 && `IPv6 ${pct(sn.ipv6.lossPct)}`].filter(Boolean).join(' · ');
  const h3 = S.proto.n ? t(S.proto.h3 ? 'h3_yes' : 'h3_no') : '';
  const udpNow = sn.udp.browserOff ? t('udp_off') : sn.udp.lossPct == null ? '' : [sn.udp.status === 'down' ? t('ev_udp-blocked') : t('tip_udp_cell', { loss: pct(sn.udp.lossPct), ms: ms0(sn.udp.med) }), fam, h3].filter(Boolean).join('\n');
  const marks = S.marks.filter((x) => x.t > now - WINDOW_MS && x.t <= now).map(markText);
  const lanes = {
    device: { ...dev, why: [dev.why, ...marks].filter(Boolean).join('\n'), mk: marks.length > 0 },
    gw: sn.gw ? group([sn.gw]) : null, direct: group(sn.direct), near: group(sn.near), far: group(sn.far),
    udp: { st: sn.udp.status, now: udpNow, why: udpNow }, svc: group(sn.svc),
  };
  for (const [k, x] of Object.entries(lanes)) {
    const li = $(`[data-lane="${k}"]`);
    if (!x || !li || li.hidden) continue;
    const st = gap ? 'gap' : x.st;
    const s = li.querySelector('.ln-st');
    s.dataset.st = st; s.textContent = t('st_' + (st === 'gap' ? 'none' : st));
    s.dataset.tip = gap ? t('gap') : x.now || '';
    const cell = document.createElement('i');
    cell.dataset.st = st;
    if (x.mk) cell.dataset.mk = '1';
    cell.dataset.tip = `${hms(now - WINDOW_MS)}–${hms(now)} · ${laneName(k)} · ${t('st_' + (st === 'gap' ? 'gap' : st))}` + (gap ? '\n' + t('gap') : x.why ? '\n' + x.why : '');
    const tl = li.querySelector('.ln-tl');
    tl.append(cell);
    while (tl.children.length > LANE_CELLS) tl.firstChild.remove();
  }
}
const markText = (m) => t('mk_' + m.k, { detail: m.detail });

function drawIncidents() {
  const ol = $('#inc');
  const rows = [
    ...S.inc.list.map((x) => ({ t: x.start, x })),
    ...S.marks.map((m) => ({ t: m.t, m })),
  ].sort((a, b) => b.t - a.t).slice(0, 40);
  if (!rows.length) { ol.innerHTML = `<li class="m">${esc(t('inc_none'))}</li>`; return; }
  ol.innerHTML = rows.map(({ x, m }) => {
    if (m) return `<li data-lv="info"><span class="inc-t">${hms(m.t)}</span><span class="inc-v"><b>${esc(markText(m))}</b></span><span class="inc-c"></span></li>`;
    const names = (x.ids || []).map(nameIn).join(' / ');
    const ev = (x.evidence || [])[0];
    return `<li data-lv="bad"><span class="inc-t">${hms(x.start)}–${x.open ? esc(t('inc_open')) : hms(x.end)}</span><span class="inc-v"><b>${esc(t('v_' + x.key, { names }))}</b><small>${esc(ev ? evText(ev) : '')}</small></span><span class="inc-c">${esc(t('conf_' + x.conf))}</span></li>`;
  }).join('');
}

// the start button doubles as the clock: elapsed time, and its fill shows how far the run is
function tickButton() {
  const b = $('#go');
  if (!running()) {
    b.style.setProperty('--p', 0);
    $('#goT').textContent = t(S.windows.length ? 'again' : 'start');
    $('#goN').textContent = '';
    return;
  }
  const el = Date.now() - S.t0;
  b.style.setProperty('--p', Math.min(1, el / DURATION_MS)); // monitoring: full once past the 2 minutes
  $('#goT').textContent = t('stop');
  $('#goN').textContent = continuous() ? clock(el) : `${clock(el)} / ${clock(DURATION_MS)}`;
  setTimeout(tickButton, 1000 - (el % 1000));
}

// the tab title shows trouble while a run goes on in the background
const title0 = document.title;
function title(key) { document.title = running() && key !== 'ok' && key !== 'gap' ? '● ' + title0 : title0; }

function notify(inc) {
  if ($('#ntf').getAttribute('aria-pressed') !== 'true' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(t('n_title'), { body: t('v_' + inc.key, { names: (inc.ids || []).map(nameIn).join(' / ') }), tag: 'netdiag' }); } catch {}
}
$('#ntf').onclick = async () => {
  const b = $('#ntf');
  if (b.getAttribute('aria-pressed') === 'true') { b.setAttribute('aria-pressed', 'false'); return; }
  if (!('Notification' in window)) return;
  const p = Notification.permission === 'default' ? await Notification.requestPermission().catch(() => 'denied') : Notification.permission;
  b.setAttribute('aria-pressed', p === 'granted' ? 'true' : 'false');
};

// the mode: a 2-minute diagnosis or monitoring until Stop. Start and Stop run it; switching mid-run carries on
// in the new mode (back to diagnosis past 2 minutes: stops).
$$('[data-mode]').forEach((b) => {
  b.onclick = () => {
    S.sel = b.dataset.mode;
    $$('[data-mode]').forEach((x) => x.setAttribute('aria-checked', x === b));
    document.body.dataset.sel = S.sel;
    if (running() && !continuous() && Date.now() - S.t0 >= DURATION_MS) finish();
    else if (!running() && !S.last) verdict({ key: 'idle' });
  };
});

$('#go').onclick = begin;
drawServices();
resetLanes(); // empty cells from the start, so the lanes look the same before and during a run
drawExtras();

// for the site's "report a problem" dialog: the last verdict and window states, no IP
window.msReport = () => {
  const v = S.last;
  return v ? { summary: t('v_' + v.key, { names: (v.ids || []).join(' / ') }), data: { mode: S.sel, s: Math.round((Date.now() - S.t0) / 1000), proxied: S.proxied, colo: S.meta?.colo, v: v.key, conf: v.conf, gw: !!S.gw, load: S.load?.grade ?? null, incidents: S.inc.list.slice(0, 5).map((x) => ({ key: x.key, s: Math.round((x.end - x.start) / 1000) })) } } : null;
};
window.netdiag = S; // for scripted checks (test rigs)

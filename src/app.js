// Network Diagnosis: the page. The worker (worker-probe.js) keeps the schedule and runs the HTTPS probes; this file
// runs STUN when told, judges every 5-second window with src/lib.mjs, and draws the verdict, the lanes and the log.
// A run lasts DURATION_MS (a first verdict at PRELIM_MS); with "keep monitoring" on it goes on until Stop.
import { NEAR, META, DIRECT, FAR, SERVICES, STUN, STUN_DIRECT } from './targets.mjs';
import { stun, stunOverhead, meta } from './probes.mjs';
import {
  WINDOW_MS, windowStats, statusOf, udpStatusOf, stunLoss, attribute, mos, mosLevel, gaming, pageLevel, Incidents, confidence,
  proxyHint, tzCountry, median, RETX,
} from './lib.mjs';

const L = window.L1MS, D = JSON.parse(document.getElementById('data').textContent);
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (k, v) => { let s = L[k]; if (s == null) return k; if (v) s = String(s).replace(/\{(\w+)\}/g, (m, x) => (v[x] ?? m)); return s; };
const nameOf = (n) => (typeof n === 'string' ? n : n[D.lang] || n.other);
const ms0 = (x) => (x == null ? '–' : Math.round(x));
const zh = D.lang.startsWith('zh');
const SEP = zh ? '；' : '; ', PAREN = zh ? ['（', '）'] : [' (', ')'], AND = zh ? '、' : ', ';
const K = { theme: 'netdiag:theme', lang: 'netdiag:lang', svcs: 'netdiag:svcs', custom: 'netdiag:custom' };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hms = (ms) => new Date(ms).toLocaleTimeString(D.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- theme, language, dialogs (synced across the 1ms.dog tools) ---------- */
const thBtn = $('#theme'), TH = ['system', 'light', 'dark'];
function applyTheme(th) {
  if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme');
  thBtn.dataset.th = th;
}
thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set(K.theme, n); applyTheme(n); };
applyTheme(TH.includes(store.get(K.theme)) ? store.get(K.theme) : 'system');
$('#lang').onchange = (e) => { const l = e.target.value; store.set(K.lang, l); location.href = D.paths[l] + location.search; };
function openDlg(id) { $('#' + id).hidden = false; document.documentElement.style.overflow = 'hidden'; $('#' + id + ' [data-close]').focus(); }
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

/* ---------- tooltips: hover with a mouse, tap on a touch screen ---------- */
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
  const y = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() { tip.hidden = true; tipEl = null; }
document.addEventListener('pointerover', (e) => { if (e.pointerType !== 'mouse') return; const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip) showTip(el); });
document.addEventListener('pointerout', (e) => { if (e.pointerType === 'mouse' && tipEl && !tipEl.contains(e.relatedTarget)) hideTip(); });
document.addEventListener('click', (e) => { const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip && tipEl !== el) showTip(el); else if (!e.target.closest('.tip')) hideTip(); });
document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el && el.dataset.tip) showTip(el); });
document.addEventListener('focusout', hideTip);
addEventListener('scroll', hideTip, { passive: true });

/* ---------- services: the built-in list plus the visitor's own, kept in this browser ---------- */
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
let custom = (() => { try { const v = JSON.parse(store.get(K.custom)); return Array.isArray(v) ? v.filter((s) => s && s.id && s.url) : []; } catch { return []; } })();
let picked = (() => { try { const v = JSON.parse(store.get(K.svcs)); if (Array.isArray(v)) return new Set(v); } catch {} return new Set(SERVICES.filter((s) => s.on).map((s) => s.id)); })();
const services = () => [...SERVICES, ...custom];
const saveSvcs = () => { store.set(K.svcs, JSON.stringify([...picked])); store.set(K.custom, JSON.stringify(custom)); };
// the site's own icon; a letter when it has none
const icon = (s) => `<span class="fav" data-l="${esc((s.name || '?').slice(0, 1).toUpperCase())}"><img src="https://${esc(hostOf(s.url))}/favicon.ico" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer"></span>`;
// the letter shows until the icon has loaded, and stays when there is none
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
    b.onclick = () => { const id = b.dataset.svc; if (picked.has(id)) picked.delete(id); else picked.add(id); saveSvcs(); b.setAttribute('aria-pressed', picked.has(id)); drawSvcSummary(); };
  });
  $$('#svcList [data-rm]').forEach((b) => {
    b.onclick = () => { custom = custom.filter((s) => s.id !== b.dataset.rm); picked.delete(b.dataset.rm); saveSvcs(); drawServices(); };
  });
  drawSvcSummary();
}
function drawSvcSummary() {
  const on = services().filter((s) => picked.has(s.id));
  $('#svcSum').innerHTML = on.map((s) => icon(s)).join('') + `<span${on.length ? '' : ' class="m"'}>${esc(on.map((s) => s.name).join(AND) || t('svc_none'))}</span>`;
  wireIcons($('#svcSum'));
}
// the best of 3 tries, or null when the site never answers
async function bestOf(url) {
  let best = null;
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4000), t0 = performance.now();
    try {
      await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Math.random().toString(36).slice(2), { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      const ms = performance.now() - t0;
      best = best == null ? ms : Math.min(best, ms);
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
  if (services().some((s) => cands.includes(s.url))) { picked.add(services().find((s) => cands.includes(s.url)).id); saveSvcs(); $('#svcIn').value = ''; drawServices(); return; }
  msg.dataset.k = ''; msg.textContent = t('svc_checking');
  $('#svcForm button').disabled = true;
  const times = await Promise.all(cands.map(bestOf));
  $('#svcForm button').disabled = false;
  const i = times.reduce((b, ms, j) => (ms != null && (b < 0 || ms < times[b]) ? j : b), -1);
  if (i < 0) { msg.dataset.k = 'err'; msg.textContent = t('svc_dead', { host: u.hostname }); return; }
  const url = cands[i], host = hostOf(url);
  const id = 'c:' + host;
  if (!services().some((s) => s.id === id)) custom.push({ id, name: host.replace(/^www\./, ''), url });
  picked.add(id);
  saveSvcs();
  msg.textContent = '';
  $('#svcIn').value = '';
  drawServices();
};
$('#svcBtn').onclick = () => openDlg('svcs');
drawServices();

/* ---------- the run ---------- */
const PRELIM_MS = 20000, DURATION_MS = 120000, LANE_CELLS = 72; // the lanes show 6 minutes of 5-second windows
const S = { mode: 'idle', t0: 0, targets: [], stuns: [], overhead: 0, meta: null, home: null, cn: false, proxied: false, setups: [], windows: [], inc: new Incidents(), worker: null, stunI: 0, lag: null, fast: true, last: null };
const running = () => S.mode === 'run';
const continuous = () => $('#mon').checked;

function plan(fast) {
  const near = fast ? 500 : 1000, slow = fast ? 2000 : 5000;
  return S.targets.map((tg) => ({ id: tg.key, url: tg.url, every: tg.group === 'near' || tg.group === 'direct' ? near : slow }));
}
function startWorker(fast) {
  S.fast = fast;
  S.worker.postMessage({ cmd: 'start', plan: plan(fast), stunEvery: fast ? 500 : 1000, window: WINDOW_MS });
}

async function begin() {
  if (running()) { finish(); return; }
  hideTip();
  Object.assign(S, { mode: 'run', t0: Date.now(), setups: [], windows: [], inc: new Incidents(), stunI: 0, lag: null, last: null });
  document.body.dataset.run = 'on';
  $('#incC').hidden = false;
  resetLanes();
  drawIncidents();
  verdict({ key: 'running' });
  tickButton();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  S.home = tzCountry(tz);
  // Cloudflare's view of the exit, and the browser's own STUN overhead, before the first window closes
  const [m, oh] = await Promise.all([meta(META), stunOverhead().catch(() => 0)]);
  if (!running()) return; // stopped while asking
  S.meta = m; S.overhead = oh;
  const hint = proxyHint({ tz, exitCountry: m?.country });
  S.cn = S.home === 'CN' || m?.country === 'CN';
  S.proxied = !!hint && S.cn;
  S.exit = [m && t('info_exit', { org: m.org || 'AS' + m.asn, colo: m.colo || '?' }), hint && t('info_proxy', { home: region(hint.home), exit: region(hint.exit) })].filter(Boolean).join(' · ');
  // the nearest location gets an absolute bar only where it should be near (not from mainland China: it is abroad)
  const cn = S.cn;
  S.targets = [
    { key: 'near:cf', id: NEAR.id, name: NEAR.name, url: NEAR.url, group: 'near', near: !cn && !hint, samples: [], floor: null },
    ...(cn ? DIRECT.CN : []).map((d) => ({ key: 'direct:' + d.id, id: d.id, name: nameOf(d.name), url: d.url, group: 'direct', near: true, samples: [], floor: null })),
    ...FAR.map((f) => ({ key: 'far:' + f.id, id: f.id, name: t('far_' + f.id), url: f.url, group: 'far', near: false, samples: [], floor: null })),
    ...services().filter((s) => picked.has(s.id)).map((s) => ({ key: 'svc:' + s.id, id: s.id, name: s.name, url: s.url, group: 'svc', near: false, samples: [], floor: null })),
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
  startWorker(true);
}

function region(cc) {
  if (cc === 'TW') return { 'zh-CN': '中国台湾', 'zh-TW': '中國台灣' }[D.lang] || 'Taiwan, China';
  try { return new Intl.DisplayNames([D.lang], { type: 'region' }).of(cc); } catch { return cc; }
}

function onWorker({ data: m }) {
  if (!running()) return;
  if (m.type === 'sample') {
    const tg = S.targets.find((x) => x.key === m.id);
    if (!tg) return;
    tg.samples.push({ t: m.t, ms: m.ms });
    if (m.setup != null && tg.group === 'near') S.setups.push(m.setup);
    if (m.cold && m.ms != null) tg.coldMs = m.ms; // without readable timing, setup ≈ the first request less a warm one
    if (tg.samples.length > 4000) tg.samples.splice(0, 2000);
  } else if (m.type === 'stun') {
    if (!S.stuns.length) return;
    const s = S.stuns[S.stunI++ % S.stuns.length];
    if (s.busy) return;
    s.busy = true;
    stun(s.url).then((r) => {
      s.busy = false;
      s.probes.push({ t: Date.now(), answers: r.answers.map((x) => Math.max(0, x - S.overhead)), hosts: r.hosts });
      if (s.probes.length > 4000) s.probes.splice(0, 2000);
    });
  } else if (m.type === 'tick') {
    S.lag = m.lag;
    onWindow(m.t);
  }
}

// ---------- judging ----------
const isBad = (s) => s === 'bad' || s === 'down';
function groupStatus(list) {
  const st = list.map((x) => x.status).filter((s) => s !== 'none');
  if (!st.length) return 'none';
  const bad = st.filter(isBad).length;
  if (bad / st.length >= 0.5) return st.every((s) => s === 'down') ? 'down' : 'bad';
  return bad || st.includes('warn') ? 'warn' : 'ok';
}

// The state of every target, UDP and the device over [from, to]. Each target's floor is its best window so far.
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
  const us = S.stuns.map((s) => ({ id: s.id, ref: s.ref, ...stunLoss(s.probes.filter((p) => p.t > ufrom && p.t <= to)) }));
  const usSt = us.map((u) => ({ ...u, ...udpStatusOf(u) }));
  const measured = usSt.filter((u) => u.status !== 'none');
  const ref = usSt.find((u) => u.ref);
  const near = byG('near')[0];
  const local = S.cn && !S.proxied; // see judge()
  return {
    near: local ? byG('direct') : byG('near'), direct: local ? [] : byG('direct'), far: local ? [...byG('far'), ...byG('near')] : byG('far'), svc: byG('svc'),
    udp: { status: groupStatus(measured), lossPct: measured.length ? median(measured.map((u) => u.lossPct ?? 0)) : null, med: ref?.med ?? null },
    tcpRef: near?.med ?? null, udpRef: ref?.med ?? null,
    lagP95: document.visibilityState === 'hidden' ? null : S.lag,
  };
}

// From mainland China without a proxy the nearest Cloudflare location is abroad: domestic sites are the near
// reference and Cloudflare joins the distant paths (done in snapshot()).
function judge(sn, early = false) {
  const v = attribute({
    online: navigator.onLine, hidden: false, lagP95: sn.lagP95, proxied: S.proxied, udp: sn.udp, tcpRef: sn.tcpRef, udpRef: sn.udpRef,
    near: sn.near, far: sn.far, direct: sn.direct,
    // A service counts as worse on jitter alone only over a long stretch. Early on its "best so far" is a single
    // lucky answer, so only timeouts count (a proxied service at 230 ms ± 50 read as "worse").
    svc: sn.svc.map((x) => {
      if (!isBad(x.status)) return x;
      if (early) return x.status === 'down' || x.why?.includes('timeouts') ? x : { ...x, status: 'warn' };
      return x.why?.length === 1 && x.why[0] === 'jitter' ? { ...x, status: 'warn' } : x;
    }),
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
  if (S.fast && elapsed >= PRELIM_MS) startWorker(false); // the first 20 s ask twice as often
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
  if (!gap && elapsed >= PRELIM_MS) {
    const ev = S.inc.feed(now, v);
    if (ev === 'opened') notify(S.inc.list[0]);
    if (ev || S.inc.cur) drawIncidents();
  }
  // the headline: the run so far (from 20 s on), or the last minute once a monitored run passes 2 minutes
  if (elapsed >= PRELIM_MS) {
    const from = elapsed <= DURATION_MS ? S.t0 + 1500 : now - 60000;
    const span = snapshot(from, now, { updateFloor: false, span: true });
    const hv = judge(span, elapsed < 60000);
    hv.conf = confidence(hv.conf, elapsed >= DURATION_MS ? 6 : 2);
    S.last = hv;
    verdict(hv, span, spanScores(elapsed <= DURATION_MS ? S.t0 : now - 10 * 60000, now), elapsed < DURATION_MS ? 'prelim' : 'final');
  }
  mark(v.key);
  if (elapsed >= DURATION_MS && !continuous()) finish();
}

function finish() {
  S.worker?.postMessage({ cmd: 'stop' });
  S.worker?.terminate();
  S.worker = null;
  const had = S.last;
  S.mode = 'done';
  document.body.dataset.run = '';
  tickButton();
  if (had) $('#vState').textContent = t('st_final', { t: clock(Date.now() - S.t0) });
  else verdict({ key: 'idle' });
  mark('ok');
}

// scores over [from, to]: calls (MOS), games (hiccups), web pages (connection setup)
function spanScores(from, to) {
  from = Math.max(from, S.t0 + 1500);
  // the visitor's own line: domestic sites in mainland China, the nearest Cloudflare location elsewhere
  const near = S.targets.find((x) => x.group === (S.cn ? 'direct' : 'near')) || S.targets[0];
  const ss = near ? near.samples.filter((s, i) => s.t > from && s.t <= to && i >= 2 && s.ms != null).map((s) => s.ms) : [];
  const floor = near?.floor ?? (ss.length ? Math.min(...ss) : null);
  const w = windowStats(ss.map((ms) => ({ ms })));
  const ref = S.stuns.find((s) => s.ref) || S.stuns[0];
  const probes = ref ? ref.probes.filter((p) => p.t > from && p.t <= to) : [];
  const u = ref ? stunLoss(probes) : null;
  let retx = 0;
  if (u && u.base != null) for (const p of probes) for (const a of p.answers) if (a - u.base > RETX[1] - 60) retx++;
  const spikes = (floor == null ? 0 : ss.filter((x) => x > floor + 100).length) + retx;
  const minutes = (to - from) / 60000;
  const cf = S.targets.find((x) => x.group === 'near');
  const warm = cf ? median(cf.samples.filter((s, i) => i >= 2 && s.ms != null).map((s) => s.ms)) : null;
  // under 5 ms: the browser reused a connection it already had, so there was nothing to set up
  const est = S.setups.length ? median(S.setups) : cf?.coldMs != null && warm != null ? cf.coldMs - warm : null;
  return {
    call: mos(u?.med ?? w.med, w.jitter, u?.lossPct ?? 0), game: gaming({ spikes, minutes, loss: u?.lossPct ?? 0, jitter: w.jitter ?? 0 }),
    spikes, minutes, setup: est != null && est >= 5 ? est : null, nearMed: w.med, jitter: w.jitter, loss: u?.lossPct ?? null,
  };
}

/* ---------- drawing ---------- */
const why = (x) => (x.why?.length ? PAREN[0] + x.why.map((w) => t('why_' + w)).join(AND) + PAREN[1] : '');
const listOf = (items) => items.map((x) => `${x.name ?? x.id} ${ms0(x.med)} ms${why(x)}`).join(SEP);
const LEVEL = { ok: 'ok', 'udp-slow': 'warn', unknown: 'warn', hidden: 'warn', running: 'run', idle: 'idle' };

function verdict(v, sn, sc, state) {
  const box = $('#verdict');
  box.dataset.lv = LEVEL[v.key] || 'bad';
  if (v.key === 'idle' || v.key === 'running') {
    $('#vH').textContent = t(v.key === 'idle' ? 'v_idle' : 'v_running');
    $('#vState').textContent = v.key === 'running' ? t('st_measuring') : ' ';
    $('#vExit').textContent = (v.key === 'running' && S.exit) || '';
    $('#ev').innerHTML = '';
    $('#sugL').innerHTML = '';
    $('#sug').dataset.on = '';
    if (v.key === 'idle') clearNumbers();
    return;
  }
  const nameIn = (id) => S.targets.find((x) => x.id === id)?.name || id;
  $('#vH').textContent = t('v_' + v.key, { names: (v.ids || []).map(nameIn).join(' / ') });
  $('#vState').textContent = (state === 'prelim' ? t('st_prelim') : t('st_final', { t: clock(Date.now() - S.t0) })) + ' · ' + t('conf_' + (v.conf || 1));
  $('#vExit').textContent = S.exit || '';
  const named = (arr) => (arr || []).map((x) => ({ ...x, name: nameIn(x.id) }));
  $('#ev').innerHTML = (v.evidence || []).slice(0, 4).map((e) => {
    if (e.k === 'udp-loss') return `<li>${esc(e.status === 'down' ? t('ev_udp-blocked') : t('ev_udp-loss', { loss: (e.lossPct ?? 0).toFixed(1) }))}</li>`;
    return `<li>${esc(t('ev_' + e.k, { list: listOf(named(e.near || e.far || e.direct || e.svc)), n: e.n, udp: e.udp, tcp: e.tcp, ms: e.ms }))}</li>`;
  }).join('');
  const sug = L['s_' + v.key] || [];
  $('#sug').dataset.on = sug.length ? '1' : '';
  $('#sugL').innerHTML = sug.map((s) => `<li>${esc(s)}</li>`).join('');
  if (sn && sc) numbers(sc);
}

function clearNumbers() {
  $$('.nums b').forEach((b) => { b.textContent = '–'; });
  $$('.fit li').forEach((li) => { li.dataset.lv = ''; li.querySelector('b').textContent = '–'; li.querySelector('em').textContent = ' '; });
}
function numbers(sc) {
  $('[data-c="near"] b').textContent = sc.nearMed == null ? '–' : Math.round(sc.nearMed) + ' ms';
  $('[data-c="jitter"] b').textContent = sc.jitter == null ? '–' : sc.jitter.toFixed(1) + ' ms';
  $('[data-c="udp"] b').textContent = sc.loss == null ? '–' : sc.loss.toFixed(1) + '%';
  const put = (k, lv, detail) => {
    const li = $(`[data-s="${k}"]`);
    li.dataset.lv = lv || '';
    li.querySelector('b').textContent = lv ? t('lv_' + lv) : '–';
    li.querySelector('em').textContent = detail || ' ';
  };
  put('call', mosLevel(sc.call), sc.call == null ? '' : t('sc_call_v', { v: sc.call.toFixed(1) }));
  // a short stretch: the count itself, over how long it was measured (20 s scaled up to 10 minutes says little)
  const span = sc.minutes < 1 ? t('dur_s', { n: Math.round(sc.minutes * 60) }) : t('dur_m', { n: Math.round(sc.minutes) });
  put('game', sc.game?.level ?? null, !sc.game ? '' : sc.minutes < 5 ? t('sc_game_q', { n: sc.spikes, span }) : t('sc_game_v', { n: Math.round(sc.game.per10) }));
  put('page', pageLevel(sc.setup), sc.setup == null ? t('sc_page_na') : t('sc_page_v', { ms: Math.round(sc.setup) }));
}

function resetLanes() {
  $$('.ln-tl').forEach((el) => { el.innerHTML = '<i></i>'.repeat(LANE_CELLS); });
  $$('.ln-st').forEach((el) => { el.textContent = t('st_none'); el.dataset.st = 'none'; });
  $$('.ln-v').forEach((el) => { el.textContent = ' '; });
}

// one cell per lane per window; its tooltip says when, how it was, and why
function drawLanes(sn, gap, now) {
  const laneName = (k) => $(`[data-lane="${k}"] .ln-k`).textContent;
  const group = (list) => {
    const st = groupStatus(list);
    const off = list.filter((x) => x.status === 'bad' || x.status === 'down' || x.status === 'warn');
    return { st, v: list.map((x) => `${x.name} ${ms0(x.med)}`).join(' · '), why: (off.length ? off : list).map((x) => `${x.name} ${x.status === 'down' ? t('st_down') : ms0(x.med) + ' ms'}${why(x)}`).join('\n') };
  };
  const dev = sn.lagP95 == null ? { st: 'none', v: '', why: '' } : { st: sn.lagP95 > 150 ? 'bad' : sn.lagP95 > 50 ? 'warn' : 'ok', v: ms0(sn.lagP95) + ' ms', why: t('ev_lag', { ms: ms0(sn.lagP95) }) };
  const udp = sn.udp.lossPct == null ? { st: sn.udp.status, v: '', why: '' } : { st: sn.udp.status, v: `${sn.udp.lossPct.toFixed(1)}% · ${ms0(sn.udp.med)} ms`, why: sn.udp.status === 'down' ? t('ev_udp-blocked') : t('tip_udp_cell', { loss: sn.udp.lossPct.toFixed(1), ms: ms0(sn.udp.med) }) };
  // services read the same way as in the verdict: jitter alone is "so-so", not "worse"
  const svc = group(sn.svc.map((x) => (x.status === 'bad' && x.why?.length === 1 && x.why[0] === 'jitter' ? { ...x, status: 'warn' } : x)));
  const lanes = { device: dev, direct: group(sn.direct), near: group(sn.near), far: group(sn.far), udp, svc: { ...svc, v: sn.svc.filter((x) => isBad(x.status)).map((x) => x.name).join(' · ') || (sn.svc.length ? t('svc_all_ok', { n: sn.svc.length }) : '') } };
  for (const [k, x] of Object.entries(lanes)) {
    const li = $(`[data-lane="${k}"]`);
    if (!li || li.hidden) continue;
    const st = gap ? 'gap' : x.st;
    const s = li.querySelector('.ln-st');
    s.dataset.st = st; s.textContent = t('st_' + (st === 'gap' ? 'none' : st));
    li.querySelector('.ln-v').textContent = gap ? ' ' : x.v || ' ';
    const cell = document.createElement('i');
    cell.dataset.st = st;
    cell.dataset.tip = `${hms(now - WINDOW_MS)}–${hms(now)} · ${laneName(k)} · ${t('st_' + (st === 'gap' ? 'gap' : st))}` + (gap ? '\n' + t('gap') : x.why ? '\n' + x.why : '');
    const tl = li.querySelector('.ln-tl');
    tl.append(cell);
    while (tl.children.length > LANE_CELLS) tl.firstChild.remove();
  }
}

function drawIncidents() {
  const ol = $('#inc');
  if (!S.inc.list.length) { ol.innerHTML = `<li class="m">${esc(t('inc_none'))}</li>`; return; }
  ol.innerHTML = S.inc.list.slice(0, 30).map((x) => {
    const names = (x.ids || []).map((id) => S.targets.find((y) => y.id === id)?.name || id).join(' / ');
    const ev = (x.evidence || [])[0];
    const detail = ev && ev.k !== 'udp-loss' ? t('ev_' + ev.k, { list: listOf((ev.near || ev.far || ev.direct || ev.svc || []).map((y) => ({ ...y, name: S.targets.find((z) => z.id === y.id)?.name || y.id }))), n: ev.n, udp: ev.udp, tcp: ev.tcp, ms: ev.ms }) : ev ? t('ev_udp-loss', { loss: (ev.lossPct ?? 0).toFixed(1) }) : '';
    return `<li data-lv="bad"><span class="inc-t">${hms(x.start)}–${x.open ? esc(t('inc_open')) : hms(x.end)}</span><span class="inc-v"><b>${esc(t('v_' + x.key, { names }))}</b><small>${esc(detail)}</small></span><span class="inc-c">${esc(t('conf_' + x.conf))}</span></li>`;
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
  const mon = continuous() && el >= DURATION_MS;
  b.style.setProperty('--p', Math.min(1, el / DURATION_MS));
  $('#goT').textContent = t('stop');
  $('#goN').textContent = mon ? clock(el) : `${clock(el)} / ${clock(DURATION_MS)}`;
  setTimeout(tickButton, 1000 - (el % 1000));
}

// the tab title shows trouble while a run goes on in the background
const title0 = document.title;
function mark(key) { document.title = running() && key !== 'ok' && key !== 'gap' ? '● ' + title0 : title0; }

function notify(inc) {
  if (!$('#ntf').checked || !('Notification' in window) || Notification.permission !== 'granted') return;
  const names = (inc.ids || []).map((id) => S.targets.find((y) => y.id === id)?.name || id).join(' / ');
  try { new Notification(t('n_title'), { body: t('v_' + inc.key, { names }), tag: 'netdiag' }); } catch {}
}
$('#ntf').onchange = async (e) => {
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
    const p = await Notification.requestPermission().catch(() => 'denied');
    if (p !== 'granted') e.target.checked = false;
  }
};
// keep monitoring: only decides whether a run stops at 2 minutes; Start and Stop do the rest
$('#mon').checked = false;
$('#mon').onchange = () => {
  document.body.dataset.mon = continuous() ? 'on' : '';
  if (running() && !continuous() && Date.now() - S.t0 >= DURATION_MS) finish();
};

$('#go').onclick = begin;
resetLanes(); // empty cells from the start, so the lanes look the same before and during a run

// for the site's "report a problem" dialog: the last verdict and window states, no IP
window.msReport = () => {
  const v = S.last;
  return v ? { summary: t('v_' + v.key, { names: (v.ids || []).join(' / ') }), data: { mode: S.mode, s: Math.round((Date.now() - S.t0) / 1000), proxied: S.proxied, colo: S.meta?.colo, v: v.key, conf: v.conf, incidents: S.inc.list.slice(0, 5).map((x) => ({ key: x.key, s: Math.round((x.end - x.start) / 1000) })) } } : null;
};
window.netdiag = S; // for scripted checks (test rigs)

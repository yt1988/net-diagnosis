// Network Diagnosis: the page. The worker (worker-probe.js) keeps the schedule and runs the HTTPS probes; this file
// runs STUN when told, judges every 5-second window with src/lib.mjs, and draws the verdict, the lanes and the log.
import { NEAR, META, DIRECT, FAR, SERVICES, STUN, STUN_DIRECT } from './targets.mjs';
import { stun, stunOverhead, meta } from './probes.mjs';
import {
  WINDOW_MS, windowStats, statusOf, udpStatusOf, stunLoss, attribute, mos, mosLevel, gaming, pageLevel, Incidents, confidence,
  proxyHint, tzCountry, median, quantile, RETX,
} from './lib.mjs';

const L = window.L1MS, D = JSON.parse(document.getElementById('data').textContent);
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (k, v) => { let s = L[k]; if (s == null) return k; if (v) s = String(s).replace(/\{(\w+)\}/g, (m, x) => (v[x] ?? m)); return s; };
const nameOf = (n) => (typeof n === 'string' ? n : n[D.lang] || n.other);
const ms0 = (x) => (x == null ? '–' : Math.round(x));
const K = { theme: 'netdiag:theme', lang: 'netdiag:lang', svcs: 'netdiag:svcs', mon: 'netdiag:monitor' };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

/* ---------- theme, language, help (synced across the 1ms.dog tools) ---------- */
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDlg(); });
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

/* ---------- services the visitor follows ---------- */
let picked = (() => { try { const v = JSON.parse(store.get(K.svcs)); if (Array.isArray(v)) return new Set(v); } catch {} return new Set(SERVICES.filter((s) => s.on).map((s) => s.id)); })();
function drawServices() {
  $('#svcs').innerHTML = SERVICES.map((s) => `<button type="button" class="chip" data-svc="${s.id}" aria-pressed="${picked.has(s.id)}">${esc(s.name)}</button>`).join('');
  $$('#svcs [data-svc]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.svc;
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      store.set(K.svcs, JSON.stringify([...picked]));
      b.setAttribute('aria-pressed', picked.has(id));
    };
  });
}
drawServices();

/* ---------- the run ---------- */
const QUICK_MS = 20000, LANE_CELLS = 72; // 6 minutes of 5-second windows on screen
const S = { mode: 'idle', t0: 0, quickEnd: 0, targets: [], stuns: [], overhead: 0, meta: null, home: null, proxied: false, setups: [], windows: [], inc: new Incidents(), worker: null, stunI: 0, lag: null };

function plan(quick) {
  const near = quick ? 500 : 1000, slow = quick ? 2000 : 5000;
  return S.targets.map((tg) => ({ id: tg.key, url: tg.url, every: tg.group === 'near' || tg.group === 'direct' ? near : slow }));
}

async function begin() {
  if (S.mode === 'quick' || S.mode === 'monitor') { finish(true); return; }
  Object.assign(S, { mode: 'quick', t0: Date.now(), quickEnd: Date.now() + QUICK_MS, setups: [], windows: [], inc: new Incidents(), stunI: 0, lag: null });
  document.body.dataset.run = 'on';
  $('#goT').textContent = t('stop');
  verdict({ key: 'running' });
  resetLanes();
  drawIncidents();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  S.home = tzCountry(tz);
  // Cloudflare's view of the exit, and the browser's own STUN overhead, before the first window closes
  const [m, oh] = await Promise.all([meta(META), stunOverhead().catch(() => 0)]);
  S.meta = m; S.overhead = oh;
  const hint = proxyHint({ tz, exitCountry: m?.country });
  const cn = S.home === 'CN' || m?.country === 'CN';
  S.proxied = !!hint && cn;
  S.cn = cn;
  $('#info').textContent = [m && t('info_exit', { org: m.org || ('AS' + m.asn), colo: m.colo || '?' }), hint && t('info_proxy', { home: region(hint.home), exit: region(hint.exit) })].filter(Boolean).join(' · ') || ' ';
  // near location: an absolute bar only where it should be near (not from mainland China, where it is abroad)
  S.targets = [
    { key: 'near:cf', id: NEAR.id, name: NEAR.name, url: NEAR.url, group: 'near', near: !cn && !hint, samples: [], floor: null },
    ...(cn ? DIRECT.CN : []).map((d) => ({ key: 'direct:' + d.id, id: d.id, name: nameOf(d.name), url: d.url, group: 'direct', near: true, samples: [], floor: null })),
    ...FAR.map((f) => ({ key: 'far:' + f.id, id: f.id, name: t('far_' + f.id), url: f.url, group: 'far', near: false, samples: [], floor: null })),
    ...SERVICES.filter((s) => picked.has(s.id)).map((s) => ({ key: 'svc:' + s.id, id: s.id, name: s.name, url: s.url, group: 'svc', near: false, samples: [], floor: null })),
  ];
  S.stuns = [...STUN, ...(cn ? STUN_DIRECT.CN : [])].map((s) => ({ ...s, probes: [] }));
  // lanes: with a proxy in mainland China, domestic sites get their own lane and "nearby" is the proxy server;
  // without one, domestic sites are the nearby lane and Cloudflare (abroad) joins the distant one
  $('[data-lane="direct"]').hidden = !(cn && S.proxied);
  const nearKey = cn ? (S.proxied ? 'near_proxy' : 'direct') : 'near';
  $('[data-lane="near"] .ln-k').textContent = t('lane_' + nearKey);
  $('[data-lane="near"] .ln-k').title = t('lane_tip_' + nearKey);
  if (S.mode !== 'quick') return; // stopped while asking
  S.worker = new Worker(D.worker);
  S.worker.onmessage = onWorker;
  S.worker.postMessage({ cmd: 'start', plan: plan(true), stunEvery: 500, window: WINDOW_MS });
  tickProgress();
}

function region(cc) {
  if (cc === 'TW') return { 'zh-CN': '中国台湾', 'zh-TW': '中國台灣' }[D.lang] || 'Taiwan, China';
  try { return new Intl.DisplayNames([D.lang], { type: 'region' }).of(cc); } catch { return cc; }
}

function onWorker({ data: m }) {
  if (m.type === 'sample') {
    const tg = S.targets.find((x) => x.key === m.id);
    if (!tg) return;
    tg.samples.push({ t: m.t, ms: m.ms, cold: m.cold });
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
function snapshot(from, to, { updateFloor = true } = {}) {
  const tgs = S.targets.map((tg) => {
    // distant paths and services are asked every 5 s while monitoring: one answer per window says too little, so
    // they are judged over the last 30 s. The first two answers on a new connection run slow (it is still warming
    // up): left out.
    const f = S.mode === 'monitor' && (tg.group === 'far' || tg.group === 'svc') ? Math.min(from, to - 30000) : from;
    const ss = tg.samples.filter((s, i) => s.t > f && s.t <= to && i >= 2);
    const w = windowStats(ss);
    if (updateFloor && w.min != null) tg.floor = tg.floor == null ? w.min : Math.min(tg.floor, w.min);
    return { key: tg.key, id: tg.id, name: tg.name, group: tg.group, ...w, ...statusOf(w, { floor: tg.floor, near: tg.near }) };
  });
  const byG = (g) => tgs.filter((x) => x.group === g);
  // UDP over the last minute (or the whole quick run): enough answers to read a loss rate
  const ufrom = Math.max(S.t0, to - 60000);
  const us = S.stuns.map((s) => ({ id: s.id, ref: s.ref, ...stunLoss(s.probes.filter((p) => p.t > ufrom && p.t <= to)) }));
  const usSt = us.map((u) => ({ ...u, ...udpStatusOf(u) }));
  const measured = usSt.filter((u) => u.status !== 'none');
  const udpStatus = groupStatus(measured);
  const loss = measured.length ? median(measured.map((u) => u.lossPct ?? 0)) : null;
  const ref = usSt.find((u) => u.ref);
  const near = byG('near')[0];
  const local = S.cn && !S.proxied; // see judge()
  return {
    tgs, near: local ? byG('direct') : byG('near'), direct: local ? [] : byG('direct'), far: local ? [...byG('far'), ...byG('near')] : byG('far'), svc: byG('svc'), udps: usSt,
    udp: { status: udpStatus, lossPct: loss, med: ref?.med ?? null },
    tcpRef: near?.med ?? null, udpRef: ref?.med ?? null,
    lagP95: document.visibilityState === 'hidden' ? null : S.lag,
  };
}

// From mainland China without a proxy the nearest Cloudflare location is abroad: domestic sites are the near
// reference and Cloudflare joins the distant paths.
function judge(sn, quick = false) {
  const v = attribute({
    online: navigator.onLine, hidden: false, lagP95: sn.lagP95, proxied: S.proxied, udp: sn.udp, tcpRef: sn.tcpRef, udpRef: sn.udpRef,
    near: sn.near, far: sn.far, direct: sn.direct,
    // A service counts as worse on jitter alone only while monitoring. In a 20-second run its "best so far" is a
    // single lucky answer, so there only timeouts count (a proxied service at 230 ms ± 50 read as "worse").
    svc: sn.svc.map((x) => {
      if (!isBad(x.status)) return x;
      if (quick) return x.status === 'down' || x.why?.includes('timeouts') ? x : { ...x, status: 'warn' };
      return x.why?.length === 1 && x.why[0] === 'jitter' ? { ...x, status: 'warn' } : x;
    }),
  });
  if (v.key === 'service') {
    // slower but answering: medium at most; timeouts or nothing at all can be sure
    const hard = sn.svc.concat(sn.near, sn.direct).some((x) => v.ids?.includes(x.id) && (x.status === 'down' || x.why?.includes('timeouts')));
    if (quick || !hard) v.conf = Math.min(v.conf, 2);
  }
  return v;
}

function onWindow(now) {
  if (S.mode !== 'quick' && S.mode !== 'monitor') return;
  const sn = snapshot(now - WINDOW_MS, now);
  // a window the page slept through (too few answers from the nearest location) is a gap, not a verdict
  const gap = (sn.near[0]?.n ?? 0) < 2 && S.mode === 'monitor';
  const v = gap ? { key: 'gap', conf: 0, evidence: [] } : judge(sn);
  const prev = S.windows.at(-1);
  let held = 1;
  for (let i = S.windows.length - 1; i >= 0 && S.windows[i].v.key === v.key; i--) held++;
  if (!gap) v.conf = confidence(v.conf, held);
  S.windows.push({ t: now, v, lanes: laneStates(sn, gap) });
  if (S.windows.length > 2000) S.windows.splice(0, 1000);
  drawLanes(sn, gap);
  if (S.mode === 'quick') {
    if (now >= S.quickEnd) endQuick(now);
    return;
  }
  if (!gap) {
    const ev = S.inc.feed(now, v);
    if (ev === 'opened') notify(S.inc.list[0]);
    if (ev) drawIncidents();
    else if (S.inc.cur) drawIncidents();
    verdict(v, sn, spanScores(now - 10 * 60000, now));
  }
  mark(v.key);
  void prev;
}

function endQuick(now) {
  // the quick verdict reads the whole run at once (its first 1.5 s open the connections)
  const sn = snapshot(S.t0 + 1500, now, { updateFloor: false });
  const v = judge(sn, true);
  v.conf = confidence(v.conf, 3);
  verdict(v, sn, spanScores(S.t0, now));
  if ($('#mon').checked) {
    S.mode = 'monitor';
    S.worker.postMessage({ cmd: 'start', plan: plan(false), stunEvery: 1000, window: WINDOW_MS });
    $('#goT').textContent = t('stop');
  } else finish(false);
}

function finish(stopped) {
  S.worker?.postMessage({ cmd: 'stop' });
  S.worker?.terminate();
  S.worker = null;
  const wasRunning = S.mode === 'quick' || S.mode === 'monitor';
  S.mode = 'done';
  document.body.dataset.run = '';
  $('#goT').textContent = t('again');
  $('#prog').textContent = ' ';
  if (stopped && wasRunning && !S.windows.length) verdict({ key: 'idle' });
  mark('ok');
}

function laneStates(sn, gap) {
  if (gap) return { device: 'gap', direct: 'gap', near: 'gap', far: 'gap', udp: 'gap', svc: 'gap' };
  return {
    device: sn.lagP95 == null ? 'none' : sn.lagP95 > 150 ? 'bad' : sn.lagP95 > 50 ? 'warn' : 'ok',
    direct: groupStatus(sn.direct), near: groupStatus(sn.near), far: groupStatus(sn.far), udp: sn.udp.status, svc: groupStatus(sn.svc),
  };
}

// scores over [from, to]: calls (MOS), games (hiccups per 10 minutes), web pages (connection setup)
function spanScores(from, to) {
  from = Math.max(from, S.t0 + 1500);
  // the visitor's own line: domestic sites in mainland China, the nearest Cloudflare location elsewhere
  const near = S.targets.find((x) => x.group === (S.cn ? 'direct' : 'near')) || S.targets[0];
  const ss = near ? near.samples.filter((s, i) => s.t > from && s.t <= to && i >= 2 && s.ms != null).map((s) => s.ms) : [];
  const floor = near?.floor ?? (ss.length ? Math.min(...ss) : null);
  const w = windowStats(ss.map((ms) => ({ ms })));
  const ref = S.stuns.find((s) => s.ref) || S.stuns[0];
  const u = ref ? stunLoss(ref.probes.filter((p) => p.t > from && p.t <= to)) : null;
  let retx = 0;
  if (u && u.base != null) for (const p of ref.probes.filter((q) => q.t > from && q.t <= to)) for (const a of p.answers) if (a - u.base > RETX[1] - 60) retx++;
  const spikes = (floor == null ? 0 : ss.filter((x) => x > floor + 100).length) + retx;
  const minutes = (to - from) / 60000;
  const call = mos(u?.med ?? w.med, w.jitter, u?.lossPct ?? 0);
  const game = gaming({ spikes, minutes, loss: u?.lossPct ?? 0, jitter: w.jitter ?? 0 });
  const cf = S.targets.find((x) => x.group === 'near');
  const warm = cf ? median(cf.samples.filter((s, i) => i >= 2 && s.ms != null).map((s) => s.ms)) : null;
  // under 5 ms: the browser reused a connection it already had, so there was nothing to set up
  const est = S.setups.length ? median(S.setups) : cf?.coldMs != null && warm != null ? cf.coldMs - warm : null;
  const setup = est != null && est >= 5 ? est : null;
  return { call, game, spikes, minutes, setup, nearMed: w.med, jitter: w.jitter, loss: u?.lossPct ?? null };
}

/* ---------- drawing ---------- */
const listOf = (items) => items.map((x) => `${x.name ?? x.id} ${ms0(x.med)} ms${x.why?.length ? '（' + x.why.map((w) => t('why_' + w)).join('、') + '）' : ''}`).join(D.lang.startsWith('zh') ? '；' : '; ');
const LEVEL = { ok: 'ok', 'udp-slow': 'warn', unknown: 'warn', hidden: 'warn', running: 'run', idle: 'idle' };

function verdict(v, sn, sc) {
  const box = $('#verdict');
  box.dataset.lv = LEVEL[v.key] || 'bad';
  if (v.key === 'idle' || v.key === 'running') {
    $('#vH').textContent = t(v.key === 'idle' ? 'v_idle' : 'v_running');
    $('#vSub').textContent = ' ';
    $('#ev').innerHTML = ''; $('#sug').hidden = true;
    return;
  }
  const names = (v.ids || []).map((id) => S.targets.find((x) => x.id === id)?.name || id).join(' / ');
  $('#vH').textContent = t('v_' + v.key, { names });
  $('#vSub').textContent = t('conf_' + (v.conf || 1));
  const named = (arr) => (arr || []).map((x) => ({ ...x, name: S.targets.find((y) => y.id === x.id)?.name || x.id }));
  $('#ev').innerHTML = (v.evidence || []).slice(0, 4).map((e) => {
    const list = listOf(named(e.near || e.far || e.direct || e.svc));
    if (e.k === 'udp-loss') return `<li>${esc(e.status === 'down' ? t('ev_udp-blocked') : t('ev_udp-loss', { loss: (e.lossPct ?? 0).toFixed(1) }))}</li>`;
    return `<li>${esc(t('ev_' + e.k, { list, n: e.n, udp: e.udp, tcp: e.tcp, ms: e.ms }))}</li>`;
  }).join('');
  const sug = L['s_' + v.key] || [];
  $('#sug').hidden = !sug.length;
  $('#sugL').innerHTML = sug.map((s) => `<li>${esc(s)}</li>`).join('');
  if (sn && sc) cards(sn, sc);
}

function cards(sn, sc) {
  $('[data-c="near"] b').textContent = sc.nearMed == null ? '–' : Math.round(sc.nearMed) + ' ms';
  $('[data-c="udp"] b').textContent = sc.loss == null ? '–' : sc.loss.toFixed(1) + '%';
  $('[data-c="jitter"] b').textContent = sc.jitter == null ? '–' : sc.jitter.toFixed(1) + ' ms';
  const call = mosLevel(sc.call), game = sc.game?.level ?? null, page = pageLevel(sc.setup);
  const put = (k, lv, detail) => {
    const li = $(`[data-s="${k}"]`);
    li.dataset.lv = lv || '';
    li.querySelector('b').textContent = lv ? t('lv_' + lv) : '–';
    li.querySelector('em').textContent = detail || ' ';
  };
  put('call', call, sc.call == null ? '' : t('sc_call_v', { v: sc.call.toFixed(1) }));
  // a short run: the count itself, since 20 seconds scaled up to 10 minutes says little
  put('game', game, !sc.game ? '' : sc.minutes < 2 ? t('sc_game_q', { n: sc.spikes, s: Math.round(sc.minutes * 60) }) : t('sc_game_v', { n: Math.round(sc.game.per10) }));
  put('page', page, sc.setup == null ? '' : t('sc_page_v', { ms: Math.round(sc.setup) }));
}

function resetLanes() {
  $$('.ln-tl').forEach((el) => { el.innerHTML = '<i></i>'.repeat(LANE_CELLS); });
  $$('.ln-st').forEach((el) => { el.textContent = t('st_none'); el.dataset.st = 'none'; });
  $$('.ln-v').forEach((el) => { el.textContent = ' '; });
}

function drawLanes(sn, gap) {
  const lanes = laneStates(sn, gap);
  const val = {
    device: sn.lagP95 == null ? '' : ms0(sn.lagP95) + ' ms',
    direct: sn.direct.map((x) => `${x.name} ${ms0(x.med)}`).join(' · '),
    near: sn.near.map((x) => `${ms0(x.med)} ms`).join(' · '),
    far: sn.far.map((x) => `${x.name} ${ms0(x.med)}`).join(' · '),
    udp: sn.udp.lossPct == null ? '' : `${sn.udp.lossPct.toFixed(1)}% · ${ms0(sn.udp.med)} ms`,
    svc: sn.svc.filter((x) => isBad(x.status)).map((x) => x.name).join(' · ') || (sn.svc.length ? sn.svc.length + ' ✓' : ''),
  };
  for (const [k, st] of Object.entries(lanes)) {
    const li = $(`[data-lane="${k}"]`);
    if (!li) continue;
    const s = li.querySelector('.ln-st');
    s.dataset.st = st; s.textContent = st === 'gap' ? t('st_none') : t('st_' + st);
    li.querySelector('.ln-v').textContent = gap ? '' : val[k] || ' ';
    const tl = li.querySelector('.ln-tl');
    const cell = document.createElement('i');
    cell.dataset.st = st;
    if (st === 'gap') cell.title = t('gap');
    tl.append(cell);
    while (tl.children.length > LANE_CELLS) tl.firstChild.remove();
  }
}

function drawIncidents() {
  const ol = $('#inc');
  if (!S.inc.list.length) { ol.innerHTML = `<li class="m">${esc(t('inc_none'))}</li>`; return; }
  const hm = (ms) => new Date(ms).toLocaleTimeString(D.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  ol.innerHTML = S.inc.list.slice(0, 30).map((x) => {
    const names = (x.ids || []).map((id) => S.targets.find((y) => y.id === id)?.name || id).join(' / ');
    return `<li data-lv="bad"><span class="inc-t">${hm(x.start)}–${x.open ? esc(t('inc_open')) : hm(x.end)}</span><span class="inc-v">${esc(t('v_' + x.key, { names }))}</span><span class="inc-c">${esc(t('conf_' + x.conf))}</span></li>`;
  }).join('');
}

function tickProgress() {
  if (S.mode === 'quick') {
    $('#prog').textContent = t('quick_prog', { s: Math.max(0, Math.ceil((S.quickEnd - Date.now()) / 1000)) });
  } else if (S.mode === 'monitor') {
    const s = Math.floor((Date.now() - S.t0) / 1000);
    $('#prog').textContent = t('monitor_on', { t: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  } else return;
  setTimeout(tickProgress, 1000);
}

// the tab title shows trouble while monitoring in the background
const title0 = document.title;
function mark(key) { document.title = S.mode === 'monitor' && key !== 'ok' && key !== 'gap' ? '● ' + title0 : title0; }

async function notify(inc) {
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
$('#mon').checked = store.get(K.mon) === '1';
$('#mon').onchange = (e) => {
  store.set(K.mon, e.target.checked ? '1' : '0');
  // turned on after the quick verdict: carry on from here
  if (e.target.checked && S.mode === 'done' && S.targets.length) {
    S.mode = 'monitor'; S.t0 = Date.now();
    document.body.dataset.run = 'on';
    $('#goT').textContent = t('stop');
    S.worker = new Worker(D.worker);
    S.worker.onmessage = onWorker;
    S.worker.postMessage({ cmd: 'start', plan: plan(false), stunEvery: 1000, window: WINDOW_MS });
    tickProgress();
  }
};

$('#go').onclick = begin;

// for the site's "report a problem" dialog: the last verdict and window states, no IP
window.msReport = () => {
  const w = S.windows.at(-1);
  return w ? { summary: t('v_' + w.v.key, { names: (w.v.ids || []).join(' / ') }), data: { mode: S.mode, proxied: S.proxied, colo: S.meta?.colo, lanes: w.lanes, v: w.v.key, conf: w.v.conf, incidents: S.inc.list.slice(0, 5).map((x) => ({ key: x.key, s: Math.round((x.end - x.start) / 1000) })) } } : null;
};
window.netdiag = S; // for scripted checks (test rigs)

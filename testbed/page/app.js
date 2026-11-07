// Prototype checks for the network diagnosis tool. Plain browser APIs, no dependencies.
const $ = (s) => document.querySelector(s);
const results = { env: null, a: null, b: [], c: null, d: null };
window.netdiagResults = results; // for scripted runs (e.g. the loss-injection test driving headless Chrome)

const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function stats(arr) {
  const s = arr.filter((x) => x != null && x >= 0).sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, min: s[0], med: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s.at(-1) };
}
function table(head, rows) {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

// ---------- environment ----------
function env() {
  const brands = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(', ');
  const e = {
    ua: navigator.userAgent,
    brands: brands || null,
    origin: location.origin,
    secure: window.isSecureContext,
    connection: navigator.connection ? { type: navigator.connection.type ?? null, effectiveType: navigator.connection.effectiveType, rtt: navigator.connection.rtt } : null,
  };
  results.env = e;
  $('#env').textContent = `${brands || navigator.userAgent} · ${location.origin}${e.secure ? '' : '（非安全上下文）'}`;
}
env();

// ---------- A: background sampling ----------
const A = { running: false, t0: 0, vis: [], main: [], worker: [], rtcOpen: false, worker_: null, pcs: null, timer: null, renderTimer: null };

async function loopbackPair() {
  // Two peer connections inside this page, host candidates only: enough to count as "WebRTC in use".
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const ch = a.createDataChannel('keep');
  b.ondatachannel = (e) => { e.channel.onmessage = () => {}; };
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await new Promise((res, rej) => { ch.onopen = res; setTimeout(() => rej(new Error('本机回环 5 秒内没有连上')), 5000); });
  return { a, b, ch };
}

function hiddenFor(now) {
  // How long the page had been hidden at `now` (0 when visible).
  let since = null;
  for (const v of A.vis) {
    if (v.t > now) break;
    since = v.state === 'hidden' ? v.t : null;
  }
  return since == null ? 0 : now - since;
}

async function startA() {
  Object.assign(A, { running: true, t0: Date.now(), vis: [{ t: Date.now(), state: document.visibilityState }], main: [], worker: [], rtcOpen: false });
  $('#a-start').disabled = true; $('#a-stop').disabled = false;
  const doFetch = $('#a-fetch').checked;
  if ($('#a-rtc').checked) {
    try { A.pcs = await loopbackPair(); A.rtcOpen = true; } catch (e) { A.rtcError = e.message; }
  }
  A.worker_ = new Worker('sampler-worker.js');
  A.worker_.onmessage = (e) => A.worker.push({ t: e.data.t, rtt: e.data.rtt, hid: hiddenFor(e.data.t) });
  A.worker_.postMessage({ cmd: 'start', fetchUrl: doFetch ? '/p.txt' : null });
  const tick = async () => {
    if (!A.running) return;
    const t = Date.now();
    A.timer = setTimeout(tick, 1000); // a chain of timers: what Chrome's intensive throttling targets
    if (A.pcs?.ch.readyState === 'open') A.pcs.ch.send(String(t));
    let rtt = null;
    if (doFetch) {
      const s = performance.now();
      try { await (await fetch(`/p.txt?m=${t}`, { cache: 'no-store' })).arrayBuffer(); rtt = performance.now() - s; } catch { rtt = -1; }
    }
    A.main.push({ t, rtt, hid: hiddenFor(t) });
  };
  tick();
  A.renderTimer = setInterval(renderA, 2000);
  renderA();
}

function stopA() {
  A.running = false;
  clearTimeout(A.timer); clearInterval(A.renderTimer);
  A.worker_?.postMessage({ cmd: 'stop' }); A.worker_?.terminate();
  if (A.pcs) { A.pcs.a.close(); A.pcs.b.close(); A.pcs = null; }
  $('#a-start').disabled = false; $('#a-stop').disabled = true;
  renderA();
}

document.addEventListener('visibilitychange', () => {
  if (!A.running) return;
  A.vis.push({ t: Date.now(), state: document.visibilityState });
  if (document.visibilityState === 'visible') renderA();
});

function summarizeTicks(ticks) {
  const buckets = { visible: [], hidden: [], hidden5: [] };
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i].t - ticks[i - 1].t;
    const h = ticks[i].hid;
    (h === 0 ? buckets.visible : h < 5 * 60e3 ? buckets.hidden : buckets.hidden5).push(gap);
  }
  const rtts = ticks.map((x) => x.rtt);
  return { gaps: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, stats(v)])), rtt: stats(rtts), failures: rtts.filter((x) => x === -1).length, ticks: ticks.length };
}

function renderA() {
  const hiddenMs = A.vis.reduce((sum, v, i) => {
    if (v.state !== 'hidden') return sum;
    const end = A.vis[i + 1]?.t ?? (A.running ? Date.now() : A.vis.at(-1).t);
    return sum + (end - v.t);
  }, 0);
  const main = summarizeTicks(A.main), worker = summarizeTicks(A.worker);
  results.a = { rtc: $('#a-rtc').checked, rtcOpen: A.rtcOpen, rtcError: A.rtcError ?? null, fetch: $('#a-fetch').checked, startedAt: new Date(A.t0).toISOString(), runSeconds: Math.round((Date.now() - A.t0) / 1000), hiddenSeconds: Math.round(hiddenMs / 1000), visChanges: A.vis.length - 1, main, worker };
  const cell = (s) => (s ? `${s.n} 次 · 中位 ${fmt(s.med)} · p99 ${fmt(s.p99)} · 最大 ${fmt(s.max)}` : '—');
  const verdict = (s) => !s ? '<span class="muted">还没有隐藏超过 5 分钟的数据</span>' : s.p99 <= 2000 ? '<span class="good">保持每秒</span>' : '<span class="bad">被节流</span>';
  $('#a-out').innerHTML =
    `<p class="muted">已运行 ${results.a.runSeconds} 秒，其中隐藏 ${results.a.hiddenSeconds} 秒；WebRTC：${A.rtcOpen ? '已连上' : $('#a-rtc').checked ? `<span class="bad">未连上 ${esc(A.rtcError ?? '')}</span>` : '未开'}</p>` +
    table(['计时方式', '可见时间隔 (ms)', '隐藏 < 5 分钟 (ms)', '隐藏 ≥ 5 分钟 (ms)', '隐藏 ≥ 5 分钟的结论', '请求往返 (ms)'], [
      ['主线程 setTimeout 链', cell(main.gaps.visible), cell(main.gaps.hidden), cell(main.gaps.hidden5), verdict(main.gaps.hidden5), main.rtt ? `中位 ${fmt(main.rtt.med, 1)}，失败 ${main.failures}` : '—'],
      ['Worker setInterval', cell(worker.gaps.visible), cell(worker.gaps.hidden), cell(worker.gaps.hidden5), verdict(worker.gaps.hidden5), worker.rtt ? `中位 ${fmt(worker.rtt.med, 1)}，失败 ${worker.failures}` : '—'],
    ]);
}

$('#a-start').onclick = startA;
$('#a-stop').onclick = stopA;

// ---------- B: UDP loopback through TURN ----------
// Each test asks for its own credential, lasting only that test; it is revoked as soon as the test ends.
const TURN_ERRORS = {
  'visitor-limit': '今天你的测试次数用完了',
  'site-limit': '今天全站的测试次数用完了',
  turnstile: '人机验证没有通过，请重试',
  disabled: '精确丢包测试暂时关闭',
  forbidden: '只能从本页面发起',
};
const turnstile = { siteKey: null, token: null, widget: null };

async function initTurnstile() {
  try {
    turnstile.siteKey = (await (await fetch('/api/config', { cache: 'no-store' })).json()).turnstileSiteKey;
  } catch {}
  if (!turnstile.siteKey) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = res; s.onerror = rej;
    document.head.append(s);
  });
  turnstile.widget = window.turnstile.render('#b-ts', {
    sitekey: turnstile.siteKey,
    callback: (t) => { turnstile.token = t; },
    'expired-callback': () => { turnstile.token = null; },
  });
}
initTurnstile();

async function getTurn(secs) {
  if (turnstile.siteKey && !turnstile.token) throw new Error('请先完成上面的人机验证');
  const res = await fetch('/api/turn', {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secs, turnstile: turnstile.token }),
  });
  if (turnstile.widget != null) { window.turnstile.reset(turnstile.widget); turnstile.token = null; } // a token works once
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(TURN_ERRORS[body.error] || body.error || `HTTP ${res.status}`);
  if (body.left != null) $('#b-left').textContent = `今天还能测 ${body.left} 次`;
  return body;
}

function revokeTurn(username) {
  if (!username) return;
  fetch('/api/turn/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }), keepalive: true }).catch(() => {});
}

// One port per run: offering UDP 3478 and 443 together stalled the connection on a network where 443/UDP never
// answered (2026-11-06), so 443 is its own choice.
const PICK = {
  udp: (u) => u.startsWith('turn:') && u.includes(':3478?transport=udp'),
  udp443: (u) => u.startsWith('turn:') && u.includes(':443?transport=udp'),
  tcp: (u) => u.startsWith('turn:') && u.includes('transport=tcp'),
  tls: (u) => u.startsWith('turns:') && u.includes(':443'),
};

async function selectedPair(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId);
  return { localType: local?.candidateType, relayProtocol: local?.relayProtocol ?? null, protocol: local?.protocol, stunRtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null };
}

async function udpLoopback(transport, rate, secs, onProgress) {
  const cred = await getTurn(secs);
  const turn = cred.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn')));
  const urls = [].concat(turn.urls).filter(PICK[transport]);
  if (!urls.length) { revokeTurn(cred.username); throw new Error(`TURN 凭证里没有 ${transport} 地址`); }
  const cfg = { iceServers: [{ urls, username: turn.username, credential: turn.credential }], iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfg);
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const ch = a.createDataChannel('probe', { ordered: false, maxRetransmits: 0 });
    ch.binaryType = 'arraybuffer';
    b.ondatachannel = (e) => { const c = e.channel; c.binaryType = 'arraybuffer'; c.onmessage = (m) => { if (c.readyState === 'open') c.send(m.data); }; };
    const tSetup = performance.now();
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    await new Promise((res, rej) => { ch.onopen = res; setTimeout(() => rej(new Error('15 秒内没有经 TURN 连上')), 15000); });
    const setupMs = performance.now() - tSetup;
    const pair = await selectedPair(a);

    const N = Math.round(rate * secs), interval = 1000 / rate;
    const sendT = new Float64Array(N), recvT = new Float64Array(N);
    let maxSeen = -1, reorder = 0, dup = 0, skipped = 0;
    ch.onmessage = (m) => {
      const now = performance.now();
      const seq = new DataView(m.data).getUint32(0);
      if (seq >= N) return;
      if (recvT[seq]) { dup++; return; }
      recvT[seq] = now;
      if (seq < maxSeen) reorder++; else maxSeen = seq;
    };
    const buf = new ArrayBuffer(100), view = new DataView(buf);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const due = t0 + i * interval, wait = due - performance.now();
      if (wait > 1) await sleep(wait);
      if (ch.readyState !== 'open') break;
      if (ch.bufferedAmount > 64 * 1024) { skipped++; sendT[i] = -1; continue; }
      view.setUint32(0, i);
      sendT[i] = performance.now();
      ch.send(buf);
      if (i % rate === 0) onProgress?.(i / N);
    }
    await sleep(2000);

    const rtts = [], perSecond = [];
    let lost = 0, run = 0, longestRun = 0, jitterSum = 0, jitterN = 0, prev = null;
    for (let i = 0; i < N; i++) {
      if (sendT[i] <= 0) continue;
      const sec = Math.floor(i / rate);
      perSecond[sec] ??= { sent: 0, lost: 0 };
      perSecond[sec].sent++;
      if (recvT[i]) {
        const r = recvT[i] - sendT[i];
        rtts.push(r);
        if (prev != null) { jitterSum += Math.abs(r - prev); jitterN++; }
        prev = r; run = 0;
      } else {
        lost++; perSecond[sec].lost++; run++; longestRun = Math.max(longestRun, run);
      }
    }
    const sent = N - skipped;
    return {
      transport, rate, secs, setupMs, pair, sent, received: rtts.length, lost, lossPct: (lost / sent) * 100, longestLossRun: longestRun,
      reorder, dup, skipped, rtt: stats(rtts), jitter: jitterN ? jitterSum / jitterN : null, perSecondLoss: perSecond.map((s) => s.lost),
    };
  } finally {
    a.close(); b.close();
    revokeTurn(cred.username);
  }
}

function renderB() {
  const rows = results.b.map((r) => r.error
    ? [esc(r.transport), `<span class="bad">${esc(r.error)}</span>`, '', '', '', '', '', '']
    : [
      esc(r.transport.toUpperCase()),
      r.pair ? `${esc(r.pair.localType)}/${esc(r.pair.relayProtocol ?? r.pair.protocol)}` : '?',
      `${fmt(r.setupMs)}`,
      `${r.sent} / ${r.received}`,
      `<b>${fmt(r.lossPct, 2)}%</b>（最长连丢 ${r.longestLossRun}）`,
      r.rtt ? `${fmt(r.rtt.med, 1)} / ${fmt(r.rtt.p95, 1)} / ${fmt(r.rtt.max, 1)}` : '—',
      fmt(r.jitter, 1),
      `乱序 ${r.reorder}，重复 ${r.dup}，跳过 ${r.skipped}`,
    ]);
  $('#b-out').innerHTML = table(['方式', '连到的候选', '建连 (ms)', '发 / 收', '丢包', '往返 中位/p95/最大 (ms)', '抖动 (ms)', '其他'], rows);
}

async function runB(list) {
  const rate = Math.max(1, Math.min(200, Number($('#b-rate').value) || 50));
  const secs = Math.max(5, Math.min(60, Number($('#b-secs').value) || 20));
  $('#b-run').disabled = $('#b-all').disabled = true;
  try {
    for (const t of list) {
      $('#b-out').insertAdjacentHTML('beforeend', `<p class="muted" id="b-prog">${t.toUpperCase()} 进行中…</p>`);
      try {
        results.b.push(await udpLoopback(t, rate, secs, (f) => { const p = $('#b-prog'); if (p) p.textContent = `${t.toUpperCase()} 进行中… ${Math.round(f * 100)}%`; }));
      } catch (e) {
        results.b.push({ transport: t, error: e.message });
      }
      renderB();
    }
  } finally {
    $('#b-run').disabled = $('#b-all').disabled = false;
  }
}
$('#b-run').onclick = () => runB([$('#b-transport').value]);
$('#b-all').onclick = () => runB(['udp', 'tcp', 'tls']);

// ---------- C: gateway probe ----------
async function permissionState() {
  for (const name of ['local-network-access', 'local-network']) {
    try { return { name, state: (await navigator.permissions.query({ name })).state }; } catch {}
  }
  return null;
}

async function probeGateway(ip, withTas) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  const opts = { mode: 'no-cors', cache: 'no-store', signal: ctl.signal };
  if (withTas) opts.targetAddressSpace = 'local';
  const s = performance.now();
  try {
    await fetch(`http://${ip}/?r=${Math.random().toString(36).slice(2)}`, opts);
    return { ok: true, ms: performance.now() - s };
  } catch (e) {
    return { ok: false, ms: performance.now() - s, err: `${e.name}: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

$('#c-run').onclick = async () => {
  const btn = $('#c-run'); btn.disabled = true;
  const withTas = $('#c-tas').checked;
  const addrs = $('#c-addrs').value.split(/[\s,，]+/).filter(Boolean);
  const out = $('#c-out');
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  out.innerHTML = local ? '<p class="warn">当前是本机地址打开的，结果不代表公网页面上的行为。</p>' : '';
  try {
    const before = await permissionState();
    const first = [];
    for (const ip of addrs) first.push({ ip, ...(await probeGateway(ip, withTas)) });
    // Answered = the request finished, or failed only after a while (a refused connection takes about one round trip).
    const target = first.find((r) => r.ok) ?? null;
    const samples = [];
    if (target) {
      for (let i = 0; i < 15; i++) { samples.push(await probeGateway(target.ip, withTas)); await sleep(200); }
    }
    const after = await permissionState();
    const st = stats(samples.filter((x) => x.ok).map((x) => x.ms));
    results.c = { withTas, before, after, first, target: target?.ip ?? null, samples, stats: st, publicOrigin: !local };
    out.innerHTML += `<p class="muted">权限：之前 ${esc(before ? `${before.name}=${before.state}` : '查不到')}，之后 ${esc(after ? `${after.name}=${after.state}` : '查不到')}</p>` +
      table(['地址', '结果', '耗时 (ms)', '错误'], first.map((r) => [esc(r.ip), r.ok ? '<span class="good">有应答</span>' : '<span class="bad">失败</span>', fmt(r.ms, 1), esc(r.err ?? '')])) +
      (target
        ? `<p class="verdict">${esc(target.ip)}：${samples.filter((x) => x.ok).length}/15 次成功，往返 中位 ${fmt(st?.med, 1)} ms，p95 ${fmt(st?.p95, 1)} ms，最大 ${fmt(st?.max, 1)} ms</p>`
        : '<p class="verdict bad">没有地址应答。错误耗时接近 0 ms 通常是被浏览器拦下，接近 2500 ms 是超时。</p>');
  } finally {
    btn.disabled = false;
  }
};

// ---------- D: HTTP/3 vs HTTP/2 ----------
const D_URLS = [
  '/p.txt',
  'https://speed.cloudflare.com/__down?bytes=0',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://1ms.dog/favicon-32.png',
];

async function protoRun(url, n = 8) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const full = new URL(url, location.href);
    full.searchParams.set('r', `${Date.now()}${i}`);
    const href = full.href;
    const s = performance.now();
    let err = null;
    // Read the body to its end: the timing entry is only written once the response has fully arrived.
    try { await (await fetch(href, { cache: 'no-store', mode: full.origin === location.origin ? 'same-origin' : 'no-cors' })).arrayBuffer(); } catch (e) { err = e.message; }
    const ms = performance.now() - s;
    await sleep(50); // the entry lands after the response
    const e = performance.getEntriesByName(href).at(-1);
    rows.push({
      i, ms, err,
      proto: e?.nextHopProtocol || '',
      detailed: e ? e.responseStart > 0 : false, // detailed timings are zero without Timing-Allow-Origin
      newConn: e && e.connectEnd > e.connectStart,
    });
    await sleep(300);
  }
  return { url, rows };
}

$('#d-run').onclick = async () => {
  const btn = $('#d-run'); btn.disabled = true;
  const urls = [...D_URLS];
  const extra = $('#d-extra').value.trim();
  if (extra) urls.push(extra);
  performance.setResourceTimingBufferSize?.(5000);
  results.d = [];
  try {
    for (const u of urls) {
      results.d.push(await protoRun(u));
      $('#d-out').innerHTML = table(['地址', '每次的协议（第 1 次 → 第 8 次）', '读得到连接细节', '新建连接的次数', '中位耗时 (ms)'], results.d.map((r) => [
        esc(r.url),
        r.rows.map((x) => (x.err ? '✕' : x.proto || '?')).join(' '),
        r.rows.some((x) => x.detailed) ? '<span class="good">能</span>' : '<span class="bad">不能</span>',
        r.rows.some((x) => x.detailed) ? String(r.rows.filter((x) => x.newConn).length) : '—',
        fmt(stats(r.rows.map((x) => x.ms))?.med, 1),
      ]));
    }
  } finally {
    btn.disabled = false;
  }
};

// ---------- E: UDP through free STUN ----------
// Each probe is one ICE gathering against one STUN server: the time from setLocalDescription to the server-reflexive
// candidate is one UDP round trip. libwebrtc retransmits a STUN request 250 ms after the first send, then after
// 500 ms, 1000 ms (STUN_INITIAL_RTO = 250 ms, doubling), so a probe whose first k packets were lost lands near
// RTT + RETX[k]. Counting k across probes estimates the loss rate.
const RETX = [0, 250, 750, 1750];
const E_TIMEOUT = 3000; // past 3 s the 4th send (at 1750 ms) is lost too; counted as 4 of 4 lost
const E = { running: false, until: 0, targets: [], https: [], overhead: 0, timer: null, httpsTimer: null, renderTimer: null, colo: null };

// Resolves at the first wanted candidate. With several network interfaces each one sends its own request, and the
// first answer hides a loss on the others, so the connection stays open until E_TIMEOUT and `hosts` / `more` record
// every interface for later analysis.
function stunProbe(url, iceServers) {
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('s');
    let t0 = 0, first = null;
    const r = { ok: false, hosts: 0, more: [] };
    setTimeout(() => { pc.close(); if (!first) resolve(r); }, E_TIMEOUT);
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate || c.protocol === 'tcp') return;
      const type = c.type || (/ typ (\w+)/.exec(c.candidate) || [])[1];
      if (type === 'host') r.hosts++;
      if ((url && type === 'srflx') || (!url && type === 'host')) {
        const ms = performance.now() - t0;
        if (first) { r.more.push(ms); return; }
        first = ms; r.ok = true; r.ms = ms;
        resolve(r);
      }
    };
    pc.createOffer().then((o) => { t0 = performance.now(); return pc.setLocalDescription(o); }).catch(() => resolve(r));
  });
}

async function calibrate() {
  // Time to the first host candidate: the browser's own overhead, taken off every STUN sample.
  const xs = [];
  for (let i = 0; i < 5; i++) { const r = await stunProbe(null, []); if (r.ok) xs.push(r.ms); }
  return stats(xs)?.med ?? 0;
}

// Every server-reflexive answer counts as its own request: with IPv4 and IPv6 (or two interfaces) a probe sends one
// request per socket, and the first answer hides a loss on the others. Validated 2026-11-06 on a Linux VPS by dropping
// incoming STUN answers with iptables: 2 / 5 / 10 % injected → 1.3–2.0 / 4.4–4.8 / 8.2–9.1 % inferred, where the
// first answer alone showed 0–1 %. (Dropping on OUTPUT does not work as a test: sendto() fails and Chrome resends.)
const answersOf = (s) => (s.ok ? [s.ms, ...(s.more || []).map((m) => Math.max(0, m - E.overhead))] : []);

function classifyStun(samples) {
  const counts = {};
  samples.forEach((s) => { const n = answersOf(s).length; counts[n] = (counts[n] || 0) + 1; });
  const expected = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1) || 1; // answers a probe should get
  const all = samples.flatMap(answersOf).sort((a, b) => a - b);
  const base = quantile(all, 0.1); // the fast cluster: no retransmission
  const tol = Math.max(60, Math.min(100, (base ?? 0) * 0.5)); // capped: on a 200 ms path base/2 took jitter for loss
  let sends = 0, lost = 0, spikes = 0, missing = 0;
  const hist = { '<100': 0, '100–200': 0, '200–350': 0, '350–600': 0, '600–1000': 0, '1000+': 0 };
  const clean = [];
  for (const s of samples) {
    const answers = answersOf(s);
    for (const ms of answers) {
      const ex = ms - base;
      hist[ex < 100 ? '<100' : ex < 200 ? '100–200' : ex < 350 ? '200–350' : ex < 600 ? '350–600' : ex < 1000 ? '600–1000' : '1000+']++;
      let k = 0, err = Infinity;
      RETX.forEach((c, i) => { const d = Math.abs(ex - c); if (d < err) { err = d; k = i; } });
      if (k > 0 && err > tol) { k = 0; spikes++; } // slow, but not on a retransmission step: a delay, not a loss
      sends += k + 1; lost += k;
      if (k === 0) clean.push(ms);
    }
    const miss = Math.max(0, expected - answers.length); // an answer that never came: 4 sends lost within E_TIMEOUT
    missing += miss; sends += 4 * miss; lost += 4 * miss;
  }
  const answered = samples.filter((s) => s.ok).length;
  return { n: samples.length, answered, timeouts: samples.length - answered, expected, missing, base, rtt: stats(clean), lossPct: sends ? (lost / sends) * 100 : null, spikes, hist };
}

async function httpsProbe() {
  // Cloudflare's speed endpoint sends Timing-Allow-Origin, so request→response on a reused connection is readable.
  const url = `https://speed.cloudflare.com/__down?bytes=0&r=${Date.now()}`;
  try {
    await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
    await sleep(30);
    const e = performance.getEntriesByName(url).at(-1);
    if (e && e.responseStart > 0 && e.connectStart === e.connectEnd) E.https.push(e.responseStart - e.requestStart);
  } catch {}
  performance.clearResourceTimings();
}

async function startE() {
  const urls = $('#e-targets').value.split(/[\s,，]+/).filter((u) => /^stun:/.test(u));
  if (!urls.length) return;
  const rate = Number($('#e-rate').value) || 1;
  const secs = Math.max(20, Math.min(1800, Number($('#e-secs').value) || 120));
  Object.assign(E, { running: true, until: Date.now() + secs * 1000, https: [], targets: urls.map((url) => ({ url, samples: [], busy: false })) });
  $('#e-start').disabled = true; $('#e-stop').disabled = false;
  $('#e-out').innerHTML = '<p class="muted">校准浏览器自身开销…</p>';
  E.overhead = await calibrate();
  fetch('https://speed.cloudflare.com/meta', { cache: 'no-store' }).then((r) => r.json()).then((m) => { const c = m.colo; E.colo = (c && typeof c === 'object' ? c.iata || c.city : c) || null; }).catch(() => {});
  let i = 0;
  E.timer = setInterval(() => {
    if (!E.running || Date.now() > E.until) { stopE(); return; }
    const t = E.targets[i++ % E.targets.length];
    if (t.busy) return; // one probe per server at a time
    t.busy = true;
    stunProbe(t.url, [{ urls: t.url }]).then((r) => {
      t.busy = false;
      const s = r.ok ? { ok: true, ms: Math.max(0, r.ms - E.overhead), at: Date.now(), hosts: r.hosts, more: r.more } : { ok: false, at: Date.now(), hosts: r.hosts };
      t.samples.push(s); // `more` keeps filling for up to E_TIMEOUT after this
    });
  }, 1000 / rate);
  httpsProbe(); // the first request only opens the connection
  E.httpsTimer = setInterval(httpsProbe, 2000);
  E.renderTimer = setInterval(renderE, 2000);
}

function stopE() {
  E.running = false;
  clearInterval(E.timer); clearInterval(E.httpsTimer); clearInterval(E.renderTimer);
  $('#e-start').disabled = false; $('#e-stop').disabled = true;
  setTimeout(renderE, E_TIMEOUT + 200); // let the last probes finish
}

function renderE() {
  const rows = E.targets.map((t) => ({ url: t.url, ...classifyStun(t.samples) }));
  const https = stats(E.https);
  const cf = rows.find((r) => r.url.includes('stun.cloudflare.com'));
  results.e = { overheadMs: E.overhead, httpsColo: E.colo, https, targets: rows, raw: E.targets.map((t) => ({ url: t.url, samples: t.samples })) };
  const left = Math.max(0, Math.round((E.until - Date.now()) / 1000));
  $('#e-out').innerHTML =
    `<p class="muted">${E.running ? `还剩 ${left} 秒` : '已结束'} · 浏览器自身开销 ${fmt(E.overhead, 1)} ms（已扣除）</p>` +
    table(['服务器', '探测 / 应答', 'UDP 往返 中位 / p95 (ms)', '推断丢包', '超时 / 缺的回答', '非重传的慢样本', '比最快簇多出的时间分布 (ms)'], rows.map((r) => [
      esc(r.url.replace('stun:', '')),
      `${r.n} / ${r.answered}（每次 ${r.expected} 个回答）`,
      r.rtt ? `${fmt(r.rtt.med, 1)} / ${fmt(r.rtt.p95, 1)}` : '—',
      r.lossPct == null ? '—' : `<b>${fmt(r.lossPct, 1)}%</b>`,
      `${r.timeouts} / ${r.missing}`,
      String(r.spikes),
      Object.entries(r.hist).map(([k, v]) => `${k}:${v}`).join(' '),
    ])) +
    `<p class="verdict">Cloudflare HTTPS（TCP${E.colo ? `，机房 ${esc(E.colo)}` : ''}）往返 中位 ${fmt(https?.med, 1)} ms（${https?.n ?? 0} 次）` +
    (cf?.rtt && https ? ` · Cloudflare STUN（UDP）中位 ${fmt(cf.rtt.med, 1)} ms · UDP / TCP = ${fmt(cf.rtt.med / https.med, 2)}` : '') + '</p>' +
    '<p class="muted">STUN 走任播，不一定和 HTTPS 落在同一个机房；UDP / TCP 明显大于 1 时，还要排除这一点。</p>';
}

$('#e-start').onclick = startE;
$('#e-stop').onclick = stopE;

// ---------- scripted runs: ?auto=e&secs=…&rate=…&targets=… ----------
// For headless test rigs: starts check E at once and POSTs the results to /results every minute and at the end.
{
  const qs = new URLSearchParams(location.search);
  if (qs.get('auto') === 'e') {
    if (qs.get('targets')) $('#e-targets').value = qs.get('targets');
    if (qs.get('rate')) $('#e-rate').value = qs.get('rate');
    $('#e-secs').value = qs.get('secs') || 120;
    let final = false;
    const post = (done) => fetch('/results', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: Date.now(), done, e: results.e }),
    }).catch(() => {});
    setInterval(() => {
      if (!results.e || final) return;
      if (!E.running && Date.now() > E.until + E_TIMEOUT + 1000) { final = true; renderE(); post(true); } else post(false);
    }, 5000);
    startE();
  }
}

// ---------- export ----------
$('#export').onclick = () => {
  if (A.running) renderA();
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...results }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `netdiag-proto-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('#export-note').textContent = '已生成文件。';
};

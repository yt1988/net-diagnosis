// Browser measurements. Each returns plain numbers for src/lib.mjs to judge.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTPS request on the open connection to the target's host (the first one also opens it). The body is read to
// its end: Resource Timing writes its entry only then. → { ms } or { ms: null } on a timeout or error, plus setup
// (DNS + TCP + TLS) when the browser had to connect and the host sends Timing-Allow-Origin.
export async function https(url, timeout = 3000) {
  const u = new URL(url);
  u.searchParams.set('_', Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const href = u.href, ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = performance.now();
  try {
    const r = await fetch(href, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal, referrerPolicy: 'no-referrer' });
    await r.arrayBuffer().catch(() => {});
    const ms = performance.now() - t0;
    await sleep(20); // the entry is queued after the response; in a worker it lands a moment later
    const e = performance.getEntriesByName(href).at(-1);
    if (e) performance.clearResourceTimings?.();
    let setup = null;
    if (e && e.connectEnd > e.connectStart && e.requestStart > 0) setup = e.connectEnd - (e.domainLookupStart || e.connectStart);
    return { ms, setup, proto: e?.nextHopProtocol || null };
  } catch {
    return { ms: null };
  } finally {
    clearTimeout(timer);
  }
}

// One ICE gathering against one STUN server: the time to each server-reflexive candidate is one UDP round trip per
// local socket (IPv4, IPv6, other interfaces). → { answers: [ms, …], v6: [bool, …], pub4, pub6, hosts }
// pub4 / pub6: the public address the server saw, only to notice when it changes (never shown or sent).
export function stun(url, timeout = 3000) {
  return new Promise((resolve) => {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [{ urls: url }] }); } catch { resolve({ answers: [], v6: [], hosts: 0, error: true }); return; }
    pc.createDataChannel('s');
    const r = { answers: [], v6: [], hosts: 0, pub4: null, pub6: null };
    let t0 = 0;
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate || c.protocol === 'tcp') return;
      const type = c.type || (/ typ (\w+)/.exec(c.candidate) || [])[1];
      if (type === 'host') r.hosts++;
      else if (type === 'srflx') {
        const addr = c.address || c.candidate.split(' ')[4] || '';
        const six = addr.includes(':');
        r.answers.push(performance.now() - t0);
        r.v6.push(six);
        if (six) r.pub6 ??= addr; else r.pub4 ??= addr;
      }
    };
    setTimeout(() => { pc.close(); resolve(r); }, timeout);
    pc.createOffer().then((o) => { t0 = performance.now(); return pc.setLocalDescription(o); }).catch(() => { pc.close(); resolve(r); });
  });
}

// The browser's own time to its first host candidate, taken off every STUN answer
export async function stunOverhead() {
  const xs = [];
  for (let i = 0; i < 5; i++) {
    const ms = await new Promise((resolve) => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel('s');
      let t0 = 0, done = false;
      pc.onicecandidate = (e) => { if (!done && e.candidate?.candidate) { done = true; resolve(performance.now() - t0); pc.close(); } };
      setTimeout(() => { if (!done) { done = true; resolve(null); pc.close(); } }, 1000);
      pc.createOffer().then((o) => { t0 = performance.now(); return pc.setLocalDescription(o); }).catch(() => resolve(null));
    });
    if (ms != null) xs.push(ms);
  }
  xs.sort((a, b) => a - b);
  return xs.length ? xs[xs.length >> 1] : 0;
}

// How late a 250 ms timer fires: the device or the page being too busy (or throttled) to measure on time
export function lagMeter() {
  const lags = [];
  let last = performance.now(), timer = null;
  const tick = () => { const now = performance.now(); lags.push({ t: Date.now(), lag: Math.max(0, now - last - 250) }); last = now; if (lags.length > 2400) lags.splice(0, 1200); };
  return {
    start() { last = performance.now(); timer = setInterval(tick, 250); },
    stop() { clearInterval(timer); },
    since(t) { return lags.filter((x) => x.t >= t).map((x) => x.lag); },
  };
}

// Cloudflare's view of this connection: { ip, country, colo, asn, org, city } or null
export async function meta(url) {
  try {
    const m = await (await fetch(url, { cache: 'no-store', credentials: 'omit' })).json();
    const colo = typeof m.colo === 'object' ? m.colo?.iata : m.colo;
    return { ip: m.clientIp || null, country: m.country || null, colo: colo || null, asn: m.asn || null, org: m.asOrganization || null, city: m.city || null };
  } catch {
    return null;
  }
}

export { sleep };

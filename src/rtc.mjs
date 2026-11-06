// Copied from speed-test (src/rtc.mjs, MIT, same author): the client for rtc.1ms.dog. Keep the two in step.
// UDP and QUIC to rtc.1ms.dog in Tokyo (server/main.go). Little traffic: 50 packets of 12 bytes a second while the
// test runs (with WebRTC's own acknowledgements about 130 UDP packets and 10 KB a second each way, 0.4-0.7 MB a
// test), then 10 echoes over QUIC and 10 over TCP.
//
//   udp()          a WebRTC data channel, unreliable and unordered (as calls and games send): .phase(0|1|2) tags
//                  what follows as idle, download or upload; .stop() gives { state, phases: [{ loss, up, down, jit }] }
//   quic()         WebTransport datagrams against a WebSocket to the same server: is QUIC let through, and as fast?
//
// Pure helpers (lossOf, quicVerdict) are unit-tested; the rest needs a browser.
export const RTC = "https://rtc.1ms.dog";
export const SIG = RTC + ":2087", WT = RTC + ":40101/wt";
export const RATE_MS = 20, WAIT_MS = 1500;
const PHASES = 3;

// packets sent, the server's count of what reached it, and the round trips of those that came back → one phase:
// loss in % both ways, split into the way there (up) and back (down) when the server's count is known
export function lossOf(sent, got, rtts) {
  if (!sent) return null;
  const back = rtts.length, loss = 100 * (1 - back / sent);
  const up = got == null ? null : 100 * (1 - Math.min(got, sent) / sent);
  const down = got == null || !got ? null : 100 * (1 - Math.min(back, got) / got);
  return { sent, loss: Math.max(0, loss), up, down, jit: jitterOf(rtts), rtt: medianOf(rtts) };
}
const medianOf = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// mean change between consecutive round trips (in the order sent), as for the latency tiles
const jitterOf = a => a.length < 2 ? null : a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1);

// { wt: no API | failed | { rtt, lost }, ws: failed | { rtt } } → ok | slow | blocked | na (can't check) | down
export function quicVerdict({ api, wt, ws }) {
  if (!api) return "na";
  if (!ws) return wt ? "ok" : "down";          // no TCP either: the server is out of reach, not QUIC
  if (!wt) return "blocked";
  if (wt.lost >= 0.3 || wt.rtt > ws.rtt * 1.5 + 20) return "slow";
  return "ok";
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error("timeout")), ms))]);

export function udp(sig = SIG) {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("u", { ordered: false, maxRetransmits: 0 });
  dc.binaryType = "arraybuffer";
  // sent: the packets still out, by sequence number; out: per phase, how many went and when, the round trips back
  const sent = new Map(), out = Array.from({ length: PHASES }, () => ({ sent: 0, at: [], rtts: [] }));
  // state: connecting → open, or blocked (the server answered, UDP didn't get through) or down (no server)
  let phase = 0, seq = 0, tick = null, counts = null, state = "connecting", reached = false;
  const t0 = performance.now();
  dc.onmessage = e => {
    if (typeof e.data === "string") { try { counts = JSON.parse(e.data); } catch (x) {} return; }
    const v = new DataView(e.data); if (v.byteLength < 9) return;
    const s = sent.get(v.getUint32(1)); if (!s) return;
    sent.delete(v.getUint32(1));
    out[s.p].rtts.push(performance.now() - s.t);
  };
  const open = new Promise((res, rej) => { dc.onopen = res; pc.onconnectionstatechange = () => pc.connectionState === "failed" && rej(new Error("failed")); });
  const ready = (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    const r = await timeout(fetch(sig + "/offer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pc.localDescription), cache: "no-store" }), 6000);
    if (!r.ok) throw new Error("HTTP " + r.status);
    await pc.setRemoteDescription(await r.json());
    reached = true;                 // the server answered over HTTPS: if the channel doesn't open now, UDP is blocked
    await timeout(open, 6000);
    state = "open";
    tick = setInterval(() => {
      if (dc.readyState !== "open") return;
      const b = new ArrayBuffer(12), v = new DataView(b);
      v.setUint8(0, phase); v.setUint32(1, ++seq); v.setFloat32(5, performance.now() - t0);
      const now = performance.now();
      sent.set(seq, { p: phase, t: now }); out[phase].sent++; out[phase].at.push(now);
      try { dc.send(b); } catch (e) {}
    }, RATE_MS);
  })().catch(() => { state = reached ? "blocked" : "down"; });
  ready.catch(() => {});
  return {
    phase(p) { phase = p; },
    get state() { return state; },
    // so far, while the test runs: per phase, the packets old enough to have come back (WAIT_MS), how many of
    // them didn't, and the jitter of those that did; null for a phase with none yet
    live() {
      if (state !== "open") return null;
      const old = performance.now() - WAIT_MS, lost = [0, 0, 0];
      for (const s of sent.values()) if (s.t < old) lost[s.p]++;
      return out.map((o, i) => {
        let n = o.at.length; while (n && o.at[n - 1] >= old) n--;
        return n ? { n, loss: 100 * lost[i] / n, jit: jitterOf(o.rtts) } : null;
      });
    },
    // stop sending, give the last packets WAIT_MS to come back, ask the server what reached it, close
    async stop() {
      await timeout(ready, 7000).catch(() => {});
      clearInterval(tick);
      let res = null;
      if (state === "open") {
        await new Promise(r => setTimeout(r, WAIT_MS));
        try { dc.send("n"); await new Promise(r => setTimeout(r, 400)); } catch (e) {}
        res = out.map((o, i) => lossOf(o.sent, counts ? counts[i] : null, o.rtts));
      }
      try { pc.close(); } catch (e) {}
      return { state, phases: res };
    },
  };
}

// 10 echoes over each, 100 ms apart, the first of each not counted (it opens the way)
export async function quic(sig = SIG, wt = WT) {
  const api = typeof WebTransport === "function";
  const n = 10, gap = 100;
  const ws = await (async () => {
    const s = new WebSocket(sig.replace(/^http/, "ws") + "/ws"); s.binaryType = "arraybuffer";
    try {
      await timeout(new Promise((res, rej) => { s.onopen = res; s.onerror = rej; }), 5000);
      const rtts = [];
      for (let i = 0; i <= n; i++) {
        const t = performance.now();
        await timeout(new Promise(res => { s.onmessage = res; s.send(new Uint8Array([i])); }), 3000);
        if (i) rtts.push(performance.now() - t);
        await new Promise(r => setTimeout(r, gap));
      }
      return { rtt: medianOf(rtts) };
    } catch (e) { return null; } finally { try { s.close(); } catch (e) {} }
  })();
  const w = !api ? null : await (async () => {
    let tr = null;
    try {
      tr = new WebTransport(wt);
      tr.closed.catch(() => {});     // rejects when the connection fails or is torn down: not an error here (1ms-shell#69)
      await timeout(tr.ready, 5000);
      const wr = tr.datagrams.writable.getWriter(), rd = tr.datagrams.readable.getReader();
      const back = new Map();
      (async () => { for (;;) { const { value, done } = await rd.read(); if (done) break; back.set(value[0], performance.now()); } })().catch(() => {});
      const at = [];
      for (let i = 0; i <= n; i++) { at[i] = performance.now(); await wr.write(new Uint8Array([i])); await new Promise(r => setTimeout(r, gap)); }
      await new Promise(r => setTimeout(r, 500));
      const rtts = []; let lost = 0;
      for (let i = 1; i <= n; i++) back.has(i) ? rtts.push(back.get(i) - at[i]) : lost++;
      return rtts.length ? { rtt: medianOf(rtts), lost: lost / n } : null;
    } catch (e) { return null; } finally { try { tr && tr.close(); } catch (e) {} }
  })();
  return { verdict: quicVerdict({ api, wt: w, ws }), wt: w, ws };
}

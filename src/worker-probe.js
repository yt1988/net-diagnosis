// Dedicated worker: keeps the schedule. A hidden tab throttles the page's own timers hard (Chrome, 2026-11-06:
// a setTimeout chain in a background tab went from 1/s to almost nothing within a minute, about one every 2 s with
// a WebRTC connection open) but leaves a worker's timers at 1/s. So the HTTPS probes run here, and the page is told
// when to probe STUN (RTCPeerConnection only exists on the page) and when a window closes.
//   in:  { cmd: 'start', plan: [{ id, url, every }], stunEvery, window }   { cmd: 'stop' }
//   out: { type: 'sample', id, t, ms, setup, proto, cold }   { type: 'stun', t }   { type: 'tick', t, lag }
import { https } from './probes.mjs';

let timers = [], busy = new Set(), seen = new Set(), lags = [];

function stop() { timers.forEach(clearInterval); timers = []; busy.clear(); }

self.onmessage = ({ data }) => {
  if (data.cmd === 'stop') { stop(); return; }
  if (data.cmd !== 'start') return;
  stop();
  for (const p of data.plan) {
    const run = async () => {
      if (busy.has(p.id)) return; // one request per host at a time
      busy.add(p.id);
      const r = await https(p.url);
      busy.delete(p.id);
      const cold = !seen.has(p.id); // the first request also opens the connection
      seen.add(p.id);
      self.postMessage({ type: 'sample', id: p.id, t: Date.now(), ms: r.ms, setup: r.setup ?? null, proto: r.proto ?? null, cold });
    };
    run();
    timers.push(setInterval(run, p.every));
  }
  // how late this worker's own 250 ms timer fires: a device too busy to measure on time
  let last = performance.now();
  timers.push(setInterval(() => { const now = performance.now(); lags.push(Math.max(0, now - last - 250)); last = now; }, 250));
  timers.push(setInterval(() => self.postMessage({ type: 'stun', t: Date.now() }), data.stunEvery));
  timers.push(setInterval(() => {
    const s = [...lags].sort((a, b) => a - b); lags = [];
    self.postMessage({ type: 'tick', t: Date.now(), lag: s.length ? s[Math.floor(s.length * 0.95)] : null });
  }, data.window));
};

// Dedicated worker for check A: ticks once a second with setInterval and, when asked, times a request itself.
let timer = null;

self.onmessage = (e) => {
  const { cmd, fetchUrl } = e.data;
  if (cmd === 'start') {
    clearInterval(timer);
    timer = setInterval(async () => {
      const t = Date.now();
      let rtt = null;
      if (fetchUrl) {
        const s = performance.now();
        try { await (await fetch(`${fetchUrl}?w=${t}`, { cache: 'no-store' })).arrayBuffer(); rtt = performance.now() - s; } catch { rtt = -1; }
      }
      self.postMessage({ t, rtt });
    }, 1000);
  } else if (cmd === 'stop') {
    clearInterval(timer);
    timer = null;
  }
};

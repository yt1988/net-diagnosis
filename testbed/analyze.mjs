// Per-answer analysis: every server-reflexive answer in a probe (one per local socket / address family) is its own
// request. The answer count a probe should get is the most common count in phase 0; a missing answer = a timeout.
//   node analyze.mjs results.json phases.log
import { readFileSync } from 'node:fs';

const [, , resFile, logFile] = process.argv;
const raw = JSON.parse(readFileSync(resFile, 'utf8')).e.raw;
const phases = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => { const [s, v] = l.split(' '); return { t: Number(s) * 1000, plr: v === 'end' ? null : Number(v) }; });
const RETX = [0, 250, 750, 1750];
const q = (s, p) => { if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const answers = (s) => (s.ok ? [s.ms, ...(s.more || [])] : []);

function classify(ms, base) {
  const ex = ms - base;
  let k = 0, err = Infinity;
  RETX.forEach((c, j) => { const d = Math.abs(ex - c); if (d < err) { err = d; k = j; } });
  return k > 0 && err > Math.max(60, Math.min(100, base * 0.5)) ? -1 : k; // -1: slow, not on a retransmission step
}

const rows = [];
for (const target of raw) {
  const inPhase = (i, skip = 5000) => target.samples.filter((s) => s.at >= phases[i].t + skip && s.at < phases[i + 1].t);
  const p0 = inPhase(0, 0);
  const counts = {};
  p0.forEach((s) => { const n = answers(s).length; counts[n] = (counts[n] || 0) + 1; });
  const expected = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const base = q(p0.flatMap(answers).sort((a, b) => a - b), 0.1);
  for (let i = 0; i < phases.length - 1; i++) {
    let sends = 0, lost = 0, slow = 0, missing = 0;
    const ks = [0, 0, 0, 0];
    let firstOnlySends = 0, firstOnlyLost = 0;
    for (const s of inPhase(i)) {
      const a = answers(s);
      for (const ms of a) {
        const k = classify(ms, base);
        if (k < 0) { slow++; sends++; continue; }
        ks[k]++; sends += k + 1; lost += k;
      }
      const miss = Math.max(0, expected - a.length);
      missing += miss; sends += 4 * miss; lost += 4 * miss;
      // the prototype's current view: first answer only
      if (!s.ok) { firstOnlySends += 4; firstOnlyLost += 4; } else { const k = Math.max(0, classify(s.ms, base)); firstOnlySends += k + 1; firstOnlyLost += k; }
    }
    rows.push({
      server: target.url.replace('stun:', ''), injected: `${phases[i].plr * 100}%`, answersPerProbe: expected, base: +base.toFixed(1),
      'inferred (every answer)': sends ? +(lost / sends * 100).toFixed(2) : null,
      'inferred (first answer only)': firstOnlySends ? +(firstOnlyLost / firstOnlySends * 100).toFixed(2) : null,
      k: ks.join('/'), missing, slow,
    });
  }
}
console.table(rows);

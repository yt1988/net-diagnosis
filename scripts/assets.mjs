#!/usr/bin/env node
// Renders the link-preview images with resvg (dev dependency), 1200 × 630: public/og/<lang>.png for each language.
// Run when the headline or the subtitle change, and commit the output. Uses system fonts for the text (Windows:
// Segoe UI, Microsoft YaHei, Microsoft JhengHei, Yu Gothic UI, Malgun Gothic, Consolas), as the other 1ms.dog tools do.
// Usage: node scripts/assets.mjs
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const pub = new URL('../public/', import.meta.url), src = new URL('../src/', import.meta.url);
const HOST = new URL(process.env.SITE_URL || 'https://lag.1ms.dog').host;
const FONTS = { 'zh-CN': 'Microsoft YaHei', 'zh-TW': 'Microsoft JhengHei', ja: 'Yu Gothic UI', ko: 'Malgun Gothic' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = async (f) => Buffer.from(await readFile(new URL(f, pub))).toString('base64');
const render = (svg) => new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
const OK = '#3ecf8e', WARN = '#f5a524', BAD = '#f56565', INK = '#818cf8';

// the lanes as the page draws them: one lane worse for a stretch while the others hold, which is the tool's point
const LANES = [['lane_device', ''], ['lane_near', ''], ['lane_far', 'far'], ['lane_udp', ''], ['lane_svc', '']];
const cell = (lane, i) => (lane === 'far' && i >= 9 && i <= 12 ? (i === 12 ? WARN : BAD) : OK);

async function card(lang, d) {
  const ff = `${FONTS[lang] ? `'${FONTS[lang]}', ` : ''}'Segoe UI', 'Microsoft YaHei', sans-serif`;
  const logo = await b64('assets/logo-dark.svg');
  // headline and subtitle fit the left column (500 px): wrapped by estimated width, wide characters counting double
  const wide = (ch) => /[　-鿿가-힯＀-￯]/.test(ch), est = (t, px) => [...t].reduce((a, ch) => a + (wide(ch) ? 1 : 0.56) * px, 0);
  const wrap = (text, px, w = 500) => {
    const out = [];
    let cur = '';
    for (const word of text.split(/(?<=[ ，、？?,：:])/)) {
      for (const piece of est(word, px) > w ? [...word] : [word]) {
        if (cur && est(cur + piece, px) > w) { out.push(cur.trim()); cur = ''; }
        cur += piece;
      }
    }
    return [...out, cur.trim()];
  };
  let size = 58, lines;
  for (; (lines = wrap(d.h1, size)).length > 2 && size > 38; size -= 4);
  const subs = wrap(d.og_sub, 26).slice(0, 3);
  const top = 214 - (subs.length - 1) * 18 + (lines.length > 1 ? 0 : 26);
  const head = lines.map((l, i) => `<text x="72" y="${top + i * (size + 12)}" font-size="${size}" font-weight="700" fill="#ededed">${esc(l)}</text>`).join('');
  const subY = top + (lines.length - 1) * (size + 12) + 58;
  const subText = subs.map((l, i) => `<text x="72" y="${subY + i * 36}" font-size="26" fill="#a0a0a0">${esc(l)}</text>`).join('');
  const barY = subY + (subs.length - 1) * 36 + 42;
  // the panel: a verdict line and the lanes
  const label = (k, w) => {
    const px = Math.max(14, Math.min(20, Math.floor(w / est(k, 1))));
    return `font-size="${px}">${esc(k)}`;
  };
  const verdict = wrap(d.v_crossborder, 22, 500).slice(0, 2);
  const vText = verdict.map((l, i) => `<text x="632" y="${208 + i * 30}" font-size="22" font-weight="700" fill="${BAD}">${esc(l)}</text>`).join('');
  const y0 = 208 + verdict.length * 30 + 24;
  const rows = LANES.map(([k, id], r) => {
    const y = y0 + r * 52;
    const cells = Array.from({ length: 16 }, (_, i) => `<rect x="${800 + i * 21}" y="${y - 18}" width="17" height="24" rx="4" fill="${cell(id, i)}"/>`).join('');
    return `<text x="632" y="${y}" fill="#ededed" font-weight="600" ${label(d[k], 156)}</text>${cells}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${ff}">
<rect width="1200" height="630" fill="#1c1c1c"/>
<rect x="600" y="150" width="568" height="400" rx="20" fill="#232323" stroke="#363636"/>
<image x="72" y="56" width="180" height="72" href="data:image/svg+xml;base64,${logo}"/>
${head}
${subText}
<rect x="72" y="${barY}" width="120" height="6" rx="3" fill="${INK}"/>
${vText}
${rows}
<text x="72" y="584" font-size="26" font-weight="600" fill="${INK}">${HOST}</text>
<text x="1128" y="584" font-size="22" fill="#a0a0a0" text-anchor="end">Wi‑Fi · ISP · proxy · UDP · loss · jitter</text>
</svg>`;
}

await mkdir(new URL('og/', pub), { recursive: true });
for (const f of (await readdir(new URL('i18n/', src))).filter((f) => f.endsWith('.mjs'))) {
  const lang = f.slice(0, -4), d = (await import(new URL('i18n/' + f, src).href)).default;
  const png = render(await card(lang, d));
  await writeFile(new URL(`og/${lang.toLowerCase()}.png`, pub), png);
  console.log(`og/${lang.toLowerCase()}.png ${Math.round(png.length / 1024)} KB`);
}

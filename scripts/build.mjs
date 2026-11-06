#!/usr/bin/env node
// Builds the static site in public/ from src/ (the layout follows speed-test):
//   index.html, <lang>/index.html                 the page per language (only languages with an i18n file)
//   assets/app.<hash>.js, assets/app.<hash>.css   the page's code and styles, shared by every language
//   assets/w.<hash>.js                            the dedicated worker that keeps the schedule (src/worker-probe.js)
//   assets/l.<lang>.<hash>.js                     the strings the browser code needs, per language
//   sitemap.xml, robots.txt, llms.txt, _headers   SEO and security headers (CSP: the measured hosts)
// Usage: node scripts/build.mjs          write the files
//        node scripts/build.mjs --check  exit 1 if anything in public/ is out of date (CI)
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build as bundle, transform } from 'esbuild';
import { ORIGINS } from '../src/targets.mjs';

const SITE = (process.env.SITE_URL || 'https://diag.1ms.dog').replace(/\/+$/, '');
const pub = new URL('../public/', import.meta.url), src = new URL('../src/', import.meta.url);
// language, URL folder, og:locale; the first is the root
export const LANGS = [['en', '', 'en_US'], ['zh-CN', 'zh-cn', 'zh_CN'], ['zh-TW', 'zh-tw', 'zh_TW'], ['ja', 'ja', 'ja_JP'], ['ko', 'ko', 'ko_KR'],
  ['es', 'es', 'es_ES'], ['fr', 'fr', 'fr_FR'], ['de', 'de', 'de_DE'], ['pt', 'pt', 'pt_BR'], ['ru', 'ru', 'ru_RU']];

// Runs before first paint: apply the saved theme. On the English root, send visitors to their language's page
// (a saved choice first, then the browser languages); crawlers and English readers stay.
const PREPAINT = `(function(){var d=document.documentElement,th=null,s=null;try{th=localStorage.getItem("netdiag:theme");s=localStorage.getItem("netdiag:lang")}catch(e){}if(th==="light"||th==="dark")d.setAttribute("data-theme",th);if(!d.hasAttribute("data-root"))return;var P=JSON.parse(d.getAttribute("data-paths")||"{}"),l=null;try{var q=new URLSearchParams(location.search).get("lang");if(P[q])l=q}catch(e){}if(!l&&P[s])l=s;for(var ls=navigator.languages||[navigator.language||"en"],i=0;!l&&!s&&i<ls.length;i++){var x=String(ls[i]).toLowerCase(),b=x.split("-")[0];l=b==="zh"?(/tw|hk|mo|hant/.test(x)?"zh-TW":"zh-CN"):P[b]?b:null}if(l&&l!=="en"&&P[l])location.replace(P[l]+location.search+location.hash)})();`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const sha = (s) => createHash('sha256').update(s).digest('base64');

async function loadI18n() {
  const out = {};
  for (const f of (await readdir(new URL('i18n/', src))).filter((f) => f.endsWith('.mjs')))
    out[f.slice(0, -4)] = (await import(new URL('i18n/' + f, src).href + '?' + Date.now())).default;
  return out;
}

// strings only the build uses (the page already shows them); everything else goes to the browser
const BUILD_ONLY = new Set(['name', 'seo_title', 'seo_desc', 'seo_kw', 'og_sub', 'h1', 'docs', 'lang_label', 'faq_h', 'lead']);
const LANES = ['device', 'direct', 'near', 'far', 'udp', 'svc'];

export async function build({ check = false } = {}) {
  const I = await loadI18n(), en = I.en;
  const langs = LANGS.filter(([l]) => I[l]);
  for (const [l] of langs) for (const k of Object.keys(en)) if (!(k in I[l])) throw new Error(`i18n/${l}.mjs is missing "${k}"`);
  const tpl = await readFile(new URL('page.html', src), 'utf8');

  const root = fileURLToPath(new URL('..', import.meta.url));
  const opts = { bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', write: false, absWorkingDir: root };
  const js = (await bundle({ ...opts, entryPoints: [fileURLToPath(new URL('app.js', src))] })).outputFiles[0].text;
  const wjs = (await bundle({ ...opts, entryPoints: [fileURLToPath(new URL('worker-probe.js', src))] })).outputFiles[0].text;
  const cssFull = (await Promise.all(['fonts.css', 'base.css', 'style.css'].map((f) => readFile(new URL(f, src), 'utf8')))).join('\n');
  const css = (await transform(cssFull, { loader: 'css', minify: true, legalComments: 'none' })).code;
  const jsName = `app.${hash(js)}.js`, cssName = `app.${hash(css)}.css`, wName = `w.${hash(wjs)}.js`;
  const files = { ['assets/' + jsName]: js, ['assets/' + cssName]: css, ['assets/' + wName]: wjs };

  const path = (slug) => '/' + (slug ? slug + '/' : '');
  for (const [lang, slug, locale] of langs) {
    const d = I[lang], T = (k) => { if (!(k in d)) throw new Error(`i18n/${lang}.mjs has no "${k}"`); return d[k]; };
    const keys = [...Object.keys(en), ...Object.keys(d).filter((k) => !(k in en))];
    const strings = Object.fromEntries(keys.filter((k) => !BUILD_ONLY.has(k)).map((k) => [k, T(k)]));
    const sjs = `window.L1MS=${JSON.stringify(strings).replace(/</g, '\\u003c')};\n`;
    const sName = `l.${lang.toLowerCase()}.${hash(sjs)}.js`;
    files['assets/' + sName] = sjs;

    const url = SITE + path(slug), docs = T('docs');
    const alts = langs.map(([l, sl]) => `<link rel="alternate" hreflang="${l}" href="${SITE + path(sl)}">`).join('\n') + `\n<link rel="alternate" hreflang="x-default" href="${SITE}/">`;
    const graph = [
      { '@type': 'WebApplication', name: T('app_name') + ' · 1ms.dog', url, applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript', description: T('seo_desc'), inLanguage: lang, isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
      { '@type': 'FAQPage', mainEntity: docs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a.replace(/\n+/g, ' ') } })) },
    ];
    const head = [
      `<title>${esc(T('seo_title'))}</title>`,
      `<meta name="description" content="${esc(T('seo_desc'))}">`,
      `<meta name="keywords" content="${esc(T('seo_kw'))}">`,
      ...(lang === 'zh-CN' ? ['<meta http-equiv="Cache-Control" content="no-transform">', '<meta http-equiv="Cache-Control" content="no-siteapp">', '<meta name="applicable-device" content="pc,mobile">'] : []),
      '<meta name="robots" content="index, follow, max-image-preview:large">',
      `<meta name="application-name" content="${esc(T('app_name'))}">`,
      '<meta name="theme-color" content="#f6f6f7" media="(prefers-color-scheme: light)">',
      '<meta name="theme-color" content="#1c1c1c" media="(prefers-color-scheme: dark)">',
      `<link rel="canonical" href="${url}">`, alts,
      '<link rel="icon" href="/favicon.ico" sizes="any">', '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
      `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="1ms.dog">`,
      `<meta property="og:title" content="${esc(T('seo_title'))}">`, `<meta property="og:description" content="${esc(T('og_sub'))}">`, `<meta property="og:url" content="${url}">`,
      `<meta property="og:locale" content="${locale}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${esc(T('seo_title'))}">`, `<meta name="twitter:description" content="${esc(T('og_sub'))}">`,
      `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>`,
    ].join('\n');

    const helpNav = docs.map(([q], i) => `<button type="button" role="tab" data-hq="${i}" aria-selected="${i === 0}">${esc(q)}</button>`).join('');
    const helpC = docs.map(([q, a], i) => `<article data-hqb="${i}"${i ? ' hidden' : ''}><h3>${esc(q)}</h3>${a.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</article>`).join('');
    const langOpts = langs.map(([l]) => `<option value="${l}"${l === lang ? ' selected' : ''}>${esc(I[l].name)}</option>`).join('');
    const paths = Object.fromEntries(langs.map(([l, sl]) => [l, path(sl)]));
    const lanes = LANES.map((k) => `<li data-lane="${k}"${k === 'direct' ? ' hidden' : ''}><span class="ln-k" title="${esc(T('lane_tip_' + k))}" tabindex="0">${esc(T('lane_' + k))}</span><span class="ln-st" data-st="none">${esc(T('st_none'))}</span><span class="ln-v">&nbsp;</span><span class="ln-tl" aria-hidden="true"></span></li>`).join('');

    const html = tpl
      .replace(/(<(\w+)\b[^>]*\sdata-i="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, k, inner, close) => open + esc(T(k)) + close)
      .replace(/\{\{a:(\w+)\}\}/g, (m, k) => esc(T(k)))
      .replace('{{lang}}', lang).replace('{{pathsAttr}}', esc(JSON.stringify(paths))).replace('{{rootAttr}}', slug ? '' : ' data-root')
      .replace('{{prepaint}}', PREPAINT).replace('{{head}}', head).replace('{{css}}', cssName).replace('{{js}}', jsName).replace('{{strings}}', sName)
      .split('{{homeHref}}').join(path(slug)).replace('{{langOpts}}', langOpts).replace('{{h1}}', esc(T('h1'))).replace('{{lanes}}', lanes)
      .replace('{{helpNav}}', helpNav).replace('{{helpC}}', helpC)
      .replace('{{data}}', JSON.stringify({ lang, paths, worker: '/assets/' + wName }).replace(/</g, '\\u003c'));
    if (/\{\{[\w:]+\}\}/.test(html)) throw new Error('unfilled placeholder in ' + path(slug) + ': ' + /\{\{[\w:]+\}\}/.exec(html)[0]);
    files[(slug ? slug + '/' : '') + 'index.html'] = html;
  }

  files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    langs.map(([, s]) => `  <url>\n    <loc>${SITE + path(s)}</loc>\n` + langs.map(([l, s2]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE + path(s2)}"/>`).join('\n') +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>\n  </url>`).join('\n') + '\n</urlset>\n';
  files['robots.txt'] = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
  files['llms.txt'] = `# ${en.app_name} · 1ms.dog

> Free in-browser network diagnosis: when the internet lags, it tells which part of the path is at fault. It measures,
> at once and from the visitor's own device, the nearest Cloudflare location, single-location cloud regions in Tokyo,
> Frankfurt and Virginia, services the visitor picks, and UDP to public STUN servers (loss inferred from STUN
> retransmission delays, validated against injected loss). Every 5 seconds it compares the paths: all worse = the
> visitor's side (Wi-Fi, router, ISP); near fine, far worse = long-haul route; one service worse = that service;
> UDP losing while HTTPS is fine = games and calls will stutter. With a proxy in mainland China, domestic sites stand
> for the visitor's own line and Cloudflare through the proxy for the way to the proxy server. 20-second verdict,
> then optional monitoring with an incident log. Nothing is sent to this site.

- Page: ${SITE}/ (also ${langs.slice(1).map(([, s]) => '/' + s + '/').join(', ')})
- Source code: https://github.com/yt1988/net-diagnosis
`;
  const csp = ["default-src 'self'", `script-src 'self' 'sha256-${sha(PREPAINT)}'`, "worker-src 'self'", "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:",
    "connect-src 'self' " + ORIGINS.join(' '),
    "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
  files['_headers'] = `# Generated by scripts/build.mjs
/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
/assets/*
  Cache-Control: public, max-age=604800
/assets/app.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/w.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/l.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/fonts/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/llms.txt
  Access-Control-Allow-Origin: *
  Content-Type: text/plain; charset=utf-8
`;

  const gen = async () => { try { return (await readdir(new URL('assets/', pub))).filter((f) => /^(app|l|w)\..+\.(js|css)$/.test(f)).map((f) => 'assets/' + f); } catch { return []; } };
  const stale = [];
  for (const [f, body] of Object.entries(files)) {
    let cur = null; try { cur = await readFile(new URL(f, pub), 'utf8'); } catch {}
    if (cur !== body) stale.push(f);
  }
  const orphans = (await gen()).filter((f) => !(f in files));
  if (check) return [...stale, ...orphans];
  for (const f of stale) { await mkdir(new URL('.', new URL(f, pub)), { recursive: true }); await writeFile(new URL(f, pub), files[f]); }
  for (const f of orphans) await rm(new URL(f, pub));
  return [...stale, ...orphans];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const changed = await build({ check });
  if (check && changed.length) { console.error('public/ is out of date: ' + changed.join(', ') + '\nRun npm run build and commit public/.'); process.exit(1); }
  console.log(check ? 'public/ is up to date' : changed.length ? 'wrote ' + changed.join(', ') : 'nothing to do');
}

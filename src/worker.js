// The Network Diagnosis Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
//   /r/<code>, /<lang>/r/<code>   a shared result: that language's page with the verdict in its title and the numbers
//                                 in its description (what chat apps show as the link's preview), not indexed; the
//                                 page itself reads the code and shows the result (src/share.mjs)
//                                 A code it can't read is a 404 like any other path.
//   anything else                 a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it

import { decode, sharePath } from './share.mjs';
import { NEAR, DIRECT, SERVICES, FAR } from './targets.mjs';
import en from './i18n/en.mjs';
import zhCN from './i18n/zh-CN.mjs';
import zhTW from './i18n/zh-TW.mjs';
import ja from './i18n/ja.mjs';
import ko from './i18n/ko.mjs';
import es from './i18n/es.mjs';
import fr from './i18n/fr.mjs';
import de from './i18n/de.mjs';
import pt from './i18n/pt.mjs';
import ru from './i18n/ru.mjs';

// each language's strings by its folder ("" is English, at the root), and its code for the names
const STR = { '': [en, 'en'], 'zh-cn': [zhCN, 'zh-CN'], 'zh-tw': [zhTW, 'zh-TW'], ja: [ja, 'ja'], ko: [ko, 'ko'], es: [es, 'es'], fr: [fr, 'fr'], de: [de, 'de'], pt: [pt, 'pt'], ru: [ru, 'ru'] };
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const nameOf = (n, lang) => (typeof n === 'string' ? n : n[lang] || n.other);
const nameIn = (id, S, lang) => [NEAR, ...DIRECT.CN, ...SERVICES].map((x) => (x.id === id ? nameOf(x.name, lang) : null)).find(Boolean)
  || (FAR.some((f) => f.id === id) ? S['far_' + id] : id);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed\n', { status: 405 });
    const sp = sharePath(url.pathname);
    const r = sp && STR[sp.slug] && env.ASSETS && decode(sp.code);
    if (r) return shared(req, env, url, sp.slug, r);
    return new Response(req.method === 'HEAD' ? null : 'Not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' },
    });
  },
};

// A shared result: the language's page as it is, with the title, description and their Open Graph and Twitter copies
// carrying the verdict and the numbers.
async function shared(req, env, url, slug, r) {
  const home = '/' + (slug ? slug + '/' : '');
  const [S, lang] = STR[slug];
  const verdict = fill(S['v_' + r.key], { names: r.ids.map((id) => nameIn(id, S, lang)).join(' / ') });
  const title = `${verdict} · ${S.app_name}`;
  const desc = [r.near != null && `${S.k_near} ${Math.round(r.near)} ms`, r.jitter != null && `${S.k_jitter} ${r.jitter.toFixed(1)} ms`,
    r.loss != null && `${S.k_udp} ${r.loss.toFixed(1)}%`, fill(S.st_final, { t: `${Math.floor(r.secs / 60)}:${String(r.secs % 60).padStart(2, '0')}` })].filter(Boolean).join(' · ');
  const page = await env.ASSETS.fetch(new Request(new URL(home, url), { headers: req.headers }));
  if (!page.ok) return page;
  const attr = (val, name = 'content') => ({ element: (e) => e.setAttribute(name, val) });
  const out = new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent(title) })
    .on('meta[name="description"]', attr(desc))
    .on('meta[property="og:title"]', attr(title)).on('meta[name="twitter:title"]', attr(title))
    .on('meta[property="og:description"]', attr(desc)).on('meta[name="twitter:description"]', attr(desc))
    .on('meta[property="og:url"]', attr(url.origin + url.pathname))
    .on('meta[name="robots"]', attr('noindex, follow'))
    .transform(page);
  const h = new Headers(out.headers);
  h.delete('etag');
  h.set('cache-control', 'public, max-age=3600');
  h.set('x-robots-tag', 'noindex');
  return new Response(req.method === 'HEAD' ? null : out.body, { status: 200, headers: h });
}

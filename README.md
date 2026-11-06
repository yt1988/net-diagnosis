# Network Diagnosis

**English** · [简体中文](README.zh-CN.md)

Internet lagging? Network Diagnosis measures several paths at once from your own browser and tells which part is at
fault: your device, your Wi‑Fi and ISP, the long-haul route, a proxy, or one service. A verdict in 20 seconds, then
optional monitoring that logs every incident.

## What it measures

| Part of the path | Probe | Every |
|---|---|---|
| Device | how late a 250 ms timer fires in the worker | continuous |
| Nearby | the nearest Cloudflare location (`speed.cloudflare.com`); in mainland China, domestic sites | 1 s |
| Distant | single-location cloud regions: Tokyo, Frankfurt, Virginia (AWS DynamoDB `/ping`) | 5 s |
| UDP | ICE gathering against public STUN servers (Cloudflare, Google; Xiaomi and Bilibili in mainland China) | 1 s |
| Services | the ones you pick (ChatGPT, Google, GitHub…; the endpoints 1ms.dog checks daily) | 5 s |

Each 5-second window is judged by `src/lib.mjs`. All paths worse together means your side (Wi‑Fi, router, ISP).
Nearby fine but distant worse means the long-haul route. Only one service worse means that service. HTTPS fine but
UDP losing packets means games and calls will stutter. With a proxy in mainland China, domestic sites (not proxied)
stand for your own line, Cloudflare through the proxy for the way to the proxy server, and the distant regions for
what lies past it. Every verdict lists its evidence and a confidence.

**UDP loss** comes from STUN retransmission delays. libwebrtc resends a lost request after 250 ms, then 500 and
1000 ms more, so a late answer shows how many sends were lost. Every server-reflexive answer counts on its own,
because IPv4 and IPv6 ask separately and the first answer hides a loss on the other. This was validated on a Linux
VPS by dropping incoming STUN answers at random: injected 2 / 5 / 10 % read back as 1.3–2.0 / 4.4–4.8 / 8.2–9.1 %
(`test/fixtures/stun-loss-2026-11-06.json`, replayed in the tests).

**The schedule runs in a dedicated worker.** In a background tab Chrome slows a page's timer chain to once a
minute (once every 2 s with a WebRTC connection open) but leaves a worker at once a second (measured
2026-11-06, Chrome 156).

## Develop

```bash
npm install
npm run dev     # http://localhost:8804
npm run build   # regenerate public/ after changing src/ (public/ is committed)
npm test        # public/ up to date, logic unit tests and labelled scenario replays
```

```
src/lib.mjs           pure logic: stats, STUN loss, target states, attribution, scores, incidents (unit-tested)
src/targets.mjs       what is measured
src/probes.mjs        HTTPS and STUN probes, Cloudflare's view of the exit
src/worker-probe.js   the schedule and the HTTPS probes, in a dedicated worker
src/app.js            the page: windows, verdict, lanes, incident log, notifications
src/i18n/*.mjs        strings; en is the reference
scripts/build.mjs     builds public/: pages per language, sitemap, robots, llms.txt, _headers (CSP)
```

## License

[MIT](LICENSE). The Shiba Inu artwork and the 1ms.dog logo are the project's brand; if you run a public copy under
another name, use your own.

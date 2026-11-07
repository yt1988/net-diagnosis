# AGENTS.md

For anyone working in this repository, people and AI agents alike. What the tool measures and how the code is laid
out are in [README.md](README.md); how it measures, judges and scores is in [docs/design.md](docs/design.md); the
technical reasons and the measurements behind them are in [docs/decisions.md](docs/decisions.md).
1ms.dog's operations (the machines, who maintains what, accounts) are described in the private repository
1ms-shell, not here.

## What this is

Network Diagnosis (lag.1ms.dog) answers "the internet lags: which part of the path is at fault?". Everything runs in
the visitor's browser; nothing is measured from a server and no result is sent anywhere.

- **The page** (`src/`, built into `public/`): measures the nearest Cloudflare location, cloud regions in Tokyo,
  Frankfurt and Virginia, services the visitor picks, UDP to public STUN servers and, when it finds one, the home
  router. Every 5 seconds `src/lib.mjs` judges the window and names the part at fault.
- **The dedicated worker** (`src/worker-probe.js`): keeps the schedule and runs the HTTPS probes, because a page's own
  timers slow to once a minute in a background tab. STUN runs on the page when the worker says so.
- **The Worker** (`src/worker.js`): only runs for shared result links (`/r/<code>`), to put the verdict in the
  link's preview title. Everything else is a static file.
- **Outside this repository**: the exact UDP / QUIC test talks to `rtc.1ms.dog`, the WebRTC echo server of
  [speed-test](https://github.com/yt1988/speed-test/tree/main/server). It answers only the origins on its allowlist.
  `src/rtc.mjs` is a copy of speed-test's: change both together.

## Run it locally

```bash
npm ci
npm run build      # src/ → public/; commit public/ with your change
npm run dev        # http://localhost:8804, with the Worker, so /r/ links open too
npm test           # public/ up to date, then the unit tests
```

The exact UDP test needs an echo server that accepts your page's origin (its address is in `src/rtc.mjs`). The
router lane needs Chrome and asks for local network access. Behind a proxy app in TUN or fake-ip mode, UDP and the "nearby" lane measure the proxy, not the
line: that is expected, and what the proxy logic in `src/lib.mjs` is for.

## Test by what you changed

| You changed | Run |
|---|---|
| strings (`src/i18n/*.mjs`) | `npm run build` (it fails when a language misses a key). Read the sentence in Chinese and Russian at 375 px wide |
| judging (`src/lib.mjs`) | `npm test`: unit tests, labelled scenarios, and the replay of the STUN loss measurements in `test/fixtures/` |
| the page (`src/app.js`, `page.html`, `style.css`) | `npm run build && npm test`, then one full 2-minute run in the browser: the verdict box keeps its height, the lanes fill, Share opens the card. Check the phone width (375 px) |
| result links (`src/share.mjs`, `src/worker.js`) | `npm test` (`test/share.test.mjs`), then open a `/r/` link under `npm run dev` and check its title; an unreadable code must be a 404 |
| the headline or subtitle | `npm run assets` to redraw `public/og/*.png`, and commit them |
| STUN loss inference | the testbed in [testbed/](testbed/) on a Linux machine with no proxy app; record the result in docs/decisions.md |

`npm test` is what the deploy runs; it must pass.

## Deploy

Pushing `main` deploys it: Cloudflare Workers Builds runs `npm ci && npm test`, then `npx wrangler deploy`, and the
new version is live in about a minute and a half. To host it yourself: `npx wrangler deploy`, then bind a domain to
the Worker in the Cloudflare dashboard. The exact UDP test then needs your own echo server (see above).

## Rules of the road

- Pushing `main` is going live: get the site owner's go-ahead first. Show changes to how the page looks before making
  them.
- `public/` is built output, committed with the source change that made it.
- The verdict box must not jump while a run fills it: later content gets its room reserved from the start.
- No secrets, no private addresses and no personal email in this public repository.
- Commit messages in English. User-facing strings exist in 10 languages; English (`src/i18n/en.mjs`) is the
  reference, and each language is written from the meaning, not translated word by word.
- When something is decided, or tried and dropped, write it in [docs/decisions.md](docs/decisions.md) the same day.

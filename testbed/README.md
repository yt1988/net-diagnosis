# Loss-injection testbed (STUN)

How the STUN loss inference in `src/lib.mjs` (`stunLoss`) was validated on 2026-11-06, kept so it can be run again
after changing the method. Results and reasons: [docs/decisions.md](../docs/decisions.md).

`page/` is the prototype's check page from before v1 (check E is the STUN check; the others are kept as they were,
and its TURN check is off and needs a Worker this folder doesn't have). `serve.py` serves it and stores the results;
`inject.sh` drops incoming STUN answers; `analyze.mjs` reads both and prints the loss per phase.

It needs a Linux machine whose browser UDP is not taken over by a proxy app: in a proxy's TUN mode the proxy grabs the
browser's UDP before iptables or pf sees it, and injected loss never shows.

1. Copy `page/`, `serve.py` and `inject.sh` to `/tmp/netdiag/` on the server.
2. Install Google Chrome there, then start the page server and headless Chrome:
   ```bash
   cd /tmp/netdiag && python3 serve.py &
   google-chrome --headless=new --no-sandbox --user-data-dir=/tmp/netdiag/chrome-profile 'http://127.0.0.1:8899/?auto=e&rate=2&secs=1250&targets=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun.miwifi.com:3478' &
   ```
3. As root, run `bash inject.sh`. It takes 20 minutes and drops 0 / 2 / 5 / 10 % of incoming STUN answers, IPv4 and
   IPv6, then removes its rules (only its own `NETDIAG` chain and one jump from `INPUT` per family).
4. Copy back `results.json` and `phases.log`, then run `node analyze.mjs results.json phases.log`.

Drop on INPUT, never OUTPUT: a packet dropped on OUTPUT makes `sendto()` fail, so Chrome resends at once and the loss
never shows up. Remove Chrome, the profile and `/tmp/netdiag/` afterwards.

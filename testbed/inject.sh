#!/bin/bash
# netdiag testbed: randomly drop a share of INCOMING STUN answers (UDP from source ports 3478, 19302), IPv4 and IPv6,
# in four 5-minute phases (0%, 2%, 5%, 10%), log when each phase starts, and always remove the rules at the end.
# Dropping on INPUT behaves like real loss: the sender is not told. (Dropping on OUTPUT makes sendto() fail at once,
# which Chrome notices, so it hid the loss in the first run.)
# Only a NETDIAG chain and one jump from INPUT per family are added; the qdisc and every other rule are left alone.
LOG=/tmp/netdiag/phases.log

cleanup() {
  for T in iptables ip6tables; do
    $T -D INPUT -p udp -m multiport --sports 3478,19302 -m comment --comment netdiag -j NETDIAG 2>/dev/null
    $T -F NETDIAG 2>/dev/null
    $T -X NETDIAG 2>/dev/null
  done
  echo "`date +%s` end" >> "$LOG"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

: > "$LOG"
for T in iptables ip6tables; do
  $T -N NETDIAG || exit 1
  $T -I INPUT 1 -p udp -m multiport --sports 3478,19302 -m comment --comment netdiag -j NETDIAG || exit 1
done

for p in 0 0.02 0.05 0.10; do
  for T in iptables ip6tables; do
    $T -F NETDIAG
    if [ "$p" != "0" ]; then $T -A NETDIAG -m statistic --mode random --probability "$p" -j DROP; fi
  done
  echo "`date +%s` $p" >> "$LOG"
  sleep 300
done

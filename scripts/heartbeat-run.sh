#!/usr/bin/env bash
# heartbeat-run.sh — overnight driver for the plans-021-025 goal run.
#
# Loops `claude` against HEARTBEAT.md, restarting after usage-limit kills,
# and PERMA-CANCELS once every checklist box in HEARTBEAT.md is checked
# (or when you say so). State lives outside the repo so the wake protocol
# never sees a dirty tree from this script.
#
#   ./scripts/heartbeat-run.sh            # start (or resume) the loop
#   ./scripts/heartbeat-run.sh status     # where things stand
#   ./scripts/heartbeat-run.sh stop       # perma-cancel (survives re-runs)
#   ./scripts/heartbeat-run.sh unstop     # clear a perma-cancel
#
# Perma-cancel = a STOP file; once present this script exits immediately
# forever (safe under cron/launchd/re-invocation). The script also writes
# it ITSELF the moment the checklist reaches zero unchecked boxes.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEARTBEAT="$REPO/HEARTBEAT.md"
CTRL="$HOME/.campaign-map-heartbeat"
STOP="$CTRL/STOP"
LOGDIR="$CTRL/logs"
mkdir -p "$LOGDIR"

GOAL_PROMPT='implement plans 021-025 per HEARTBEAT.md — resume from its checklist on every start, use opus subagents per phase, stop when all boxes are checked'

# Tunables
SHORT_NAP=180        # s between runs that did real work
LIMIT_NAP=2700       # s when a run died fast (limit almost certainly still up)
FAST_DEATH=300       # a run shorter than this = presumed limit-kill
MAX_RUNS=48          # hard safety valve

unchecked() { grep -c '^- \[ \]' "$HEARTBEAT" 2>/dev/null || echo "?"; }

case "${1:-run}" in
  status)
    echo "unchecked boxes: $(unchecked)"
    [[ -f "$STOP" ]] && echo "PERMA-CANCELLED: $(cat "$STOP")" || echo "active (no STOP file)"
    ls -t "$LOGDIR" 2>/dev/null | head -3 | sed 's/^/last logs: /'
    exit 0 ;;
  stop)
    echo "manual perma-cancel $(date '+%F %T')" > "$STOP"
    echo "STOP written: $STOP — the loop will not run again until 'unstop'."
    exit 0 ;;
  unstop)
    rm -f "$STOP" && echo "STOP cleared."
    exit 0 ;;
  run) ;;
  *) echo "usage: $0 [run|status|stop|unstop]"; exit 2 ;;
esac

if [[ -f "$STOP" ]]; then
  echo "Perma-cancelled ($(cat "$STOP")). Run '$0 unstop' to re-enable."
  exit 0
fi

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[[ -f "$HEARTBEAT" ]] || { echo "missing $HEARTBEAT"; exit 1; }

run=0
while true; do
  # --- perma-cancel checks (file may appear between runs, incl. from 'stop')
  [[ -f "$STOP" ]] && { echo "STOP file present — exiting."; exit 0; }

  left="$(unchecked)"
  if [[ "$left" == "0" ]]; then
    echo "all boxes checked $(date '+%F %T')" > "$STOP"
    echo "✅ HEARTBEAT checklist complete — perma-cancelled. Morning digest: HEARTBEAT.md §Questions + review/."
    exit 0
  fi

  run=$((run + 1))
  if (( run > MAX_RUNS )); then
    echo "max runs ($MAX_RUNS) hit with $left boxes left — stopping WITHOUT perma-cancel so it can resume."
    exit 1
  fi

  log="$LOGDIR/run-$(date '+%Y%m%d-%H%M%S').log"
  echo "── run #$run  $(date '+%F %T')  ($left boxes left) → $log"
  start=$(date +%s)

  # Unattended run. --dangerously-skip-permissions is required for a truly
  # hands-off overnight loop; the repo's own protocol (gates, byte-intact
  # dev-vault checks, commit-per-green-gate) is the guardrail.
  ( cd "$REPO" && claude -p "$GOAL_PROMPT" --dangerously-skip-permissions ) \
    >"$log" 2>&1 || echo "claude exited non-zero (expected on limit kills)"

  dur=$(( $(date +%s) - start ))
  after="$(unchecked)"
  echo "   run #$run ended after ${dur}s — boxes: $left → $after"

  # Triage a fast death by what the run actually said — an auth/config error
  # aborts loudly (napping can never fix it); only a real limit message (or
  # an unidentifiable fast death) earns the long nap.
  if (( dur < FAST_DEATH )) && [[ "$after" == "$left" ]]; then
    if grep -qiE "authenticat|oauth|logged out|login|api key" "$log"; then
      echo "❌ AUTH FAILURE — run 'claude' interactively and log in, then restart this script."
      tail -3 "$log" | sed 's/^/   > /'
      exit 1
    elif grep -qiE "usage limit|rate limit|session limit|resets [0-9]" "$log"; then
      echo "   limit-kill confirmed in log; sleeping $((LIMIT_NAP/60)) min"
      sleep "$LIMIT_NAP"
    else
      echo "   fast death, cause unclear (see $log); sleeping $((LIMIT_NAP/60)) min"
      tail -3 "$log" | sed 's/^/   > /'
      sleep "$LIMIT_NAP"
    fi
  else
    sleep "$SHORT_NAP"
  fi
done

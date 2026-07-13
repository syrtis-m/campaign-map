#!/usr/bin/env bash
# Full Obsidian quit + relaunch, then wait for the CLI + plugin to be ready.
# Used between board gates to sidestep the long-session renderer degradation.
set -u
osascript -e 'tell application "Obsidian" to quit' >/dev/null 2>&1 || true
for i in $(seq 1 20); do
  pgrep -x Obsidian >/dev/null 2>&1 || break
  sleep 1
done
sleep 2
open -a Obsidian
for i in $(seq 1 40); do
  sleep 1.5
  ready=$(obsidian vault=dev-vault eval "code=!!(app&&app.plugins&&app.plugins.plugins['campaign-map'])" 2>/dev/null | tail -1)
  case "$ready" in
    *true*) echo "obsidian ready after ${i} polls"; exit 0 ;;
  esac
done
echo "WARN: obsidian/plugin not confirmed ready" >&2
exit 1

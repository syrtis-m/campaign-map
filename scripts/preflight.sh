#!/usr/bin/env bash
# Preflight: verify environment before any build work. Fails fast with remediation.
# See docs/06-autonomous-build.md §1.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_VAULT="$REPO_ROOT/dev-vault"
FAIL=0
HUMAN_FAIL=0

ok()   { printf '  [ok]   %s\n' "$1"; }
warn() { printf '  [warn] %s\n' "$1"; }
err()  { printf '  [FAIL] %s\n' "$1"; }

echo "== Obsidian =="
if ! command -v obsidian >/dev/null 2>&1; then
  err "obsidian CLI not on PATH"
  echo "         HUMAN: install Obsidian >= 1.12.7 and enable Settings > General > Command line interface"
  HUMAN_FAIL=1
else
  VER_OUT="$(obsidian version 2>&1)"
  if [[ "$VER_OUT" == *"not found"* || "$VER_OUT" == *"Error"* ]]; then
    if ! pgrep -f "MacOS/Obsidian$" >/dev/null 2>&1 && ! pgrep -x Obsidian >/dev/null 2>&1; then
      err "Obsidian app is not running"
      echo "         HUMAN: launch Obsidian (CLI registration/launch needs a human once per machine)"
      HUMAN_FAIL=1
    else
      ok "Obsidian process running (version check inconclusive: $VER_OUT)"
    fi
  else
    ok "Obsidian $VER_OUT"
  fi
fi

echo "== dev-vault =="
if [ ! -d "$DEV_VAULT" ]; then
  warn "dev-vault/ missing — creating"
  mkdir -p "$DEV_VAULT/.obsidian"
fi
VAULT_CHECK="$(obsidian vault=dev-vault vault 2>&1)"
if [[ "$VAULT_CHECK" == *"not found"* ]]; then
  err "dev-vault is not registered with the running Obsidian app"
  echo "         Agent: register it in the app's vault list (see PROGRESS.md / DECISIONS.md for how this was done) and relaunch"
  FAIL=1
else
  ok "dev-vault registered and reachable via CLI"
  RESTRICT_OUT="$(obsidian vault=dev-vault plugins:restrict off 2>&1)"
  ok "restricted mode: $RESTRICT_OUT"
fi

echo "== Node / git / network =="
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node $(node --version)"
  else
    err "node too old ($(node --version)), need >= 20"
    FAIL=1
  fi
else
  err "node not found"
  echo "         Agent: install a local Node (see DECISIONS.md for the no-brew workaround)"
  FAIL=1
fi

if [ -d "$REPO_ROOT/.git" ]; then
  ok "git repo present"
else
  warn "not yet a git repo (agent will init)"
fi

if curl -sI --max-time 5 https://registry.npmjs.org >/dev/null 2>&1; then
  ok "network reachable"
else
  err "no network"
  HUMAN_FAIL=1
fi

echo "== Agent skills =="
if [ -d "$REPO_ROOT/.claude/skills/maplibre-agent-skills" ] || [ -d "$REPO_ROOT/.claude/skills" ] && ls "$REPO_ROOT/.claude/skills" 2>/dev/null | grep -qi maplibre; then
  ok "maplibre-agent-skills present"
else
  warn "maplibre-agent-skills not cloned yet (agent will clone in Phase 0/2)"
fi

echo "== Assets =="
if [ -f "$REPO_ROOT/assets/fonts/glyphs/Inter Regular/0-255.pbf" ]; then
  ok "Inter glyph PBFs present (assets/fonts/glyphs/)"
else
  warn "Inter glyph PBFs missing — run: npm run fonts:build"
fi

echo
if [ "$HUMAN_FAIL" -ne 0 ]; then
  echo "PREFLIGHT: blocked on a HUMAN item. Stopping per protocol."
  exit 2
fi
if [ "$FAIL" -ne 0 ]; then
  echo "PREFLIGHT: agent-fixable issues found (see FAIL lines above)."
  exit 1
fi
echo "PREFLIGHT: all checks green."
exit 0

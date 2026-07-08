#!/usr/bin/env bash
# Fetches OFL-licensed font source files into assets/fonts/src/ (gitignored — regenerate
# via this script, not committed). docs/06 §4 asset manifest.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC_DIR="assets/fonts/src"
mkdir -p "$SRC_DIR"

if [ -f "$SRC_DIR/Inter-Regular.ttf" ] && [ -f "$SRC_DIR/Inter-Bold.ttf" ]; then
  echo "Inter already present in $SRC_DIR, skipping."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching Inter v4.1 (OFL) from rsms/inter releases..."
curl -sL -o "$TMP/inter.zip" "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
unzip -o -j "$TMP/inter.zip" "extras/ttf/Inter-Regular.ttf" "extras/ttf/Inter-Bold.ttf" -d "$SRC_DIR"
echo "done."

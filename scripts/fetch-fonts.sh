#!/usr/bin/env bash
# Fetches OFL-licensed font source files into assets/fonts/src/ (gitignored — regenerate
# via this script, not committed). docs/06 §4 asset manifest / §3 pinned per-theme fonts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SRC_DIR="assets/fonts/src"
mkdir -p "$SRC_DIR"
GOOGLE_FONTS_BASE="https://github.com/google/fonts/raw/main"

fetch() {
  local dest="$SRC_DIR/$1"
  local url="$2"
  if [ -f "$dest" ]; then
    echo "  $1 already present, skipping."
    return
  fi
  echo "  fetching $1..."
  curl -sL --max-time 30 -o "$dest" "$url"
}

echo "obsidian-native fallback: Inter v4.1 (rsms/inter releases, OFL)"
if [ ! -f "$SRC_DIR/Inter-Regular.ttf" ] || [ ! -f "$SRC_DIR/Inter-Bold.ttf" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -sL -o "$TMP/inter.zip" "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
  unzip -o -j "$TMP/inter.zip" "extras/ttf/Inter-Regular.ttf" "extras/ttf/Inter-Bold.ttf" -d "$SRC_DIR"
else
  echo "  Inter already present, skipping."
fi

echo "parchment: Alegreya + Cormorant SC (Google Fonts OFL)"
fetch "Alegreya-Variable.ttf" "$GOOGLE_FONTS_BASE/ofl/alegreya/Alegreya%5Bwght%5D.ttf"
fetch "CormorantSC-Regular.ttf" "$GOOGLE_FONTS_BASE/ofl/cormorantsc/CormorantSC-Regular.ttf"
fetch "CormorantSC-SemiBold.ttf" "$GOOGLE_FONTS_BASE/ofl/cormorantsc/CormorantSC-SemiBold.ttf"

echo "ink-soot: IBM Plex Serif + Oswald (Google Fonts OFL)"
fetch "IBMPlexSerif-Regular.ttf" "$GOOGLE_FONTS_BASE/ofl/ibmplexserif/IBMPlexSerif-Regular.ttf"
fetch "IBMPlexSerif-Bold.ttf" "$GOOGLE_FONTS_BASE/ofl/ibmplexserif/IBMPlexSerif-Bold.ttf"
fetch "Oswald-Variable.ttf" "$GOOGLE_FONTS_BASE/ofl/oswald/Oswald%5Bwght%5D.ttf"

echo "neon-sprawl: Rajdhani + Saira Condensed (Google Fonts OFL)"
fetch "Rajdhani-Regular.ttf" "$GOOGLE_FONTS_BASE/ofl/rajdhani/Rajdhani-Regular.ttf"
fetch "Rajdhani-Bold.ttf" "$GOOGLE_FONTS_BASE/ofl/rajdhani/Rajdhani-Bold.ttf"
fetch "SairaCondensed-Regular.ttf" "$GOOGLE_FONTS_BASE/ofl/sairacondensed/SairaCondensed-Regular.ttf"
fetch "SairaCondensed-Bold.ttf" "$GOOGLE_FONTS_BASE/ofl/sairacondensed/SairaCondensed-Bold.ttf"

echo "done."

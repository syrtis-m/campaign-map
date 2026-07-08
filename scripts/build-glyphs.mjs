#!/usr/bin/env node
// Generates SDF glyph PBFs (MapLibre glyphs protocol) from OFL TTFs in assets/fonts/src/.
// One stack per theme font (docs/06 §3 pinned table). Alegreya/Oswald are variable fonts —
// fontnik/freetype reads their default-weight instance; there is no separate static Bold
// cut upstream, so bold-ness for those two is approximated with size/halo, not font-weight.
import fontnik from "fontnik";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FONTS = [
  // obsidian-native fallback
  { file: "assets/fonts/src/Inter-Regular.ttf", stack: "Inter Regular" },
  { file: "assets/fonts/src/Inter-Bold.ttf", stack: "Inter Bold" },
  // parchment
  { file: "assets/fonts/src/Alegreya-Variable.ttf", stack: "Alegreya Regular" },
  { file: "assets/fonts/src/CormorantSC-Regular.ttf", stack: "Cormorant SC Regular" },
  { file: "assets/fonts/src/CormorantSC-SemiBold.ttf", stack: "Cormorant SC SemiBold" },
  // ink-soot
  { file: "assets/fonts/src/IBMPlexSerif-Regular.ttf", stack: "IBM Plex Serif Regular" },
  { file: "assets/fonts/src/IBMPlexSerif-Bold.ttf", stack: "IBM Plex Serif Bold" },
  { file: "assets/fonts/src/Oswald-Variable.ttf", stack: "Oswald Regular" },
  // modern-clean uses Inter (above)
  // neon-sprawl
  { file: "assets/fonts/src/Rajdhani-Regular.ttf", stack: "Rajdhani Regular" },
  { file: "assets/fonts/src/Rajdhani-Bold.ttf", stack: "Rajdhani Bold" },
  { file: "assets/fonts/src/SairaCondensed-Regular.ttf", stack: "Saira Condensed Regular" },
  { file: "assets/fonts/src/SairaCondensed-Bold.ttf", stack: "Saira Condensed Bold" },
];

// 0-255: Basic Latin + Latin-1 Supplement. 256-511: Latin Extended-A (diacritics).
// Sufficient for English/European campaign names; extend here if a theme needs more.
const RANGES = [
  [0, 255],
  [256, 511],
];

function buildRange(buf, start, end) {
  return new Promise((resolve, reject) => {
    fontnik.range({ font: buf, start, end }, (err, pbf) => (err ? reject(err) : resolve(pbf)));
  });
}

async function main() {
  for (const font of FONTS) {
    const buf = readFileSync(font.file);
    const outDir = join("assets/fonts/glyphs", font.stack);
    mkdirSync(outDir, { recursive: true });
    for (const [start, end] of RANGES) {
      const pbf = await buildRange(buf, start, end);
      writeFileSync(join(outDir, `${start}-${end}.pbf`), pbf);
      console.log(`wrote ${font.stack}/${start}-${end}.pbf (${pbf.length} bytes)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

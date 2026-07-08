#!/usr/bin/env node
// Generates SDF glyph PBFs (MapLibre glyphs protocol) from OFL TTFs in assets/fonts/src/.
// Phase 1 needs only the obsidian-native fallback (Inter); Phase 2 extends this manifest
// with each handcrafted theme's fonts (Alegreya, IBM Plex Serif, Rajdhani, Saira Condensed).
import fontnik from "fontnik";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FONTS = [
  { file: "assets/fonts/src/Inter-Regular.ttf", stack: "Inter Regular" },
  { file: "assets/fonts/src/Inter-Bold.ttf", stack: "Inter Bold" },
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

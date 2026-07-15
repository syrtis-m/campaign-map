#!/usr/bin/env tsx
/**
 * Headless perceptual-golden runner. Renders the pinned (algorithm, preset,
 * seed, region) tuples to PNGs with the pure software rasterizer and pixel-diffs
 * them against committed goldens under `shots/perceptual/`.
 *
 *   npm run perceptual            # diff against the committed goldens (CI net)
 *   npm run perceptual -- --accept  # regenerate the goldens (explicit only)
 *
 * These are APPROVED IMAGES: `--accept` is a deliberate, eyeballed act, never
 * wired into any other script. A plain run exits non-zero if any tuple's diff
 * exceeds the fail threshold or its golden is missing.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodePng, decodePng } from "./lib/png";
import {
  renderFeatures,
  toImage,
  diffBuffers,
  DIFF_FAIL_FRACTION,
} from "./lib/perceptualRender";
import { tuples, regionFor, featuresFor } from "./lib/perceptualFixtures";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(REPO_ROOT, "shots", "perceptual");

function main(): void {
  const accept = process.argv.includes("--accept");
  const all = tuples();
  mkdirSync(SHOTS_DIR, { recursive: true });

  let failures = 0;
  for (const t of all) {
    const region = regionFor(t);
    const features = featuresFor(t);
    const img = toImage(renderFeatures(features, region));
    const png = encodePng(img);
    const path = join(SHOTS_DIR, `${t.name}.png`);

    if (accept) {
      writeFileSync(path, png);
      console.log(`  accepted  ${t.name}.png  (${features.length} features)`);
      continue;
    }

    if (!existsSync(path)) {
      console.log(`  MISSING   ${t.name}.png — run \`npm run perceptual -- --accept\``);
      failures++;
      continue;
    }
    const golden = decodePng(readFileSync(path));
    const { fraction } = diffBuffers(golden, img);
    const pct = (fraction * 100).toFixed(3);
    if (fraction > DIFF_FAIL_FRACTION) {
      console.log(`  FAIL      ${t.name}  ${pct}% differ (> ${(DIFF_FAIL_FRACTION * 100).toFixed(1)}%)`);
      failures++;
    } else {
      console.log(`  pass      ${t.name}  ${pct}% differ`);
    }
  }

  if (accept) {
    console.log(`\nAccepted ${all.length} goldens → ${SHOTS_DIR}`);
    return;
  }
  if (failures > 0) {
    console.error(`\n${failures}/${all.length} perceptual goldens FAILED`);
    process.exit(1);
  }
  console.log(`\nAll ${all.length} perceptual goldens passed`);
}

main();

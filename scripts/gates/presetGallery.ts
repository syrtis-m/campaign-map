#!/usr/bin/env tsx
// Plan 025 gate (seeded 025-A; superblock joined 025-B) — the PRESET GALLERY
// (plan 025 §3.5): the living style catalog for city procgen. A dedicated
// dev-vault campaign (`Campaigns/Preset Gallery`, committed fixture) holds ONE
// sketched district per city preset, all the SAME shape (regular 16-gon,
// effective radius ~700 m) in a 1×N equatorial row, so on-screen differences are
// the PRESET, never the boundary. Phase 025-B added the superblock district +
// the §3.3 width histogram columns; 025-C appended tartan-grid, ward-grid and
// eixample (the §3.4 chamfer operator); 025-D appends haussmann + baroque-axial
// (the §3.2 axial-breakthrough operator — boulevards cut through the fabric).
// This gate:
//
//   (a) reloads the plugin with the gallery cache cleared, opens the gallery,
//       and confirms every preset's district GENERATES from the committed
//       Fabric.geojson (the rm-.mapcache regenerate-identically property);
//   (b) METRICS TABLE: computes the §3.1 metrics per preset PURELY (same
//       authored seed + ring the app renders) and prints them against the §1.2
//       Salat figure-ground anchors — the numeric review. Distribution bands
//       WARN, they never fail the gate (plan §5 OQ#1: ranges encode taste,
//       Jonah calibrates from review/gallery); the unit suite is where the
//       bands are the hard contract;
//   (c) SCREENSHOTS: one per preset at a FIXED zoom + one overview contact
//       sheet of the whole grid, all into review/gallery/ (overwrite in place —
//       the folder IS the style catalog Jonah reads each morning);
//   (d) BYTE-STABILITY: rm .mapcache, reopen → every preset's region output is
//       byte-identical (determinism; the visual-regression baseline for future
//       preset phases — an untouched preset's gallery city must not move);
//   (e) explicit-only: pan/zoom never moves generatorRunCount;
//   (f) dev:errors clean; the committed Fabric.geojson left byte-intact.
//
// SEED NOTE: every preset's seed is PINNED in the committed Fabric.geojson
// procgen block, so the metrics table and the byte-stability digests are the
// same numbers every run — no timestamp-seed flake (the arc's #1 flake source).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";
import { generateCityNetwork, type ProfileId } from "../../src/gen/citynet/index.js";
import { makeRegion } from "../../src/gen/region.js";
import {
  computeNetworkMetrics,
  benchmarkViolations,
  PRESET_BENCHMARKS,
  type NetworkMetrics,
} from "../../src/gen/citynet/metrics.js";

const CAMPAIGN = "preset-gallery";
const FOLDER = "dev-vault/Campaigns/Preset Gallery";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review/gallery";
const SCALE = 100;
// Campaign bounds (units) — the worldBounds the app passes to generation, so
// the pure metrics below match the live render byte-for-byte.
// Bounds widen EAST as presets append (existing districts keep their x); the
// campaign worldBounds the app passes to generation = these × SCALE, so a wider
// bound shifts every preset's height-falloff a hair (warn-only metrics; the hard
// bands live in the unit suite on a fixed-bounds ring). 025-C appended
// tartan-grid(56)/ward-grid(72)/eixample(88); 025-D appended haussmann(104)/
// baroque-axial(120). 025-E appends the concentric-ring family — canal-rings(136)/
// radial-star(152) — plus TWO additive-upgrade VARIANT districts for the eyeball
// (§2.9 na-grid+seamBoulevard at 168, §2.10 euro-medieval+growthRings:2 at 184).
// euro-medieval-rings at x=184 spans 176.9–191.1, so maxX 193 fits it.
const BOUNDS: [number, number, number, number] = [-33, -10, 193, 10];
const WORLD = { minX: BOUNDS[0] * SCALE, minY: BOUNDS[1] * SCALE, maxX: BOUNDS[2] * SCALE, maxY: BOUNDS[3] * SCALE };
// Per-preset display-space centres (must match the authored Fabric.geojson) +
// the district circumradius in display units, for fitBounds framing.
const CENTERS: Record<string, [number, number]> = {
  "euro-medieval": [-24, 0],
  "euro-continental": [-8, 0],
  "na-grid": [8, 0],
  "na-suburb": [24, 0],
  superblock: [40, 0],
  "tartan-grid": [56, 0],
  "ward-grid": [72, 0],
  eixample: [88, 0],
  haussmann: [104, 0],
  "baroque-axial": [120, 0],
  "canal-rings": [136, 0],
  "radial-star": [152, 0],
};
const R_UNITS = 7.6; // circumradius 7.09 + margin
const PRESET_ORDER: ProfileId[] = [
  "euro-medieval",
  "euro-continental",
  "na-grid",
  "na-suburb",
  "superblock",
  "tartan-grid",
  "ward-grid",
  "eixample",
  "haussmann",
  "baroque-axial",
  "canal-rings",
  "radial-star",
];
// Additive-upgrade VARIANT districts (plan 025-E §2.9/§2.10) — NOT presets, so
// excluded from PRESET_ORDER/metrics/benchmarks (they are benchmarked via their
// base preset). Included only for the visual eyeball: the seam boulevard cutting
// diagonally across the na-grid, and the euro-medieval inner growth ring.
const VARIANTS: { id: string; label: string; center: [number, number] }[] = [
  { id: "gallery-na-grid-seam", label: "na-grid-seam", center: [168, 0] },
  { id: "gallery-euro-medieval-rings", label: "euro-medieval-rings", center: [184, 0] },
];

interface GalleryFeature {
  id: string;
  properties: { name?: string; procgen?: { seed: number; params: { profile: ProfileId } } };
  geometry: { coordinates: [number, number][][] };
}

function readGallery(): GalleryFeature[] {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as { features: GalleryFeature[] };
  return fabric.features.filter((f) => f.properties.procgen);
}

function viewExpr(): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;
}
function resetLeaves(): void {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}
async function issueOpen(): Promise<void> {
  resetLeaves();
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    if (String(out).includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`timed out waiting for ${what}`);
}
function sync(expr: string): unknown {
  return evalJs(`(function(){ var v=${viewExpr()}; return (${expr}); })()`);
}
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
function digest(id: string): string {
  const ids = sync(`JSON.stringify((v.regionFeatureIds(${JSON.stringify(id)})||[]).slice().sort())`);
  return typeof ids === "string" ? ids : JSON.stringify(ids);
}
function regionCount(id: string): number {
  const n = sync(`(v.regionFeatureIds(${JSON.stringify(id)})||[]).length`);
  return typeof n === "number" ? n : Number(n) || 0;
}
async function reopenAndSettle(ids: string[] = []): Promise<void> {
  await issueOpen();
  front();
  await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "gallery view");
  await new Promise((r) => setTimeout(r, 8000)); // replay kickoff
  // The gallery now holds 14 districts; each generates a full city network
  // asynchronously AND writes ~12 tiles × 6 gids to the jsonl cache, sequentially
  // in the replay loop. From a cleared cache that is ~2 minutes of work, so the
  // poll budget is generous (the disk cache proves all 14 DO complete — the risk
  // is under-waiting, never a hang). Poll until EVERY region has features before
  // any digest is captured — robust to the count growing, not a magic sleep.
  if (ids.length > 0) {
    await waitFor(
      () => ids.every((id) => regionCount(id) > 0),
      210000,
      "all gallery districts generated"
    );
    await new Promise((r) => setTimeout(r, 2000)); // small quiescence margin
  }
}
function fabricDigest(): string {
  return readFileSync(FABRIC_ABS, "utf8");
}

/** Pure metrics for one gallery preset — the SAME seed + ring the app renders
 * (worldBounds = campaign bounds), so the table mirrors the screenshots. */
function metricsFor(f: GalleryFeature): NetworkMetrics {
  const profile = f.properties.procgen!.params.profile;
  const seed = f.properties.procgen!.seed;
  const ring = f.geometry.coordinates[0].map(([x, y]) => [x * SCALE, y * SCALE] as [number, number]);
  const region = makeRegion(f.id, ring);
  const net = generateCityNetwork(seed, region, profile, { worldBounds: WORLD });
  return computeNetworkMetrics(net, region);
}

function printMetricsTable(gate: Gate): void {
  console.log("\n  Plan 025 §3.1 metrics — gallery presets vs §1.2 Salat anchors:");
  console.log(
    "  " +
      ["preset", "int/km²", "km/km²", "land%", "grainM", "aven%", "dead", "perm", "w<10%", "w10-20", "w>20%"]
        .map((s) => s.padEnd(9))
        .join("")
  );
  let warned = 0;
  for (const profile of PRESET_ORDER) {
    const f = readGallery().find((g) => g.properties.procgen!.params.profile === profile)!;
    const m = metricsFor(f);
    const row = [
      profile,
      m.intersectionsPerKm2.toFixed(0),
      m.streetKmPerKm2.toFixed(1),
      (m.streetLandShare * 100).toFixed(0),
      m.blockGrainP50.toFixed(0),
      (m.avenueShare * 100).toFixed(0),
      String(m.deadEndCount),
      m.permeability.toFixed(2),
      // §3.3 width histogram (share of street LENGTH by band) — the superblock's
      // wide arterial canyons show up as a nonzero >20 m column, unique to it.
      (m.widthHistogram.lt10 * 100).toFixed(0),
      (m.widthHistogram.m10to20 * 100).toFixed(0),
      (m.widthHistogram.gt20 * 100).toFixed(0),
    ];
    console.log("  " + row.map((s) => String(s).padEnd(9)).join(""));
    console.log(`       anchor: ${PRESET_BENCHMARKS[profile].anchor}`);
    const v = benchmarkViolations(profile, m);
    if (v.length) {
      warned += 1;
      console.log(`       [warn] out-of-band (taste range, not a failure): ${v.join("; ")}`);
    }
  }
  // The table always "passes" — bands WARN here (OQ#1). Recorded so the summary
  // shows how many presets drifted for Jonah's eye.
  gate.check(`(b) metrics table printed (${warned} preset(s) out-of-band → warn only)`, true);
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 025-E gate (preset gallery — the city style catalog) ==\n");
  mkdirSync(REVIEW, { recursive: true });

  const gallery = readGallery();
  const fabricBefore = fabricDigest();

  await gate.try(`gallery fixture present (${gallery.length} districts), plugin reloads clean`, () => {
    // 12 presets (PRESET_ORDER) + 2 additive-upgrade variant districts = 14.
    if (gallery.length !== 14) throw new Error(`expected 14 gallery districts, found ${gallery.length}`);
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("(a) gallery opens; every preset district generates from the committed fabric", async () => {
    await reopenAndSettle(gallery.map((f) => f.id));
    for (const f of gallery) {
      const c = regionCount(f.id);
      if (c < 1) throw new Error(`preset ${f.properties.name} generated no features`);
    }
    console.log("     [a] " + gallery.map((f) => `${f.properties.name}=${regionCount(f.id)}`).join("  "));
  });

  // Digests captured on the first (from-scratch) generation.
  const firstDigests: Record<string, string> = {};
  for (const f of gallery) firstDigests[f.id] = digest(f.id);

  printMetricsTable(gate);

  await gate.try("(c) per-preset + contact-sheet screenshots → review/gallery/", async () => {
    for (const profile of PRESET_ORDER) {
      const [cx, cy] = CENTERS[profile];
      sync(
        `(function(){v.map.fitBounds([[${cx - R_UNITS},${cy - R_UNITS}],[${cx + R_UNITS},${cy + R_UNITS}]],{padding:40,animate:false});return 'ok';})()`
      );
      front();
      await new Promise((r) => setTimeout(r, 1600));
      screenshot(`${REVIEW}/${profile}.png`);
    }
    // The two additive-upgrade variants (§2.9 seam boulevard, §2.10 growth ring).
    for (const v of VARIANTS) {
      const [cx, cy] = v.center;
      sync(
        `(function(){v.map.fitBounds([[${cx - R_UNITS},${cy - R_UNITS}],[${cx + R_UNITS},${cy + R_UNITS}]],{padding:40,animate:false});return 'ok';})()`
      );
      front();
      await new Promise((r) => setTimeout(r, 1600));
      screenshot(`${REVIEW}/${v.label}.png`);
    }
    // Contact sheet: the whole 1×14 row in one frame.
    sync(
      `(function(){v.map.fitBounds([[${BOUNDS[0]},${BOUNDS[1]}],[${BOUNDS[2]},${BOUNDS[3]}]],{padding:20,animate:false});return 'ok';})()`
    );
    front();
    await new Promise((r) => setTimeout(r, 1800));
    screenshot(`${REVIEW}/_contact-sheet.png`);
    for (const profile of PRESET_ORDER) {
      if (!existsSync(`${REVIEW}/${profile}.png`)) throw new Error(`missing screenshot for ${profile}`);
    }
    for (const v of VARIANTS) {
      if (!existsSync(`${REVIEW}/${v.label}.png`)) throw new Error(`missing screenshot for ${v.label}`);
    }
    if (!existsSync(`${REVIEW}/_contact-sheet.png`)) throw new Error("missing contact sheet");
    console.log("     [c] 12 preset shots + 2 variant shots + contact sheet written to review/gallery/");
  });

  await gate.try("(e) explicit-only: pan/zoom never generates", async () => {
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-24,0],zoom:5});v.map.jumpTo({center:[24,0],zoom:6});v.map.jumpTo({center:[0,0],zoom:4});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
    console.log(`     [e] generatorRunCount flat under pan/zoom (${before})`);
  });

  await gate.try("(d) rm .mapcache → every preset regenerates byte-identically (determinism)", async () => {
    resetLeaves();
    await new Promise((r) => setTimeout(r, 800));
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    await reopenAndSettle(gallery.map((f) => f.id));
    for (const f of gallery) {
      if (digest(f.id) !== firstDigests[f.id]) {
        throw new Error(`preset ${f.properties.name} not byte-identical after cache delete`);
      }
    }
    console.log(`     [d] all ${gallery.length} presets byte-identical across a full regenerate`);
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("committed Fabric.geojson left byte-intact", () => {
    if (fabricDigest() !== fabricBefore) throw new Error("gallery Fabric.geojson changed during the gate");
  });

  resetLeaves();
  process.exit(gate.summarize("Plan 025-E"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

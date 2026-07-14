#!/usr/bin/env tsx
// Plan 023-C gate — topographic contour iso-lines (plan 023 §4.1).
//
// Live against dev-vault via the obsidian CLI. Contours are NOT a new request
// surface: a `mountain` region sketched/regenerated the SAME way as in 23-B now
// ALSO emits `mountain-contour` LineStrings, traced by marching squares over the
// region's own elevation field on a world-aligned lattice, clipped to the ring.
// The headless twin (createRegionForTest, kind=mountain — modals hang CLI) runs
// the FULL commit path, so this gate exercises exactly what confirming a
// mountain sketch does.
//
//   (a) create alpine → mountain-contour records in cache + rendered; contained;
//       determinism (regenerate twice → byte-identical region records);
//   (b) SEAM: contours span ≥2 tiles — the ONE artifact is clipped per tile
//       (adjacent tiles cut the same bytes → they agree on shared edges);
//   (c) NO new request surface: regenerating the existing mountain re-emits the
//       contours (count stable, still > 0) — no contour-only trigger exists;
//   (d) mesa banding: a mesa mountain yields multiple distinct contour levels
//       (the terrace risers pack iso-lines into cliff bands);
//   (e) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (f) dev:errors clean end-to-end;
//   screenshots → review/: alpine contours (topo iso-lines read on the relief)
//       and mesa (stepped terrace banding).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__c23c_test__";
// Display units (1 unit = 50 m). Fixtures sit well inside bounds [-48,-36,48,36]
// and clear of the migrated Vespergate district (~[-4.8, 6]). 20×20 units =
// 1000 m ⇒ enough relief for many contour bands + tile spanning.
const ALPINE_RING = "[[-40,-30],[-20,-30],[-20,-10],[-40,-10]]";
const EAST_RING = "[[16,-30],[36,-30],[36,-10],[16,-10]]";
const ALPINE = "{ terrain: 'alpine', amplitude: 0.85, roughness: 0.6 }";
const MESA = "{ terrain: 'mesa', amplitude: 0.55, roughness: 0.4 }";

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
/** Runs an async MapView method in-app, parking the result on window.__c23c. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__c23c = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__c23c = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__c23c = { ok: r }; }, function(e){ window.__c23c = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__c23c === undefined ? null : window.__c23c)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}
function sync(expr: string): unknown {
  return evalJs(`(function(){ var v=${viewExpr()}; return (${expr}); })()`);
}
/** Front Obsidian (App Nap stalls MapLibre's style load in an occluded window). */
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
function containment(id: string): { count: number; outside: number } {
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
function contourCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'mountain-contour').length`) as number;
}
/** Distinct tiles (cache keys) carrying ≥1 mountain-contour feature for a region
 * — proves contours cross tile boundaries and are clipped per-tile (the seam
 * story: adjacent tiles cut the SAME whole artifact). */
function contourTileCount(id: string): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var t=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;var has=feats.some(function(f){return f.properties&&f.properties.generatorId==='mountain-contour';});if(has)t.add(k);});return t.size;})()`;
  return evalJs(code) as number;
}
/** Distinct contour elevation levels present for a region (banding measure). */
function contourLevels(id: string): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(f.properties&&f.properties.generatorId==='mountain-contour')s.add(f.properties.elevation);});});return s.size;})()`;
  return evalJs(code) as number;
}
function regionCacheRecords(regionId: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CACHE_ABS)) return out;
  const prefix = `region:${regionId}:`;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; features: unknown };
    if (rec.key.startsWith(prefix)) out.set(rec.key, JSON.stringify(rec.features));
  }
  return out;
}
function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { id?: string; properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  const removed = fabric.features.filter((f) => f.properties?.name === TEST_NAME).map((f) => f.id);
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length !== before) {
    writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
    if (existsSync(CACHE_ABS)) {
      const kept = readFileSync(CACHE_ABS, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .filter((l) => {
          try {
            const r = JSON.parse(l) as { key: string };
            return !removed.some((id) => id && r.key.startsWith(`region:${id}:`));
          } catch {
            return true;
          }
        });
      writeFileSync(CACHE_ABS, kept.join("\n") + "\n");
    }
  }
}
async function newMountain(ring: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'mountain', ${params}, '${TEST_NAME}', 'mountain'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no mountain features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 023-C gate (contour iso-lines) ==\n");

  await gate.try("unit gates: marching squares + mountain gen (contours) + generated paint", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/fields/marchingSquares.test.ts",
        "src/gen/mountain.test.ts",
        "src/map/themes/generatedLayers.test.ts",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
  });

  await gate.try("plugin loads (reloaded), no errors, cache clean", () => {
    stripTestFabric();
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration + replay settle)", async () => {
    await issueOpen();
    front();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3500));
  });

  let id = "";
  await gate.try("(a) alpine mountain emits contours in cache + rendered, contained + deterministic", async () => {
    id = await newMountain(ALPINE_RING, ALPINE);
    const contours = contourCount(id);
    if (contours < 4) throw new Error(`too few contour lines (${contours})`);
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the mountain");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] ${contours} contour lines; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) SEAM: contours span multiple tiles (per-tile clip of one artifact)", () => {
    const tiles = contourTileCount(id);
    if (tiles < 2) throw new Error(`contours confined to ${tiles} tile(s) — expected them to cross tile edges`);
    console.log(`     [b] contours present in ${tiles} distinct tiles`);
  });

  await gate.try("(c) NO new request surface: regenerating the existing mountain re-emits contours", async () => {
    const before = contourCount(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const after = contourCount(id);
    if (after < 4) throw new Error(`contours vanished on regenerate (${after})`);
    if (before !== after) throw new Error(`contour count drifted on a plain regenerate: ${before} -> ${after}`);
    console.log(`     [c] regenerate re-emits ${after} contours (no separate contour trigger)`);
  });

  await gate.try("(d) mesa banding: terraced relief yields multiple distinct contour levels", async () => {
    const mesaId = await newMountain(EAST_RING, MESA);
    const levels = contourLevels(mesaId);
    if (levels < 2) throw new Error(`mesa produced only ${levels} contour level(s) — no banding`);
    if (containment(mesaId).outside > 0) throw new Error("mesa contours spilled outside the ring");
    console.log(`     [d] mesa contour levels: ${levels}`);
  });

  await gate.try("(e) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-20],zoom:5});v.map.jumpTo({center:[24,-20],zoom:11});v.map.jumpTo({center:[-30,-20],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: alpine contours (topo iso-lines over the relief)", async () => {
    sync("(function(){v.map.fitBounds([[-42,-32],[-18,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.11-contours-alpine.png`);
  });

  await gate.try("screenshot: mesa terrace banding (bunched contour bands)", async () => {
    sync("(function(){v.map.fitBounds([[14,-32],[38,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.11-contours-mesa.png`);
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 023-C"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

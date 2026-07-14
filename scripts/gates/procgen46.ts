#!/usr/bin/env tsx
// Procgen v4.7 gate — polygon procgen: PARKS (plan 022 §3.3).
//
// Live against dev-vault via the obsidian CLI. Parks are sketched as POLYGONS;
// a procgen block turns the shape into a designed garden — a watertight ground
// lattice (lawn/bed), a path web, and per-variety dressing, all strictly inside
// the ring. The marquee variety is `japanese-garden`: a deliberately asymmetric
// strolling garden anchored by a pond with an island + short bridge(s), rock
// groupings, specimen trees and (on a large region) a raked-gravel court. The
// headless twin (createRegionForTest, kind=park — modals hang CLI) runs the FULL
// commit path, so this gate exercises exactly what confirming a park sketch does.
//
//   (a) create a japanese-garden → ground+path+pond+island+bridge+rock+court in
//       cache + rendered; containment holds; determinism (regenerate twice →
//       byte-identical); the composition set (pond/island/bridge/rock/court) all
//       present on a large region (graceful-degradation ladder at full extent);
//   (b) vertex edit → the park adapts (lawn bucket set changes) and stays inside;
//       locality: an edit changes output far LESS than a re-roll (measure both);
//   (c) rerollRegion → NEW seed, output changes, still contained;
//   (d) sketch-edit undo → restores the previous park;
//   (e) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (f) dev:errors clean end-to-end;
//   screenshots → review/: a japanese-garden (asymmetric, pond+island) and a
//       formal-garden (axial cross, symmetric beds + tree rows).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p46_test__";
// Display units (1 unit = 50 m). Both parks sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
// The japanese ring is 20×20 units = 1000 m square ⇒ maxInteriorDistance ~500 m,
// well past the court(≥200 m)/island(≥130 m) rungs so every element emits.
const JAPANESE_RING = "[[16,8],[36,8],[36,28],[16,28]]";
const FORMAL_RING = "[[-40,-28],[-20,-28],[-20,-8],[-40,-8]]";
const JAPANESE = "{ variety: 'japanese-garden', pathDensity: 0.4, pond: true }";
const FORMAL = "{ variety: 'formal-garden', pathDensity: 0.6, pond: false }";
// The japanese composition set — every one must render on a large region.
const COMPOSITION: readonly string[] = ["park-pond", "park-island", "park-bridge", "park-rock", "park-court"];

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
/** Runs an async MapView method in-app, parking the result on window.__p46. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p46 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p46 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p46 = { ok: r }; }, function(e){ window.__p46 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p46 === undefined ? null : window.__p46)");
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
/** Lawn coordinate buckets (gen-space meters) — the ground lattice is the
 * containment/locality backbone (forest-canopy's role in p45). A fine grid so
 * the seed-driven vertex jitter (±3.5 m) registers under a re-roll. */
function lawnBuckets(id: string, grid = 5): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='park-lawn')return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as string[];
}
function overlapPct(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  const sa = new Set(a);
  return (b.filter((x) => sa.has(x)).length / a.length) * 100;
}
function containment(id: string): { count: number; outside: number } {
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
function featureCount(id: string, gid: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, ${JSON.stringify(gid)}).length`) as number;
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
function fabricFeature(id: string): { id: string; properties: { procgen?: { seed?: number } } } | undefined {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { id: string; properties: { procgen?: { seed?: number } } }[];
  };
  return fabric.features.find((f) => f.id === id);
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
async function newPark(ring: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'park', ${params}, '${TEST_NAME}', 'park'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no park features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.7 gate (polygon procgen: parks) ==\n");

  await gate.try("unit gates: park gen + fuzz + region + registry + generated paint + controller lifecycle", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/park.test.ts",
        "src/gen/region.test.ts",
        "src/gen/procgen",
        "src/map/themes/generatedLayers.test.ts",
        "src/controller/MapController.test.ts",
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
  await gate.try("(a) japanese-garden → full composition in cache + rendered, contained + deterministic", async () => {
    id = await newPark(JAPANESE_RING, JAPANESE);
    const lawn = featureCount(id, "park-lawn");
    const path = featureCount(id, "park-path");
    if (lawn < 1) throw new Error("no park-lawn ground rendered");
    if (path < 1) throw new Error("no park-path features rendered");
    // The japanese composition set: every rung of the ladder emits on a large park.
    const counts: Record<string, number> = {};
    for (const gid of COMPOSITION) {
      const n = featureCount(id, gid);
      counts[gid] = n;
      if (n < 1) throw new Error(`japanese-garden emitted no ${gid} on a large region`);
    }
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the park");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(
      `     [a] lawn ${lawn}, path ${path}; composition ${COMPOSITION.map((g) => `${g.replace("park-", "")}:${counts[g]}`).join(" ")}; ${r1.size} records byte-identical twice`
    );
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (locality) + stays contained", async () => {
    const base = lawnBuckets(id);
    // Move a corner (open-index 1 = [36,8]) outward — only boundary cells near
    // it change containment, so the ground lattice overlap stays high.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [40, 8]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, lawnBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset the corner, snapshot, then re-roll → the whole ground lattice re-jitters.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [36, 8]); }`);
    const pre = lawnBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, lawnBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
    if (!(editOverlap > 70)) throw new Error(`edit overlap unexpectedly low (${editOverlap.toFixed(1)}%)`);
  });

  await gate.try("(c) re-roll → new seed, output changes, still contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${JAPANESE}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = lawnBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, lawnBuckets(id));
    console.log(`     [c] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 92) throw new Error("re-roll did not visibly change the park ground");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
    // The composition still emits after a re-roll (a different-but-valid garden).
    for (const gid of COMPOSITION) {
      if (featureCount(id, gid) < 1) throw new Error(`re-rolled japanese-garden emitted no ${gid}`);
    }
  });

  await gate.try("(d) sketch-edit undo restores the previous park", async () => {
    const pre = lawnBuckets(id);
    // Move the corner INWARD so lawn cells are REMOVED (an outward extension only
    // adds cells, leaving every pre bucket present — overlap wouldn't drop).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [26, 12]); }`);
    const edited = lawnBuckets(id);
    if (overlapPct(pre, edited) > 98) throw new Error("edit didn't change the park — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, lawnBuckets(id));
    console.log(`     [d] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit park (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(e) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[26,18],zoom:5});v.map.jumpTo({center:[-30,-18],zoom:11});v.map.jumpTo({center:[26,18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: japanese-garden (asymmetric, pond + island + bridge)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${JAPANESE}); }`);
    if (containment(id).outside > 0) throw new Error("japanese-garden spilled outside its ring");
    sync("(function(){v.map.fitBounds([[14,6],[38,30]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.7-park-japanese.png`);
  });

  let formalId = "";
  await gate.try("screenshot: formal-garden (axial cross, symmetric beds + tree rows)", async () => {
    formalId = await newPark(FORMAL_RING, FORMAL);
    if (containment(formalId).outside > 0) throw new Error("formal-garden spilled outside its ring");
    if (featureCount(formalId, "park-pond") !== 0) throw new Error("formal-garden should not pond");
    if (featureCount(formalId, "park-bed") < 1) throw new Error("formal-garden emitted no symmetric beds");
    sync("(function(){v.map.fitBounds([[-42,-30],[-18,-6]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.7-park-formal.png`);
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.7"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env tsx
// Procgen v4.6 gate — polygon masked-noise procgen: FORESTS (plan 022 §3.2).
//
// Live against dev-vault via the obsidian CLI. Forests are sketched as POLYGONS;
// a procgen block turns the shape into a woodland canopy (cells of a masked
// density field) with clearings and tree stipple, all strictly inside the ring.
// The headless twin (createRegionForTest, kind=forest — modals hang CLI) runs
// the FULL commit path, so this gate exercises exactly what confirming a forest
// sketch does interactively.
//
//   (a) create a broadleaf forest → canopy features in cache + rendered,
//       containment holds + determinism (regenerate twice → byte-identical);
//   (b) vertex edit → the forest adapts (bucket set changes) and stays inside;
//       locality: an edit changes output far LESS than a re-roll (measure both);
//   (c) setRegionParams density UP → more canopy, still fully contained;
//   (d) rerollRegion → NEW seed, output changes;
//   (e) sketch-edit undo → restores the previous forest;
//   (f) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: a broadleaf wood and a ragged dead-wood.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p45_test__";
// Display units (1 unit = 50 m). Both forests sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
const BROADLEAF_RING = "[[18,10],[34,10],[34,26],[18,26]]";
const DEADWOOD_RING = "[[-40,-28],[-24,-28],[-24,-12],[-40,-12]]";
const BROADLEAF = "{ variety: 'broadleaf', density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 }";
const DEADWOOD = "{ variety: 'dead-wood', density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 }";

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
/** Runs an async MapView method in-app, parking the result on window.__p45. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p45 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p45 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p45 = { ok: r }; }, function(e){ window.__p45 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p45 === undefined ? null : window.__p45)");
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
/** Canopy coordinate buckets (gen-space meters) — a cell add/drop moves buckets,
 * the adapt/re-roll stability measure. */
function canopyBuckets(id: string, grid = 13): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='forest-canopy')return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
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
function canopyCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'forest-canopy').length`) as number;
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
async function newForest(ring: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'forest', ${params}, '${TEST_NAME}', 'forest'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no forest features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.6 gate (polygon procgen: forests) ==\n");

  await gate.try("unit gates: forest gen + region + registry + generated paint + controller lifecycle", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/forest.test.ts",
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
  await gate.try("(a) broadleaf forest → canopy features in cache + rendered, contained + deterministic", async () => {
    id = await newForest(BROADLEAF_RING, BROADLEAF);
    const n = canopyCount(id);
    if (n < 1) throw new Error("no forest-canopy features rendered");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the forest");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] ${n} forest-canopy features; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (locality) + stays contained", async () => {
    const base = canopyBuckets(id);
    // Move a corner (open-index 1) outward — only boundary cells near it change.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [38, 10]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, canopyBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset the corner, snapshot, then re-roll → the whole canopy field changes.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [34, 10]); }`);
    const pre = canopyBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, canopyBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
  });

  await gate.try("(c) density UP → more canopy; output stays fully contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { variety: 'broadleaf', density: 0.3, clearings: 0.1, edgeRaggedness: 0.5 }); }`);
    const sparse = canopyCount(id);
    if (containment(id).outside > 0) throw new Error("outside at low density");
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { variety: 'broadleaf', density: 0.9, clearings: 0.1, edgeRaggedness: 0.5 }); }`);
    const dense = canopyCount(id);
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside at high density`);
    console.log(`     [c] canopy cells ${sparse} (density 0.3) → ${dense} (density 0.9); 0 outside`);
    if (!(dense > sparse)) throw new Error(`density increase did not add canopy (${sparse} → ${dense})`);
  });

  await gate.try("(d) re-roll → new seed, output changes", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BROADLEAF}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = canopyBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, canopyBuckets(id));
    console.log(`     [d] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 92) throw new Error("re-roll did not visibly change the forest");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
  });

  await gate.try("(e) sketch-edit undo restores the previous forest", async () => {
    const pre = canopyBuckets(id);
    // Move the corner INWARD so canopy cells are REMOVED (an outward extension
    // only adds cells, leaving every pre bucket present — overlap wouldn't drop).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [25, 13]); }`);
    const edited = canopyBuckets(id);
    if (overlapPct(pre, edited) > 98) throw new Error("edit didn't change the forest — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, canopyBuckets(id));
    console.log(`     [e] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit forest (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(f) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[26,18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: broadleaf wood", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BROADLEAF}); }`);
    sync("(function(){v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.6-forest-broadleaf.png`);
  });

  let deadId = "";
  await gate.try("screenshot: ragged dead-wood", async () => {
    deadId = await newForest(DEADWOOD_RING, DEADWOOD);
    if (containment(deadId).outside > 0) throw new Error("dead-wood spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-30],[-22,-10]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.6-forest-deadwood.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.6"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

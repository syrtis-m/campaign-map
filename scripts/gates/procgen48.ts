#!/usr/bin/env tsx
// Procgen v4.9 gate — polygon procgen: FARMLAND + outskirt-field suppression
// (plan 022 §3.5, the final phase of plan 022).
//
// Live against dev-vault via the obsidian CLI. Farmland is sketched as a
// POLYGON; a procgen block fills the shape with tilled fields (subdivided per
// preset), a sparse lane web, field-edge hedges/fences, farmstead footprints
// and (orchard) regular tree rows — all strictly inside the ring. The headless
// twin (createRegionForTest, kind=farmland — modals hang CLI) runs the FULL
// commit path, so this gate exercises exactly what confirming a farmland sketch
// does interactively.
//
//   (a) create enclosed-patchwork → fields+lanes+hedges+farmsteads in cache +
//       rendered; containment holds; determinism (regenerate twice →
//       byte-identical region records);
//   (b) vertex edit → the farmland adapts (field bucket set changes) far LESS
//       than a re-roll (identity property) and stays contained;
//   (c) rerollRegion → NEW seed, output changes, still contained;
//   (d) sketch-edit undo → restores the previous farmland;
//   (e) per-preset composition + containment: grid-quarters (rectilinear
//       sections + lanes) and orchard (regular tree rows) both emit correctly;
//   (f) OUTSKIRT SUPPRESSION: a farmland sketch over a euro-medieval city's rim
//       suppresses the city's OWN outskirt fields inside it, while the farmland
//       claims that ground with its own fields;
//   (g) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (h) dev:errors clean end-to-end;
//   screenshots → review/: enclosed-patchwork (irregular hedged fields) and
//       grid-quarters (rectilinear sections + straight section lanes).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p48_test__";
// Display units (1 unit = 50 m). Fixtures sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
// The west farmland ring is 20×20 units = 1000 m ⇒ many coarse cells at every
// field scale, so every preset emits a full artifact.
const FARM_RING = "[[-40,-30],[-20,-30],[-20,-10],[-40,-10]]";
const ORCHARD_RING = "[[16,-30],[36,-30],[36,-10],[16,-10]]";
const PATCHWORK = "{ fieldType: 'enclosed-patchwork', fieldSize: 0.5, hedging: 'hedgerows', laneDensity: 0.4, farmsteads: 0.45 }";
const QUARTERS = "{ fieldType: 'grid-quarters', fieldSize: 0.7, hedging: 'fences', laneDensity: 0.66, farmsteads: 0.35 }";
const ORCHARD = "{ fieldType: 'orchard', fieldSize: 0.4, hedging: 'hedgerows', laneDensity: 0.5, farmsteads: 0.3 }";
// A euro-medieval city on the east side (grows outskirt fields) for the
// double-field suppression test; the farmland claim covers the whole city ring
// (slightly enlarged) so every rim outskirt field falls inside it.
const CITY_RING = "[[14,4],[34,4],[34,24],[14,24]]";
const CITY_PARAMS = "{ profile: 'euro-medieval' }";
const FARM_OVER_CITY = "[[12,2],[36,2],[36,26],[12,26]]";

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
/** Runs an async MapView method in-app, parking the result on window.__p48. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p48 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p48 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p48 = { ok: r }; }, function(e){ window.__p48 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p48 === undefined ? null : window.__p48)");
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
/** Field coordinate buckets (gen-space meters) for one region — the field
 * lattice is the containment/locality backbone. A fine grid so a re-roll's
 * re-split registers. */
function fieldBuckets(id: string, grid = 5): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='farm-field')return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
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
/** City OUTSKIRT-field count (generatorId 'city-landmark', type 'field') for a
 * district — what the raw farmland sketch suppresses. */
function cityOutskirtFields(id: string): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var n=0;v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){var p=f.properties;if(p&&p.generatorId==='city-landmark'&&p.type==='field')n++;});});return n;})()`;
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
async function newFarmland(ring: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'farmland', ${params}, '${TEST_NAME}', 'farmland'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no farmland features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.9 gate (polygon procgen: farmland + outskirt suppression) ==\n");

  await gate.try("unit gates: farmland gen + fuzz-companion region + registry + constraints + generated paint + controller", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/farmland.test.ts",
        "src/gen/fabricConstraints.test.ts",
        "src/gen/region.test.ts",
        "src/gen/citynet/citynet.test.ts",
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
  await gate.try("(a) enclosed-patchwork → fields+lanes+hedges+farmsteads in cache + rendered, contained + deterministic", async () => {
    id = await newFarmland(FARM_RING, PATCHWORK);
    const fields = featureCount(id, "farm-field");
    const lanes = featureCount(id, "farm-lane");
    const hedges = featureCount(id, "farm-hedge");
    const steads = featureCount(id, "farm-building");
    if (fields < 4) throw new Error(`too few farm-field polygons (${fields})`);
    if (lanes < 1) throw new Error("no farm-lane features rendered");
    if (hedges < 1) throw new Error("no farm-hedge features rendered (hedgerows preset)");
    if (steads < 1) throw new Error("no farm-building footprints rendered");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the farmland");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] fields ${fields}, lanes ${lanes}, hedges ${hedges}, farmsteads ${steads}; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (identity) + stays contained", async () => {
    const base = fieldBuckets(id);
    // Move a corner (open-index 1 = [-20,-30]) outward — only boundary cells
    // near it change containment; the absolute-world field lattice stays put.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-16, -30]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, fieldBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset the corner, snapshot, then re-roll → the whole patchwork re-splits.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-20, -30]); }`);
    const pre = fieldBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, fieldBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
    if (!(editOverlap > 70)) throw new Error(`edit overlap unexpectedly low (${editOverlap.toFixed(1)}%)`);
  });

  await gate.try("(c) re-roll → new seed, output changes, still contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${PATCHWORK}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = fieldBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, fieldBuckets(id));
    console.log(`     [c] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 92) throw new Error("re-roll did not visibly change the farmland");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
  });

  await gate.try("(d) sketch-edit undo restores the previous farmland", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${PATCHWORK}); }`);
    const pre = fieldBuckets(id);
    // Move the corner INWARD so field cells are REMOVED (an outward move only
    // adds cells, leaving every pre bucket present — overlap wouldn't drop).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-30, -22]); }`);
    const edited = fieldBuckets(id);
    if (overlapPct(pre, edited) > 98) throw new Error("edit didn't change the farmland — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, fieldBuckets(id));
    console.log(`     [d] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit farmland (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  let orchardId = "";
  await gate.try("(e) per-preset composition: grid-quarters (sections+lanes) + orchard (tree rows), both contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${QUARTERS}); }`);
    const qFields = featureCount(id, "farm-field");
    const qLanes = featureCount(id, "farm-lane");
    if (qFields < 4) throw new Error(`grid-quarters emitted too few sections (${qFields})`);
    if (qLanes < 1) throw new Error("grid-quarters emitted no section lanes");
    if (featureCount(id, "orchard-tree") !== 0) throw new Error("grid-quarters must not emit orchard trees");
    if (containment(id).outside > 0) throw new Error("grid-quarters spilled outside its ring");
    orchardId = await newFarmland(ORCHARD_RING, ORCHARD);
    const trees = featureCount(orchardId, "orchard-tree");
    if (trees < 1) throw new Error("orchard emitted no tree rows");
    if (featureCount(orchardId, "farm-field") < 1) throw new Error("orchard emitted no fields");
    if (containment(orchardId).outside > 0) throw new Error("orchard spilled outside its ring");
    console.log(`     [e] grid-quarters fields ${qFields} lanes ${qLanes}; orchard trees ${trees}`);
  });

  let cityId = "";
  await gate.try("(f) a farmland sketch over a city rim suppresses the city's outskirt fields; farmland claims the ground", async () => {
    cityId = (
      (await evalAsync(
        `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', ${CITY_PARAMS}, '${TEST_NAME}', 'district'); }`
      )) as { featureId: string }
    ).featureId;
    const baseFields = cityOutskirtFields(cityId);
    if (baseFields < 4) throw new Error(`euro-medieval city grew too few outskirt fields (${baseFields}) — can't test suppression`);
    // Sketch farmland over the whole city ring, then regenerate the CITY against
    // the new raw farmland sketch → its outskirt fields inside are suppressed.
    const farmId = await newFarmland(FARM_OVER_CITY, PATCHWORK);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(cityId)}); }`);
    const suppFields = cityOutskirtFields(cityId);
    const claimed = featureCount(farmId, "farm-field");
    console.log(`     [f] city outskirt fields ${baseFields} → ${suppFields}; farmland fields ${claimed}`);
    if (!(suppFields < baseFields * 0.5)) throw new Error(`city outskirt fields not suppressed (${baseFields} → ${suppFields})`);
    if (claimed < 4) throw new Error("the GM's farmland claimed too little ground");
    if (containment(farmId).outside > 0) throw new Error("farmland spilled outside its ring");
  });

  await gate.try("(g) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-20],zoom:5});v.map.jumpTo({center:[24,14],zoom:11});v.map.jumpTo({center:[-30,-20],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: enclosed-patchwork (irregular hedged fields)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${PATCHWORK}); }`);
    if (containment(id).outside > 0) throw new Error("patchwork spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-32],[-18,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.9-farmland-patchwork.png`);
  });

  await gate.try("screenshot: grid-quarters (rectilinear sections + section lanes)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${QUARTERS}); }`);
    if (containment(id).outside > 0) throw new Error("grid-quarters spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-32],[-18,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.9-farmland-grid-quarters.png`);
  });

  await gate.try("(h) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.9"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

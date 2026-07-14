#!/usr/bin/env tsx
// Procgen v4.8 gate — line-kind procgen: WALLS (plan 022 §3.4).
//
// Live against dev-vault via the obsidian CLI. Walls are sketched as LINES; the
// sketch is the spine, procgen elaborates it into a masonry band + towers +
// gates (where a sketched road crosses) + an optional moat, all strictly inside
// the spine corridor. The headless twin (createSpineForTest / createFabricForTest
// — modals hang CLI) runs the FULL commit path, so this gate exercises exactly
// what finishing a wall sketch does interactively.
//
//   (a) create a curtain wall → band + towers in cache + rendered, containment
//       holds + determinism (regenerate twice → byte-identical region records);
//   (b) vertex edit → the wall adapts (tower buckets change) and stays contained;
//       per-segment identity: an edit changes towers far LESS than a re-roll;
//   (c) a sketched ROAD crossing the spine → a wall-gate appears + the band gaps
//       (fewer band quads than the ungated wall);
//   (d) bastioned + moat → an outboard wall-moat channel emits, still contained;
//   (e) sketch-edit undo → restores the previous wall;
//   (f) double-wall resolution: a wall sketched along a city's rim suppresses the
//       city's OWN wall band there, while the sketched wall gains its own towers;
//   (g) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (h) dev:errors clean end-to-end;
//   screenshots → review/: a curtain wall (band + regular towers) and a
//       bastioned + moat (angular star-fort trace with a water channel).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p47_test__";
// Display units (1 unit = 50 m). All fixtures sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
// The west wall is a long angular FIVE-segment zigzag so a tight towerSpacing
// yields many along-run towers AND an endpoint edit only re-phases 1/5 of them
// (a stable, high locality statistic).
const WALL_LINE = "[[-34,-30],[-28,-22],[-34,-14],[-28,-6],[-34,2],[-28,10]]";
const WALL_LAST_IDX = 5; // open-index of the last vertex ([-28,10])
const CURTAIN = "{ style: 'curtain-wall', towerSpacing: 30, moat: false, gatehouseScale: 1 }";
const BASTIONED = "{ style: 'bastioned', towerSpacing: 70, moat: true, gatehouseScale: 1.4 }";
// A road crossing the first wall segment ([-34,-30]→[-28,-22]) at y=-26 (x≈-31).
const ROAD_CROSS = "[[-42,-26],[-24,-26]]";
// A euro-medieval city on the east side (always walls) for the double-wall test.
const CITY_RING = "[[14,4],[34,4],[34,24],[14,24]]";
const CITY_PARAMS = "{ profile: 'euro-medieval' }";
const CITY_CX = 24; // ring centroid (units)
const CITY_CY = 14;

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
/** Runs an async MapView method in-app, parking the result on window.__p47. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p47 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p47 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p47 = { ok: r }; }, function(e){ window.__p47 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p47 === undefined ? null : window.__p47)");
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
/** Coordinate buckets for one generatorId in a region (gen-space meters). */
function bucketsOf(id: string, gid: string, grid = 5): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!==${JSON.stringify(gid)})return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
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
/** City wall-band feature count (city-landmark, type 'wall') for a district. */
function cityWallBand(id: string): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var n=0;v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){var p=f.properties;if(p&&p.generatorId==='city-landmark'&&p.type==='wall')n++;});});return n;})()`;
  return evalJs(code) as number;
}
/** Trace the city's ACTUAL wall band (band-quad centroids, sorted by angle
 * around the district centroid), returned as DISPLAY-UNIT coords — a
 * self-calibrating "the GM drew a wall along the rim" fixture. */
function tracedWallUnits(id: string, cxU: number, cyU: number): [number, number][] {
  const code = `(function(){var v=${viewExpr()};var scale=v.campaign.config.scaleMetersPerUnit;var pre='region:'+${JSON.stringify(id)}+':';var cxM=${cxU}*scale,cyM=${cyU}*scale;var pts=[];v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){var p=f.properties;if(!p||p.generatorId!=='city-landmark'||p.type!=='wall')return;var ring=f.geometry.coordinates[0];var sx=0,sy=0,n=ring.length-1;for(var i=0;i<n;i++){sx+=ring[i][0];sy+=ring[i][1];}pts.push([sx/n,sy/n]);});});pts.sort(function(a,b){return Math.atan2(a[1]-cyM,a[0]-cxM)-Math.atan2(b[1]-cyM,b[0]-cxM);});var u=pts.map(function(p){return [p[0]/scale,p[1]/scale];});if(u.length>1)u.push(u[0]);return JSON.stringify(u);})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as [number, number][];
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
async function newWall(line: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createSpineForTest(${line}, 'wall', 'wall', ${params}, '${TEST_NAME}'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no wall features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the corridor at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.8 gate (line-kind procgen: walls) ==\n");

  await gate.try("unit gates: wall gen + fuzz + skeleton suppression + registry + generated paint + controller", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/wall.test.ts",
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
  await gate.try("(a) curtain wall → band + towers in cache + rendered, contained + deterministic", async () => {
    id = await newWall(WALL_LINE, CURTAIN);
    const quad = featureCount(id, "wall-quad");
    const tower = featureCount(id, "wall-tower");
    if (quad < 1) throw new Error("no wall-quad band rendered");
    if (tower < 1) throw new Error("no wall-tower features rendered");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the corridor`);
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the wall");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] band ${quad}, towers ${tower}; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit keeps towers per-segment (locality far above a re-roll) + contained", async () => {
    const base = bucketsOf(id, "wall-tower");
    // Move the LAST vertex — only the last of five segments re-phases; the
    // earlier segments' tower runs stay byte-identical.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, ${WALL_LAST_IDX}, [-22, 14]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, bucketsOf(id, "wall-tower"));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset, then re-roll from the same geometry → every segment re-phases.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, ${WALL_LAST_IDX}, [-28, 10]); }`);
    const pre = bucketsOf(id, "wall-tower");
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, bucketsOf(id, "wall-tower"));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
    if (!(editOverlap > 70)) throw new Error(`edit overlap unexpectedly low (${editOverlap.toFixed(1)}%)`);
  });

  await gate.try("(c) a sketched road crossing the spine opens a wall-gate + gaps the band", async () => {
    // Restore a clean curtain wall (re-roll left a random seed). The dev vault
    // may already have roads crossing this wall (legitimate gates), so measure
    // the DELTA my new road adds rather than assuming a gate-free baseline.
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${CURTAIN}); }`);
    const bandBefore = featureCount(id, "wall-quad");
    const gatesBefore = featureCount(id, "wall-gate");
    await evalAsync(`function(v){ return v.createFabricForTest('road', ${ROAD_CROSS}, '${TEST_NAME}'); }`);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const gatesAfter = featureCount(id, "wall-gate");
    const bandAfter = featureCount(id, "wall-quad");
    console.log(`     [c] gates ${gatesBefore} → ${gatesAfter}; band ${bandBefore} → ${bandAfter} (gap at the crossing)`);
    if (!(gatesAfter > gatesBefore)) throw new Error("the sketched road opened no new wall-gate");
    if (!(bandAfter < bandBefore)) throw new Error("the band did not gap at the new gate");
    if (containment(id).outside > 0) throw new Error("coords outside after the gate opened");
  });

  await gate.try("(d) bastioned + moat → an outboard wall-moat channel, still contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BASTIONED}); }`);
    const moat = featureCount(id, "wall-moat");
    const tower = featureCount(id, "wall-tower");
    console.log(`     [d] moat ${moat}, bastions/towers ${tower}`);
    if (moat < 1) throw new Error("bastioned+moat emitted no wall-moat");
    if (tower < 1) throw new Error("bastioned emitted no towers/bastions");
    if (containment(id).outside > 0) throw new Error("coords outside the WIDER (moated) corridor");
  });

  await gate.try("(e) sketch-edit undo restores the previous wall", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${CURTAIN}); }`);
    const pre = bucketsOf(id, "wall-quad");
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, ${WALL_LAST_IDX}, [-20, 14]); }`);
    const edited = bucketsOf(id, "wall-quad");
    if (overlapPct(pre, edited) > 97) throw new Error("edit didn't change the wall — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, bucketsOf(id, "wall-quad"));
    console.log(`     [e] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit wall (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  let cityId = "";
  await gate.try("(f) a wall sketched along a city rim suppresses the city's own wall; the sketch gains towers", async () => {
    cityId = (await evalAsync(
      `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', ${CITY_PARAMS}, '${TEST_NAME}', 'district'); }`
    ) as { featureId: string }).featureId;
    const baseBand = cityWallBand(cityId);
    if (baseBand < 4) throw new Error(`euro-medieval city grew no wall band (${baseBand}) — can't test suppression`);
    // Trace the city's ACTUAL wall band as a wall sketch, then generate it.
    const traced = tracedWallUnits(cityId, CITY_CX, CITY_CY);
    if (traced.length < 4) throw new Error("could not trace the city wall band");
    const wallId = await newWall(JSON.stringify(traced), CURTAIN);
    // Regenerate the CITY against the new raw wall sketch → its band is suppressed.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(cityId)}); }`);
    const suppBand = cityWallBand(cityId);
    const sketchedTowers = featureCount(wallId, "wall-tower");
    console.log(`     [f] city band ${baseBand} → ${suppBand}; sketched wall towers ${sketchedTowers}`);
    if (!(suppBand < baseBand * 0.5)) throw new Error(`city wall band not suppressed (${baseBand} → ${suppBand})`);
    if (sketchedTowers < 1) throw new Error("the GM's sketched wall gained no towers");
    if (containment(wallId).outside > 0) throw new Error("sketched wall spilled outside its corridor");
  });

  await gate.try("(g) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-28,-12],zoom:5});v.map.jumpTo({center:[24,14],zoom:11});v.map.jumpTo({center:[-28,-12],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: curtain wall (band + regular towers)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${CURTAIN}); }`);
    if (containment(id).outside > 0) throw new Error("curtain wall spilled outside its corridor");
    sync("(function(){v.map.fitBounds([[-37,-32],[-25,-11]],{animate:false,padding:30});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.8-wall-curtain.png`);
  });

  await gate.try("screenshot: bastioned + moat (angular trace, water channel)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BASTIONED}); }`);
    if (containment(id).outside > 0) throw new Error("bastioned wall spilled outside its corridor");
    sync("(function(){v.map.fitBounds([[-38,-32],[-24,-11]],{animate:false,padding:30});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.8-wall-bastioned-moat.png`);
  });

  await gate.try("(h) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.8"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env tsx
// Procgen v-canopy gate (plan 026-B, visual-overhaul wave 2) — ORGANIC
// MARCHING-SQUARES CANOPY. Named `procgen50-canopy` (procgen49 is 026-A trees;
// 40–49 taken and ∥ agents pick numbers, so the kind is encoded collision-proof.
// The orchestrator may renumber).
//
// Live against dev-vault via the obsidian CLI. A forest sketch's canopy is now
// ONE `forest-canopy` MultiPolygon (domain-warped masked density field → 23-C
// marching squares → Chaikin → nested exteriors + clearing holes) with a
// darker rim line; dead-wood emits NO canopy. The headless twin
// (createRegionForTest, kind=forest — modals hang CLI) runs the FULL commit path.
//
//   (a) broadleaf forest → ONE forest-canopy MultiPolygon rendered + in cache,
//       clearing HOLES present, containment 100%, determinism (regen ×2 →
//       byte-identical region records);
//   (b) rim line layer present + renders on the canopy outline;
//   (c) dead-wood → NO canopy feature, trees still present (bare stand);
//   (d) canopy spans ≥2 tiles and every clipped canopy coord sits inside its
//       tile — the whole-artifact clip is seam-safe (2×2 seam gate);
//   (e) vertex edit stays contained + adapts far less than a re-roll (locality);
//   (f) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: broadleaf canopy at OVERVIEW z≈4.5 AND CLOSE zoom
//       (organic silhouette, no staircase, rim reads, glade holes), variety strip.
//
// Visual bar to eyeball (plan 026 §5): canopy edge organic (no axis-aligned
// staircase / interior lattice); clearings read as holes; rim reads; dead-wood
// bare; no seams at tile joins.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p50_test__";
// Display units (1 unit = 50 m). All rings sit inside bounds [-48,-36,48,36] and
// clear of the migrated Vespergate district (~[-4.8, 6]).
const BROADLEAF_RING = "[[18,10],[34,10],[34,26],[18,26]]";
const CONIFER_RING = "[[-40,-28],[-24,-28],[-24,-12],[-40,-12]]";
const DEADWOOD_RING = "[[-40,12],[-24,12],[-24,28],[-40,28]]";
const BROADLEAF = "{ variety: 'broadleaf', density: 0.72, clearings: 0.28, edgeRaggedness: 0.55 }";
const CONIFER = "{ variety: 'conifer', density: 0.8, clearings: 0.1, edgeRaggedness: 0.35 }";
const DEADWOOD = "{ variety: 'dead-wood', density: 0.4, clearings: 0.3, edgeRaggedness: 0.7 }";

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
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p50 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p50 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p50 = { ok: r }; }, function(e){ window.__p50 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p50 === undefined ? null : window.__p50)");
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
function treeCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'forest-tree').length`) as number;
}
function canopyCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'forest-canopy').length`) as number;
}
/** Canopy stats from the clipped per-tile features MapView paints: how many
 * tiles carry a canopy piece, aggregate MultiPolygon holes, total vertices, and
 * whether the geometry stayed a (Multi)Polygon through the tile clip. */
function canopyStats(id: string): { tiles: number; holes: number; verts: number; multipoly: boolean } {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';
    var tiles=0,holes=0,verts=0,multipoly=true;
    v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;
      var has=false;
      feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='forest-canopy')return;
        has=true; var g=f.geometry; if(!g)return;
        if(g.type!=='MultiPolygon'&&g.type!=='Polygon')multipoly=false;
        var polys = g.type==='MultiPolygon'?g.coordinates:[g.coordinates];
        polys.forEach(function(poly){ if(poly.length>1)holes+=poly.length-1;
          poly.forEach(function(ring){ring.forEach(function(p){verts++;});});});
      });
      if(has)tiles++;
    });
    return JSON.stringify({tiles:tiles,holes:holes,verts:verts,multipoly:multipoly});})()`;
  const r = evalJs(code);
  return JSON.parse(typeof r === "string" ? r : JSON.stringify(r));
}
/** Per-tile canopy records (from disk), keyed `region:<id>:<x>:<y>:forest-canopy`. */
function canopyTileRecords(regionId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of regionCacheRecords(regionId)) if (k.endsWith(":forest-canopy")) out.set(k, v);
  return out;
}
/** forest-canopy feature count in the UN-clipped network record
 * (`region:<id>:network`) — the generator emits ONE MultiPolygon there; the
 * per-tile view then carries one clipped piece per tile it touches. */
function networkCanopyCount(regionId: string): number {
  if (!existsSync(CACHE_ABS)) return -1;
  const netKey = `region:${regionId}:network`;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; features: { properties?: { generatorId?: string } }[] };
    if (rec.key !== netKey) continue;
    return rec.features.filter((f) => f.properties?.generatorId === "forest-canopy").length;
  }
  return -1;
}
/** Rendered feature counts on a layer (real pipeline probe). */
function renderedCount(layer: string): number {
  const code = `(function(){var v=${viewExpr()};var fs=v.map.queryRenderedFeatures({layers:[${JSON.stringify(layer)}]})||[];return fs.length;})()`;
  return Number(evalJs(code));
}
function layerExists(layer: string): boolean {
  return evalJs(`(function(){var v=${viewExpr()};return !!v.map.getLayer(${JSON.stringify(layer)});})()`) === true;
}
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
            return !removed.some((idv) => idv && r.key.startsWith(`region:${idv}:`));
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
  console.log("== Procgen v-canopy gate (plan 026-B: organic marching-squares canopy) ==\n");

  await gate.try("unit gates: forest gen (canopy topology) + field pipeline + generated forest paint", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/forest.test.ts",
        "src/gen/fields/smoothing.test.ts",
        "src/gen/fields/metaball.test.ts",
        "src/gen/fields/polygons.test.ts",
        "src/gen/citynet/citynet.test.ts",
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
  await gate.try("(a) broadleaf → ONE canopy MultiPolygon (holes) rendered + contained + deterministic", async () => {
    id = await newForest(BROADLEAF_RING, BROADLEAF);
    const netCanopies = networkCanopyCount(id);
    if (netCanopies !== 1) throw new Error(`expected ONE canopy MultiPolygon in the network record, got ${netCanopies}`);
    if (canopyCount(id) < 1) throw new Error("no forest-canopy feature reached the tiles");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    // Rendered probe: fit the forest, then query the canopy fill layer.
    sync("(function(){v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    if (renderedCount("generated-forest-canopy") < 1) throw new Error("no canopy rendered on the fill layer");
    const st = canopyStats(id);
    if (!st.multipoly) throw new Error("canopy geometry is not a (Multi)Polygon");
    if (st.holes < 1) throw new Error("no clearing holes in the canopy (glades did not punch through)");
    if (st.verts < 40) throw new Error(`canopy too coarse (${st.verts} verts) — expected a smoothed organic outline`);
    // Determinism: regenerate twice, records byte-identical.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] 1 canopy MP; ${st.holes} holes; ${st.verts} verts; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) rim line layer present + renders on the canopy outline", async () => {
    if (!layerExists("generated-forest-rim")) throw new Error("generated-forest-rim layer missing");
    if (renderedCount("generated-forest-rim") < 1) throw new Error("no canopy rim rendered");
  });

  await gate.try("(c) dead-wood → NO canopy, trees still present (bare stand)", async () => {
    const deadId = await newForest(DEADWOOD_RING, DEADWOOD);
    if (canopyCount(deadId) !== 0) throw new Error(`dead-wood emitted a canopy (${canopyCount(deadId)}) — must be bare`);
    if (treeCount(deadId) < 1) throw new Error("dead-wood emitted no trees");
    if (containment(deadId).outside > 0) throw new Error("dead-wood spilled outside its ring");
  });

  await gate.try("(d) canopy spans ≥2 tiles; per-tile clip regenerates byte-identically (seam-safe)", async () => {
    const st = canopyStats(id);
    if (st.tiles < 2) throw new Error(`canopy only touched ${st.tiles} tile(s) — cannot exercise a seam`);
    // Whole-artifact clip: two abutting tiles clip their shared edge with the
    // same Sutherland-Hodgman formula, so per-tile canopy records are stable
    // across a regenerate (a wobble here = a seam). Coord-in-tile is unit-gated
    // (forest.test "2x2 seam via whole-artifact clip").
    const r1 = canopyTileRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = canopyTileRecords(id);
    if (r2.size < 2) throw new Error(`only ${r2.size} canopy tile record(s) after regen`);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`canopy tile ${k} changed across regenerate — clip not seam-stable`);
    }
    console.log(`     [d] canopy spans ${st.tiles} tiles; ${r2.size} tile records byte-stable across regen`);
  });

  await gate.try("(e) vertex edit stays contained + adapts far less than a re-roll (edit-locality)", async () => {
    const base = canopyBuckets(id);
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [38, 10]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, canopyBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [34, 10]); }`);
    const pre = canopyBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, canopyBuckets(id));
    console.log(`     [e] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
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

  await gate.try("screenshot: broadleaf canopy at OVERVIEW z≈4.5", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BROADLEAF}); }`);
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:4.5});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-canopy-broadleaf-overview.png`);
  });

  await gate.try("screenshot: broadleaf canopy CLOSE (organic edge, rim, glade holes)", async () => {
    sync("(function(){v.map.fitBounds([[17,9],[35,27]],{animate:false,padding:20});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-canopy-broadleaf-close.png`);
  });

  await gate.try("screenshot: variety strip (broadleaf / conifer / dead-wood canopies)", async () => {
    await newForest(CONIFER_RING, CONIFER);
    sync("(function(){v.map.fitBounds([[-42,-30],[36,30]],{animate:false,padding:30});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-canopy-varieties.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v-canopy (026-B)"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

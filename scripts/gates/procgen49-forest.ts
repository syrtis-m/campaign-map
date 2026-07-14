#!/usr/bin/env tsx
// Procgen v-forest gate (plan 026-A, visual-overhaul wave 1) — CLUMPED VARIED
// TREES + stacked circle paint. Named `procgen49-forest` (not the plan's stale
// "procgen47", which is now WALLS): procgen40–48 are taken and three ∥ agents
// pick numbers concurrently, so the kind is encoded to be collision-proof. The
// orchestrator may renumber.
//
// Live against dev-vault via the obsidian CLI. Forests are sketched as POLYGONS;
// plan 026-A replaces the plan-022 stipple grid with a hashed Thomas-cluster
// tree scatter (clump parents + offspring + rejected loners) carrying
// sizeN/rank/variant, painted as a shadow/base/highlight circle stack tinted
// per variety. The headless twin (createRegionForTest, kind=forest — modals
// hang CLI) runs the FULL commit path, exactly what confirming a forest sketch
// does interactively.
//
//   (a) create a broadleaf forest → forest-tree features in cache + rendered
//       (queryRenderedFeatures on the base tree layer), containment 100% +
//       determinism (regenerate twice → byte-identical region records);
//   (b) vertex edit → the forest adapts (canopy bucket set changes) far LESS
//       than a re-roll (identity/edit-locality) and stays contained;
//   (c) tree-size variance > 0: rendered sizeN spans a range (varied sizes,
//       not one flat radius);
//   (d) per-variety colour: a conifer and a dead-wood forest both render tree
//       features, and the base layer's circle-color match resolves their
//       forestType to DISTINCT colours (queryRenderedFeatures + paint probe);
//   (e) rerollRegion → NEW seed, output changes, still contained;
//   (f) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: broadleaf wood at OVERVIEW z≈4.5 AND CLOSE zoom
//       (individual clumped, size-varied trees), plus a five-variety strip.
//
// Visual bar to eyeball (plan 026 §5): no visible lattice/grid in the trees;
// trees vary in size ≥2× and cluster visibly (clumps + gaps, not a mesh);
// each variety identifiable by hue in 3 s; dead-wood reads bare/grey; no seams.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p49_test__";
// Display units (1 unit = 50 m). Both forests sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
const BROADLEAF_RING = "[[18,10],[34,10],[34,26],[18,26]]";
const CONIFER_RING = "[[-40,-28],[-24,-28],[-24,-12],[-40,-12]]";
const DEADWOOD_RING = "[[-40,12],[-24,12],[-24,28],[-40,28]]";
const BROADLEAF = "{ variety: 'broadleaf', density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 }";
const CONIFER = "{ variety: 'conifer', density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 }";
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
/** Runs an async MapView method in-app, parking the result on window.__p49. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p49 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p49 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p49 = { ok: r }; }, function(e){ window.__p49 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p49 === undefined ? null : window.__p49)");
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
 * the adapt/re-roll stability measure (canopy is unchanged by 026-A, so it stays
 * the established edit-locality signal; trees are a small minority of coords). */
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
function treeCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'forest-tree').length`) as number;
}
/** Rendered tree features from the base circle layer (real pipeline probe). */
function renderedTrees(): { forestType: string; sizeN: number; rank: number }[] {
  const code = `(function(){var v=${viewExpr()};var fs=v.map.queryRenderedFeatures({layers:['generated-forest-tree-base']})||[];return JSON.stringify(fs.map(function(f){return {forestType:f.properties.forestType,sizeN:f.properties.sizeN,rank:f.properties.rank};}));})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as { forestType: string; sizeN: number; rank: number }[];
}
/** Resolve the base tree layer's circle-color match for a given forestType. */
function variantColor(forestType: string): string {
  const code = `(function(){var v=${viewExpr()};var expr=v.map.getPaintProperty('generated-forest-tree-base','circle-color');if(!Array.isArray(expr))return String(expr);for(var i=2;i+1<expr.length;i+=2){if(expr[i]===${JSON.stringify(forestType)})return String(expr[i+1]);}return String(expr[expr.length-1]);})()`;
  return String(evalJs(code));
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
  console.log("== Procgen v-forest gate (plan 026-A: clumped varied trees) ==\n");

  await gate.try("unit gates: forest gen (cluster stats + property carry) + generated forest paint", () => {
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
  await gate.try("(a) broadleaf forest → tree features in cache + rendered, contained + deterministic", async () => {
    id = await newForest(BROADLEAF_RING, BROADLEAF);
    const n = treeCount(id);
    if (n < 1) throw new Error("no forest-tree features generated");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the ring`);
    // Rendered probe: fit the forest, then query the base tree layer.
    sync("(function(){v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    const rendered = renderedTrees();
    if (rendered.length < 1) throw new Error("no forest-tree features RENDERED on the base layer");
    // Determinism: regenerate twice, records byte-identical.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] ${n} forest-tree features; ${rendered.length} rendered; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (edit-locality) + stays contained", async () => {
    const base = canopyBuckets(id);
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [38, 10]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, canopyBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [34, 10]); }`);
    const pre = canopyBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, canopyBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
  });

  await gate.try("(c) rendered tree size varies (variance > 0 — not one flat radius)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BROADLEAF}); }`);
    sync("(function(){v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    const sizes = renderedTrees().map((t) => Number(t.sizeN)).filter((s) => Number.isFinite(s));
    if (sizes.length < 5) throw new Error(`too few rendered trees to measure size (${sizes.length})`);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const varr = sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length;
    console.log(`     [c] sizeN min ${min.toFixed(3)} max ${max.toFixed(3)} spread ${(max - min).toFixed(3)} var ${varr.toExponential(2)}`);
    if (!(varr > 0) || !(max - min > 0.2)) throw new Error("tree size did not vary (flat sizeN)");
  });

  let coniId = "";
  await gate.try("(d) per-variety colour: conifer vs dead-wood render + tint distinctly", async () => {
    coniId = await newForest(CONIFER_RING, CONIFER);
    const deadId = await newForest(DEADWOOD_RING, DEADWOOD);
    if (containment(coniId).outside > 0) throw new Error("conifer spilled outside its ring");
    if (containment(deadId).outside > 0) throw new Error("dead-wood spilled outside its ring");
    // Rendered probe across both forests.
    sync("(function(){v.map.fitBounds([[-42,-30],[-22,30]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    const types = new Set(renderedTrees().map((t) => t.forestType));
    if (!types.has("conifer")) throw new Error("no conifer trees rendered");
    if (!types.has("dead-wood")) throw new Error("no dead-wood trees rendered");
    const coni = variantColor("conifer");
    const dead = variantColor("dead-wood");
    console.log(`     [d] conifer tint ${coni} | dead-wood tint ${dead}`);
    if (coni.toLowerCase() === dead.toLowerCase()) throw new Error("conifer and dead-wood share a tint");
  });

  await gate.try("(e) re-roll → new seed, output changes", async () => {
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = canopyBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, canopyBuckets(id));
    console.log(`     [e] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 92) throw new Error("re-roll did not visibly change the forest");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
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

  await gate.try("screenshot: broadleaf wood at OVERVIEW z≈4.5", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${BROADLEAF}); }`);
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:4.5});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w1-forest-broadleaf-overview.png`);
  });

  await gate.try("screenshot: broadleaf wood CLOSE (clumps + varied sizes visible)", async () => {
    sync("(function(){v.map.fitBounds([[20,12],[30,22]],{animate:false,padding:20});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w1-forest-broadleaf-close.png`);
  });

  await gate.try("screenshot: variety strip (broadleaf / conifer / dead-wood)", async () => {
    sync("(function(){v.map.fitBounds([[-42,-30],[36,30]],{animate:false,padding:30});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w1-forest-varieties.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v-forest (026-A)"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

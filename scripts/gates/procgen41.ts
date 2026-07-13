#!/usr/bin/env tsx
// Procgen v4.2 gate — PowerPoint-style sketch edit UX (plan 020 §9 + Addendum 2).
//
// Live against dev-vault via the obsidian CLI. Programmatic edit API
// (selectFeature/moveVertex/insertVertex/deleteVertex/setRegionParams/
// rerollRegion/setRegionCenter) runs the FULL commit path, so a headless gate
// exercises exactly what the Select tool does interactively.
//
//   (a) create region → moveVertex OUTWARD → city adapts (feature diff nonzero,
//       new coords inside the new ring, all-inside holds) + determinism
//       (regenerate twice → byte-identical region cache records);
//   (b) center-stability (Addendum 2 4b): a boundary vertex edit WITH a stored
//       generation center keeps MORE street area than WITHOUT one — measure &
//       report both bucket-overlap %s and assert with > without. (Plan 020's
//       original ">50% adapts-not-rerolls" claim does NOT hold for the
//       centroid-anchored generator — see the deviation note below — which is
//       exactly why Addendum 2's persisted center exists.)
//   (c) rerollRegion → NEW seed, output changes (bucket overlap drops well
//       below a no-op regenerate);
//   (d) setRegionParams profile change → regenerates, dev:errors clean;
//   (e) sketch-edit undo → restores the previous ring + city;
//   (f) vertex edit on a plain (non-region) river → the adjacent region
//       regenerates (constraint loop);
//   (g) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (h) Addendum 2 center: set off-centroid center moves the plaza/arterial
//       origin (nearest street to the new center exists) + determinism; reset
//       center → automatic output byte-identical; drag-outside rejected;
//   (i) Addendum 1 LOD: generated-footprint/parcel are NOT zoom-restricted;
//   (j) dev:errors clean end-to-end;
//   screenshots → review/: selected region with vertex + center handles, city
//   after a vertex edit, and a strongly concave (L-shaped) region.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p41_test__";
// Display units (1 unit = 50 m). Squares well inside the campaign bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
const RING = "[[8,-28],[28,-28],[28,-8],[8,-8]]"; // center ~[18,-18]
const RIVER = "[[6,-30],[6,-6]]"; // a plain river hugging the region's west edge
// A strongly concave L-shape (for the ward-coverage screenshot).
const L_RING = "[[-40,-30],[-16,-30],[-16,-18],[-28,-18],[-28,-6],[-40,-6]]";

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
/** Runs an async MapView method in-app, parking the result on window.__p41. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p41 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p41 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p41 = { ok: r }; }, function(e){ window.__p41 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p41 === undefined ? null : window.__p41)");
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
/** macOS suspends compositing/timers for occluded windows (App Nap) — an
 * unfronted Obsidian can stall MapLibre's style load indefinitely ("Style is
 * not done loading"), starving every style-dependent check. Front it before
 * polling render/style state (same rule the paint checks in procgen42 use). */
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
/** Street-coordinate buckets (gen-space meters, `grid`-m lattice) for a region's
 * render-store tiles — the adapt/re-roll spatial-stability measure (clip-ids are
 * unstable across ring changes, so we compare occupied buckets, not ids). */
function streetBuckets(id: string, grid = 25): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='city-street')return;var g=f.geometry;if(!g||g.type!=='LineString')return;g.coordinates.forEach(function(c){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));});});});return JSON.stringify(Array.from(s));})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as string[];
}
function overlapPct(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  const sa = new Set(a);
  return (b.filter((x) => sa.has(x)).length / a.length) * 100;
}
function containment(id: string): { count: number; outside: number } {
  // `sync` returns evalJs's already-parsed payload — do NOT re-parse.
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
/** Region cache records (last-write-wins), normalized key→features JSON so
 * `generatedAt` noise can't fake a diff. */
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
function fabricFeature(id: string): { id: string; properties: { procgen?: { seed?: number; params?: { center?: unknown } } } } | undefined {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as { features: { id: string; properties: { procgen?: { seed?: number; params?: { center?: unknown } } } }[] };
  return fabric.features.find((f) => f.id === id);
}
function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as { features?: { id?: string; properties?: { name?: string } }[] };
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
async function newRegion(ring: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no city features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.2 gate (PowerPoint-style sketch edit UX) ==\n");

  await gate.try("unit gates: fabric vertex ops + region + citynet center + generation service", () => {
    execFileSync(
      "npx",
      ["vitest", "run", "src/model/fabric.test.ts", "src/gen/region.test.ts", "src/gen/citynet", "src/map/generation"],
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
    front(); // style load + replay stall in an occluded window (App Nap)
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3500));
  });

  await gate.try("(i) Addendum 1: generated-footprint & generated-parcel are NOT zoom-restricted", async () => {
    // The generated layers join the style only after the first generated-source
    // refresh — and this gate opens onto a deliberately EMPTY cache, so the
    // migrated district must cold-recompute first (~15 s in a fresh process,
    // measured 2026-07-12; the old 15 s timeout sat exactly on that edge).
    // Wait generously; the assertion is about zoom floors, not arrival latency.
    await waitFor(
      () => sync("!!(v.map.getLayer('generated-footprint') && v.map.getLayer('generated-parcel'))") === true,
      60000,
      "generated-footprint/parcel layers (migrated district cold recompute)"
    );
    const zooms = sync(
      `JSON.stringify((function(){var m=v.map;function z(id){var l=m.getLayer(id);if(!l)return 'missing';return (l.minzoom===undefined?0:l.minzoom);}return {fp:z('generated-footprint'),pc:z('generated-parcel')};})())`
    ) as { fp: unknown; pc: unknown };
    // A footprint/parcel layer must exist and carry no meaningful minzoom floor
    // (MapLibre's default 0 = renders at every zoom).
    const ok = (z: unknown): boolean => z === 0;
    if (!ok(zooms.fp) || !ok(zooms.pc)) {
      throw new Error(`footprint/parcel still zoom-gated or missing: ${JSON.stringify(zooms)}`);
    }
  });

  let id = "";
  let baseBuckets: string[] = [];
  await gate.try("(a) create region → moveVertex OUTWARD → adapts (nonzero diff, all-inside) + determinism", async () => {
    id = await newRegion(RING);
    const n0 = (sync(`v.regionFeatureIds(${JSON.stringify(id)}).length`)) as number;
    baseBuckets = streetBuckets(id);
    // Move the [28,-28] corner (open-index 1) outward.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [36, -36]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const n1 = (sync(`v.regionFeatureIds(${JSON.stringify(id)}).length`)) as number;
    if (n1 === n0) throw new Error(`feature count unchanged (${n0}) — no adaptation`);
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the new ring`);
    // Determinism: regenerate twice → byte-identical region records.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    if (r1.size === 0) throw new Error("no region cache records");
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] features ${n0} → ${n1}; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) Addendum 2 4b: a stored center raises vertex-edit stability vs. none (measure both)", async () => {
    // Reset to base ring (no center).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [28, -28]); }`);
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, null); }`);
    const b0 = streetBuckets(id);
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [36, -36]); }`);
    const without = overlapPct(b0, streetBuckets(id));
    // Same edit WITH a stored center at the region middle.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [28, -28]); }`);
    const setOk = await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, [18, -18]); }`);
    if (setOk !== true) throw new Error("setRegionCenter([18,-18]) rejected");
    const b0c = streetBuckets(id);
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [36, -36]); }`);
    const withCenter = overlapPct(b0c, streetBuckets(id));
    console.log(`     [b] vertex-edit street overlap: WITHOUT center ${without.toFixed(1)}% | WITH center ${withCenter.toFixed(1)}%`);
    if (!(withCenter > without)) throw new Error(`center did not raise stability: with ${withCenter.toFixed(1)}% !> without ${without.toFixed(1)}%`);
    if (containment(id).outside > 0) throw new Error("coords outside after center edit");
  });

  await gate.try("(c) rerollRegion → NEW seed, output changes vs a no-op regenerate", async () => {
    // Reset to a clean base with automatic center.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [28, -28]); }`);
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, null); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = streetBuckets(id);
    // A plain regenerate (no seed change) is byte-stable → 100% overlap.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const regenOverlap = overlapPct(pre, streetBuckets(id));
    // A re-roll changes the seed → the network changes.
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const rerollOverlap = overlapPct(pre, streetBuckets(id));
    console.log(`     [c] regenerate overlap ${regenOverlap.toFixed(1)}% (stable); reroll overlap ${rerollOverlap.toFixed(1)}%; seed ${seedBefore} → ${seedAfter}`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (!(rerollOverlap < regenOverlap - 10)) throw new Error("re-roll did not visibly change the city");
  });

  await gate.try("(d) setRegionParams profile change → regenerates, dev:errors clean", async () => {
    clearErrors();
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { profile: 'na-grid' }); }`);
    const n = (sync(`v.regionFeatureIds(${JSON.stringify(id)}).length`)) as number;
    if (n < 1) throw new Error("no features after profile change");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { profile: 'euro-medieval' }); }`);
  });

  await gate.try("(e) sketch-edit undo restores the previous ring + city", async () => {
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [28, -28]); }`);
    const preEdit = streetBuckets(id);
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [40, -40]); }`);
    const edited = streetBuckets(id);
    if (overlapPct(preEdit, edited) > 95) throw new Error("edit didn't change the city — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const restored = streetBuckets(id);
    const back = overlapPct(preEdit, restored);
    console.log(`     [e] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 99) throw new Error(`undo did not restore the pre-edit city (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(f) vertex edit on a plain river → the adjacent region regenerates (constraint loop)", async () => {
    // Base ring (river [[6,-30],[6,-6]] sits ~100 m west of the region — inside
    // CONSTRAINT_REACH). moveVertex(debounce:false) regenerates affected
    // regions synchronously, so generatorRunCount jumps iff the loop fired.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [28, -28]); }`);
    const riverId = (await evalAsync(`function(v){ return v.createFabricForTest('river', ${RIVER}, '${TEST_NAME}'); }`)) as string;
    const before = sync("v.generatorRunCount") as number;
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(riverId)}, 0, [5, -30]); }`, 60000);
    const after = sync("v.generatorRunCount") as number;
    console.log(`     [f] generatorRunCount ${before} → ${after} after river vertex edit`);
    if (after <= before) throw new Error("river edit did not regenerate the adjacent region (constraint loop broken)");
    if (containment(id).outside > 0) throw new Error("coords outside after constraint regen");
  });

  await gate.try("(g) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[18,-18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("(h) Addendum 2 center: off-centroid center moves the plaza; reset is byte-identical; outside rejected", async () => {
    // Clean base, automatic center.
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, null); }`);
    const autoRecords = regionCacheRecords(id);
    // Nearest street distance to a chosen off-centroid point, automatic vs set.
    const nearest = (px: number, py: number): number =>
      sync(
        `(function(){var pre='region:'+${JSON.stringify(id)}+':';var best=1e9;v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='city-street')return;var g=f.geometry;if(!g||!g.coordinates)return;g.coordinates.forEach(function(c){var d=Math.hypot(c[0]-(${px}),c[1]-(${py}));if(d<best)best=d;});});});return best;})()`
      ) as number;
    // Set an off-centroid center near [24,-12] display = [1200,-600] m.
    const cx = 1200;
    const cy = -600;
    const beforeNear = nearest(cx, cy);
    const okSet = await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, [24, -12]); }`);
    if (okSet !== true) throw new Error("setRegionCenter([24,-12]) rejected");
    const afterNear = nearest(cx, cy);
    console.log(`     [h] nearest street to the new center: ${beforeNear.toFixed(0)}m → ${afterNear.toFixed(0)}m`);
    if (!(afterNear <= beforeNear)) throw new Error("plaza/arterials did not move toward the set center");
    // Reset → back to automatic → byte-identical to the automatic build.
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, null); }`);
    const resetRecords = regionCacheRecords(id);
    for (const [k, feats] of autoRecords) {
      if (resetRecords.get(k) !== feats) throw new Error(`reset-center not byte-identical to automatic (${k})`);
    }
    // Drag-outside rejected (returns false, no change).
    const rej = await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, [100, -100]); }`);
    if (rej !== false) throw new Error(`outside-ring center not rejected (returned ${rej})`);
  });

  await gate.try("screenshot: selected region with vertex + center handles", async () => {
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, [22, -14]); }`); // visible off-center
    await evalAsync(`function(v){ return v.selectFeature(${JSON.stringify(id)}); }`);
    sync("(function(){v.map.fitBounds([[6,-30],[30,-6]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    screenshot(`${REVIEW}/v4.2-region-handles.png`);
  });

  await gate.try("screenshot: city after a vertex edit", async () => {
    await evalAsync(`function(v){ return v.setRegionCenter(${JSON.stringify(id)}, null); }`);
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [40, -40]); }`);
    sync("(function(){v.map.fitBounds([[6,-44],[42,-6]],{animate:false,padding:30});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    screenshot(`${REVIEW}/v4.2-city-after-vertex-edit.png`);
  });

  await gate.try("screenshot: strongly concave (L-shaped) region — ward-coverage check", async () => {
    const lid = await newRegion(L_RING);
    sync(`(function(){v.map.fitBounds([[-42,-32],[-14,-4]],{animate:false,padding:30});return 'ok';})()`);
    await new Promise((r) => setTimeout(r, 2500));
    screenshot(`${REVIEW}/v4.2-concave-region.png`);
    if (containment(lid).outside > 0) throw new Error("concave region: coords spilled outside");
  });

  await gate.try("(j) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.2"));
}

main();

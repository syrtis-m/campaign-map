#!/usr/bin/env tsx
// Procgen v-glyphs gate (plan 026-C, visual-overhaul wave 2) — TREE GLYPH
// SYMBOL LAYERS. Named `procgen51-glyphs` (49 = 026-A trees, 50 = 026-B canopy;
// the kind is encoded collision-proof, the orchestrator may renumber).
//
// Live against dev-vault via the obsidian CLI. Plan 026-C replaces the 026-A
// stacked-circle tree paint with per-variety SDF tree GLYPHS drawn by two symbol
// layers (a dark icon-translate shadow below + the variety-tinted base with an
// icon-halo rim), backed by a reusable runtime glyph module (src/map/
// treeGlyphs.ts). Images are synthesized host-side (pure SDF math, no canvas),
// registered via map.addImage({sdf:true}), and kept alive across setStyle by a
// persistent `styleimagemissing` provider. The headless twin
// (createRegionForTest, kind=forest — modals hang CLI) runs the FULL commit path.
//
//   (a) broadleaf forest → forest-tree features RENDERED on the base SYMBOL layer
//       (queryRenderedFeatures) + the glyph images registered (map.hasImage),
//       containment 100% + determinism (regen ×2 → byte-identical region records);
//   (b) per-variety glyphs: conifer + dead-wood render distinct forestTypes and
//       each family's glyph image is registered + distinct id;
//   (c) glyph images SURVIVE a hard setStyle (theme rebuild drops every image;
//       the styleimagemissing provider restores them on the next render);
//   (d) shadow layer present, offset (icon-translate), and renders under the base;
//   (e) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (f) PERF: frame-time sampler during a scripted pan over a dense forest
//       (CI-machine number — no CPU-throttle harness in docs/05; honest framing
//       per phase4, real number logged for Jonah's Surface Pro eyeball);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: broadleaf wood CLOSE (trees read as GLYPHS, shadow +
//       varied sizes + clumps), OVERVIEW z≈4.5, five-variety strip.
//
// Visual bar to eyeball (plan 026 §5): trees read as tree glyphs (not dots);
// varieties distinguishable in 3 s (conifer spires vs broadleaf blobs vs bare
// dead-wood forks); shadow offset visible; no collision-culling gaps; no seams.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p51_test__";
// Display units (1 unit = 50 m). All rings sit inside bounds [-48,-36,48,36] and
// clear of the migrated Vespergate district (~[-4.8, 6]).
const BROADLEAF_RING = "[[18,10],[34,10],[34,26],[18,26]]";
const CONIFER_RING = "[[-40,-28],[-24,-28],[-24,-12],[-40,-12]]";
const DEADWOOD_RING = "[[-40,12],[-24,12],[-24,28],[-40,28]]";
const SWAMP_RING = "[[2,-30],[18,-30],[18,-14],[2,-14]]";
const BROADLEAF = "{ variety: 'broadleaf', density: 0.78, clearings: 0.18, edgeRaggedness: 0.5 }";
const CONIFER = "{ variety: 'conifer', density: 0.85, clearings: 0.08, edgeRaggedness: 0.3 }";
const DEADWOOD = "{ variety: 'dead-wood', density: 0.5, clearings: 0.3, edgeRaggedness: 0.7 }";
const SWAMP = "{ variety: 'swamp', density: 0.6, clearings: 0.2, edgeRaggedness: 0.6 }";

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
  evalJs(`window.__p51 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p51 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p51 = { ok: r }; }, function(e){ window.__p51 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p51 === undefined ? null : window.__p51)");
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
/** Rendered tree features from the base SYMBOL layer (real pipeline probe). */
function renderedGlyphs(): { forestType: string; variant: number; rank: number }[] {
  const code = `(function(){var v=${viewExpr()};var fs=v.map.queryRenderedFeatures({layers:['generated-forest-tree']})||[];return JSON.stringify(fs.map(function(f){return {forestType:f.properties.forestType,variant:f.properties.variant,rank:f.properties.rank};}));})()`;
  const r = evalJs(code);
  return (typeof r === "string" ? JSON.parse(r) : r) as { forestType: string; variant: number; rank: number }[];
}
function renderedCount(layer: string): number {
  const code = `(function(){var v=${viewExpr()};var fs=v.map.queryRenderedFeatures({layers:[${JSON.stringify(layer)}]})||[];return fs.length;})()`;
  return Number(evalJs(code));
}
function hasImage(id: string): boolean {
  return evalJs(`(function(){var v=${viewExpr()};return v.map.hasImage(${JSON.stringify(id)});})()`) === true;
}
function layerExists(layer: string): boolean {
  return evalJs(`(function(){var v=${viewExpr()};return !!v.map.getLayer(${JSON.stringify(layer)});})()`) === true;
}
function paintProp(layer: string, prop: string): unknown {
  // evalJs already JSON-parses the payload, so a stringified array comes back as
  // an array — parse only when it's still a string (matches the other probes).
  const r = evalJs(
    `(function(){var v=${viewExpr()};return JSON.stringify(v.map.getPaintProperty(${JSON.stringify(layer)}, ${JSON.stringify(prop)}));})()`
  );
  return typeof r === "string" ? JSON.parse(r) : r;
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
  console.log("== Procgen v-glyphs gate (plan 026-C: tree glyph symbol layers) ==\n");

  await gate.try("unit gates: glyph module (pixel-hash) + generated forest paint + forest gen", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/map/treeGlyphs.test.ts",
        "src/map/themes/generatedLayers.test.ts",
        "src/gen/forest.test.ts",
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
  await gate.try("(a) broadleaf → glyphs RENDERED on the symbol layer + images registered, contained + deterministic", async () => {
    id = await newForest(BROADLEAF_RING, BROADLEAF);
    const n = treeCount(id);
    if (n < 1) throw new Error("no forest-tree features generated");
    if (containment(id).outside > 0) throw new Error("coords outside the ring");
    // Fit the forest, then query the base symbol layer.
    sync("(function(){v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    const rendered = renderedGlyphs();
    if (rendered.length < 1) throw new Error("no forest-tree glyphs RENDERED on the base symbol layer");
    // Glyph images must be registered (SDF, addImage).
    if (!hasImage("tree-broadleaf-0")) throw new Error("tree-broadleaf-0 glyph image not registered");
    if (!hasImage("tree-broadleaf-3")) throw new Error("tree-broadleaf-3 glyph image not registered");
    // Variants actually vary across the rendered set (hashed glyph pick).
    const variants = new Set(rendered.map((t) => Number(t.variant)));
    if (variants.size < 2) throw new Error(`glyph variants did not vary (${variants.size})`);
    // Determinism: regenerate twice, records byte-identical (paint/host only; the
    // generator is untouched by 026-C, so this must still hold exactly).
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] ${n} trees; ${rendered.length} glyphs rendered; ${variants.size} variants; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) per-variety glyphs: conifer + dead-wood render distinct forestTypes + registered distinct images", async () => {
    const coniId = await newForest(CONIFER_RING, CONIFER);
    const deadId = await newForest(DEADWOOD_RING, DEADWOOD);
    if (containment(coniId).outside > 0) throw new Error("conifer spilled outside its ring");
    if (containment(deadId).outside > 0) throw new Error("dead-wood spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-30],[-22,30]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    const types = new Set(renderedGlyphs().map((t) => t.forestType));
    if (!types.has("conifer")) throw new Error("no conifer glyphs rendered");
    if (!types.has("dead-wood")) throw new Error("no dead-wood glyphs rendered");
    // Each family's glyph image is registered (distinct silhouettes — byte-
    // distinctness is unit-gated in treeGlyphs.test).
    for (const fam of ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"]) {
      if (!hasImage(`tree-${fam}-0`)) throw new Error(`tree-${fam}-0 glyph image not registered`);
    }
    console.log(`     [b] rendered forestTypes: ${Array.from(types).join(", ")}; all 5 family glyphs registered`);
  });

  await gate.try("(c) glyph images SURVIVE a hard setStyle (styleimagemissing provider restores them)", async () => {
    if (!hasImage("tree-conifer-0")) throw new Error("precondition: tree-conifer-0 not registered before restyle");
    // A raw setStyle (what a theme switch / css-change does) drops every runtime
    // image. buildStyle() is the same style the app rebuilds; the persistent
    // styleimagemissing provider (installed once on the map) must re-supply the
    // glyphs on the next render — with no missing-image errors.
    sync("(function(){v.map.setStyle(v.buildStyle(v.campaign));return 'restyled';})()");
    await new Promise((r) => setTimeout(r, 1500));
    // Force a repaint of the symbol layer so styleimagemissing fires.
    sync("(function(){v.refreshGeneratedSource();v.map.fitBounds([[16,8],[36,28]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    if (!hasImage("tree-broadleaf-0")) throw new Error("glyph image NOT restored after setStyle — survival net failed");
    if (renderedCount("generated-forest-tree") < 1) throw new Error("no glyphs rendered after setStyle");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(`missing-image / restyle errors: ${errs}`);
    console.log("     [c] images restored + glyphs rendered after setStyle, no errors");
  });

  await gate.try("(d) shadow symbol layer present, offset (icon-translate), renders under the base", async () => {
    if (!layerExists("generated-forest-tree-shadow")) throw new Error("generated-forest-tree-shadow layer missing");
    const translate = paintProp("generated-forest-tree-shadow", "icon-translate");
    if (!Array.isArray(translate) || (translate[0] === 0 && translate[1] === 0)) {
      throw new Error(`shadow icon-translate not offset: ${JSON.stringify(translate)}`);
    }
    if (renderedCount("generated-forest-tree-shadow") < 1) throw new Error("no shadow glyphs rendered");
    console.log(`     [d] shadow present, icon-translate ${JSON.stringify(translate)}, renders`);
  });

  await gate.try("(e) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[26,18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("(f) PERF: frame-time sampler during a scripted pan over the dense forest", async () => {
    // No CPU-throttle harness in docs/05 (phase4 samples the same way and is
    // explicit it's a CI-machine number, not a Surface Pro verification). The
    // honest claim is "allow-overlap + ignore-placement skip collision detection
    // → the pan didn't stall"; the real p95 goes to PROGRESS.md for Jonah.
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:7.5});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 1200));
    const result = evalJs(`(async () => {
      var v = ${viewExpr()};
      var map = v.map;
      var frames = [];
      var onRender = function(){ frames.push(performance.now()); };
      map.on('render', onRender);
      map.panBy([420, 0], {duration: 1500});
      await new Promise(function(r){ setTimeout(r, 1800); });
      map.off('render', onRender);
      var deltas = [];
      for (var i=1;i<frames.length;i++) deltas.push(frames[i]-frames[i-1]);
      deltas.sort(function(a,b){return a-b;});
      var p95 = deltas.length ? deltas[Math.floor(deltas.length*0.95)] : null;
      return { frameCount: frames.length, p95ms: p95 };
    })()`) as { frameCount: number; p95ms: number | null };
    if (!result.frameCount || result.p95ms === null) throw new Error(`no frames sampled: ${JSON.stringify(result)}`);
    const p95fps = 1000 / result.p95ms;
    console.log(`     [f] p95 frame time ${result.p95ms.toFixed(1)}ms (~${p95fps.toFixed(1)}fps on this CI machine, ${result.frameCount} frames)`);
    if (p95fps < 15) throw new Error(`p95 fps ${p95fps.toFixed(1)} — pan stalled badly, investigate`);
  });

  await gate.try("screenshot: broadleaf wood CLOSE (glyphs read as trees, shadow, varied sizes)", async () => {
    // z≈7 is the fictional detail zoom (fitting the whole ~800 m wood lands at
    // the overview ~z5.5, where glyphs are tiny); here the rim + shadow read and
    // a ~300 m frame catches several clumps whatever the seed's local density.
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:7.0});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-glyphs-broadleaf-close.png`);
  });

  await gate.try("screenshot: broadleaf wood OVERVIEW z≈4.5 (glyphs shrink, no clot)", async () => {
    sync("(function(){v.map.jumpTo({center:[26,18],zoom:4.5});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-glyphs-broadleaf-overview.png`);
  });

  await gate.try("screenshot: variety strip (broadleaf / conifer / swamp / dead-wood glyphs)", async () => {
    await newForest(SWAMP_RING, SWAMP);
    sync("(function(){v.map.fitBounds([[-42,-32],[36,30]],{animate:false,padding:24});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/vo-w2-glyphs-varieties.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v-glyphs (026-C)"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

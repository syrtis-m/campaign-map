#!/usr/bin/env tsx
// Plan 023-B gate — elevation model + the `mountain` polygon kind (plan 023 §3).
//
// Live against dev-vault via the obsidian CLI. A mountain is sketched as a
// POLYGON; a procgen block fills it with cartographic relief derived from the
// point-evaluable elevation field (gradient-damped fBm, masked to the ring):
// one massif fill, downslope hachure ticks (oriented by the field's ANALYTIC
// gradient), and summit peaks — all strictly inside the ring. The headless twin
// (createRegionForTest, kind=mountain — modals hang CLI) runs the FULL commit
// path, so this gate exercises exactly what confirming a mountain sketch does.
//
//   (a) create alpine → massif+hachures+peaks in cache + rendered; containment
//       holds; determinism (regenerate twice → byte-identical region records);
//   (b) vertex edit → the relief adapts (peak set changes) far LESS than a
//       re-roll (identity property; field scale is absolute-world) + contained;
//   (c) rerollRegion → NEW seed, output changes, still contained;
//   (d) sketch-edit undo → restores the previous relief;
//   (e) per-preset composition + containment: mesa (terraced) and rolling-hills
//       (gentle) both emit correctly;
//   (f) §3 HEIGHT SAMPLING: the point-evaluable field (regionElevationReport)
//       returns numeric {h,dx,dy} samples that are byte-identical across a
//       regenerate — heights compared numerically, NEVER rendered bytes (§4.2);
//   (g) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (h) dev:errors clean end-to-end;
//   screenshots → review/: alpine (rugged ridged relief) and rolling-hills
//       (gentle rounded uplands) — two contrasting presets.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__e23b_test__";
// Display units (1 unit = 50 m). Fixtures sit well inside bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
// 20×20 units = 1000 m ⇒ many peaks/hachures at every terrain.
const ALPINE_RING = "[[-40,-30],[-20,-30],[-20,-10],[-40,-10]]";
const EAST_RING = "[[16,-30],[36,-30],[36,-10],[16,-10]]";
const ALPINE = "{ terrain: 'alpine', amplitude: 0.85, roughness: 0.6 }";
const MESA = "{ terrain: 'mesa', amplitude: 0.55, roughness: 0.4 }";
const ROLLING = "{ terrain: 'rolling-hills', amplitude: 0.3, roughness: 0.35 }";

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
/** Runs an async MapView method in-app, parking the result on window.__e23b. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__e23b = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__e23b = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__e23b = { ok: r }; }, function(e){ window.__e23b = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__e23b === undefined ? null : window.__e23b)");
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
/** Peak-position buckets (gen-space meters, 45 m lattice) for one region — the
 * locality backbone. Peaks are local maxima of the elevation field, so their
 * positions are fully field-determined (edit keeps interior; re-roll relocates
 * all). */
function peakBuckets(id: string): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='mountain-peak')return;var c=f.geometry&&f.geometry.coordinates;if(!c)return;s.add(Math.round(c[0]/45)+','+Math.round(c[1]/45));});});return JSON.stringify(Array.from(s));})()`;
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
/** DISTINCT feature-id count for a gid (per-tile clip replicates one artifact
 * across tiles under the SAME id — count ids, not occurrences; the documented
 * per-tile-clip gate-bug pattern). The massif is one polygon → distinct 1. */
function distinctCount(id: string, gid: string): number {
  const ids = sync(`v.regionFeatureIds(${JSON.stringify(id)}, ${JSON.stringify(gid)})`) as string[];
  return new Set(ids).size;
}
/** Numeric elevation samples ({h,dx,dy}) — sync JSON-parses the stringified
 * return, so this is already an array (do not parse again). */
function elevationSamples(id: string): { h: number; dx: number; dy: number }[] {
  return sync(`JSON.stringify(v.regionElevationReport(${JSON.stringify(id)}))`) as {
    h: number;
    dx: number;
    dy: number;
  }[];
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
  console.log("== Plan 023-B gate (elevation model + mountain kind) ==\n");

  await gate.try("unit gates: elevation noise + mountain gen + fuzz-companion region + registry + generated paint + controller", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/fields/elevation.test.ts",
        "src/gen/mountain.test.ts",
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
  await gate.try("(a) alpine → massif+hachures+peaks in cache + rendered, contained + deterministic", async () => {
    id = await newMountain(ALPINE_RING, ALPINE);
    const massif = distinctCount(id, "mountain-massif");
    const hachures = featureCount(id, "mountain-hachure");
    const peaks = featureCount(id, "mountain-peak");
    if (massif !== 1) throw new Error(`expected exactly 1 distinct massif id, got ${massif}`);
    if (hachures < 4) throw new Error(`too few hachure ticks (${hachures})`);
    if (peaks < 1) throw new Error("no peaks rendered");
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
    console.log(`     [a] massif ${massif}, hachures ${hachures}, peaks ${peaks}; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (identity) + stays contained", async () => {
    const base = peakBuckets(id);
    if (base.length < 3) throw new Error(`too few peaks (${base.length}) to measure locality`);
    // Move a corner (open-index 1 = [-20,-30]) outward — the relief field is
    // absolute-world, so only rim peaks change; interior peaks stay put.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-14, -30]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, peakBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset the corner, snapshot, then re-roll → the whole field regenerates.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-20, -30]); }`);
    const pre = peakBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, peakBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
    if (!(editOverlap > 70)) throw new Error(`edit overlap unexpectedly low (${editOverlap.toFixed(1)}%)`);
  });

  await gate.try("(c) re-roll → new seed, output changes, still contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${ALPINE}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = peakBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, peakBuckets(id));
    console.log(`     [c] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 85) throw new Error("re-roll did not visibly change the relief");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
  });

  await gate.try("(d) sketch-edit undo restores the previous relief", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${ALPINE}); }`);
    const pre = peakBuckets(id);
    // Move the corner INWARD so peaks are REMOVED (an outward move only adds).
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 1, [-28, -20]); }`);
    const edited = peakBuckets(id);
    if (overlapPct(pre, edited) > 98) throw new Error("edit didn't change the relief — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, peakBuckets(id));
    console.log(`     [d] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit relief (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(e) per-preset composition: mesa (terraced) + rolling-hills (gentle), both contained", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${MESA}); }`);
    if (distinctCount(id, "mountain-massif") !== 1) throw new Error("mesa lost its massif");
    if (featureCount(id, "mountain-hachure") < 1) throw new Error("mesa emitted no hachures");
    if (containment(id).outside > 0) throw new Error("mesa spilled outside its ring");
    const rollingId = await newMountain(EAST_RING, ROLLING);
    // Rolling-hills legitimately yields few/no distinct summits (gentle relief,
    // high peak threshold) — assert on hachures (always dense), not peaks, so a
    // seed with zero peaks isn't a false failure.
    if (featureCount(rollingId, "mountain-hachure") < 1) throw new Error("rolling-hills emitted no hachures");
    if (containment(rollingId).outside > 0) throw new Error("rolling-hills spilled outside its ring");
    console.log(`     [e] mesa hachures ${featureCount(id, "mountain-hachure")}; rolling hachures ${featureCount(rollingId, "mountain-hachure")}`);
  });

  await gate.try("(f) §3 height sampling: elevationWithGrad numeric samples byte-identical across regen", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${ALPINE}); }`);
    const samples = elevationSamples(id);
    if (samples.length < 4) throw new Error(`too few elevation samples (${samples.length})`);
    // Real relief: at least one sample has non-zero height AND a non-zero slope
    // (the analytic gradient is live), heights compared numerically not bytes.
    if (!samples.some((s) => s.h > 0)) throw new Error("all elevation samples were flat (h=0)");
    if (!samples.some((s) => Math.abs(s.dx) + Math.abs(s.dy) > 0)) throw new Error("gradient identically zero (analytic derivative dead)");
    const s1 = JSON.stringify(samples);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const s2 = JSON.stringify(elevationSamples(id));
    if (s1 !== s2) throw new Error("elevation field not deterministic across regenerate");
    console.log(`     [f] ${samples.length} height samples, deterministic; peak h≈${Math.max(...samples.map((s) => s.h)).toFixed(0)} m`);
  });

  await gate.try("(g) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-20],zoom:5});v.map.jumpTo({center:[24,-20],zoom:11});v.map.jumpTo({center:[-30,-20],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: alpine (rugged ridged relief)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${ALPINE}); }`);
    if (containment(id).outside > 0) throw new Error("alpine spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-32],[-18,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.10-mountain-alpine.png`);
  });

  await gate.try("screenshot: rolling-hills (gentle rounded uplands)", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${ROLLING}); }`);
    if (containment(id).outside > 0) throw new Error("rolling-hills spilled outside its ring");
    sync("(function(){v.map.fitBounds([[-42,-32],[-18,-8]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.10-mountain-rolling.png`);
  });

  await gate.try("(h) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 023-B"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

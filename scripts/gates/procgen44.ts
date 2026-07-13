#!/usr/bin/env tsx
// Procgen v4.5 gate — line-kind procgen: RIVERS (plan 022 §2/§3.1).
//
// Live against dev-vault via the obsidian CLI. Rivers are sketched as LINES;
// the sketch is the spine, procgen elaborates it into channel + island polygons
// that stay strictly inside the spine corridor. The headless twin
// (createSpineForTest — modals hang CLI) runs the FULL commit path, so this
// gate exercises exactly what finishing a river sketch does interactively.
//
//   (a) create a windy braided river → channel features in cache + rendered,
//       containment holds (nothing spills past the corridor) + determinism
//       (regenerate twice → byte-identical region records);
//   (b) vertex edit → the river adapts (bucket set changes) and stays contained;
//       locality: an edit changes output far LESS than a re-roll (measure both);
//   (c) setRegionParams windiness UP → corridor widens, still fully contained;
//   (d) rerollRegion → NEW seed, output changes;
//   (e) sketch-edit undo → restores the previous river;
//   (f) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: a windy braided river and a dead-straight canal.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p44_test__";
// Display units (1 unit = 50 m). Kinked river well inside bounds [-48,-36,48,36]
// and clear of the migrated Vespergate district (~[-4.8, 6]).
const WINDY = "[[10,-30],[16,-24],[10,-16],[16,-8]]";
const CANAL = "[[32,-30],[32,-6]]"; // dead straight, east of the windy river
const LAZY_PARAMS = "{ windiness: 0.85, braiding: 0.6, width: 26, widthGrowth: 0.7, braidBias: 0.2 }";
const CANAL_PARAMS = "{ windiness: 0, braiding: 0, width: 14, widthGrowth: 0, braidBias: 0 }";

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
/** Runs an async MapView method in-app, parking the result on window.__p44. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p44 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p44 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p44 = { ok: r }; }, function(e){ window.__p44 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p44 === undefined ? null : window.__p44)");
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
/** River-channel coordinate buckets (gen-space meters, fine grid so a meander
 * PHASE change actually moves buckets — the adapt/re-roll stability measure. */
function riverBuckets(id: string, grid = 6): string[] {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var s=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='river-channel')return;var g=f.geometry;if(!g||!g.coordinates)return;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){s.add(Math.round(c[0]/${grid})+','+Math.round(c[1]/${grid}));return;}c.forEach(scan);};scan(g.coordinates);});});return JSON.stringify(Array.from(s));})()`;
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
function channelCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'river-channel').length`) as number;
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
async function newRiver(line: string, params: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createSpineForTest(${line}, 'river', 'river', ${params}, '${TEST_NAME}'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no river features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the corridor at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.5 gate (line-kind procgen: rivers) ==\n");

  await gate.try("unit gates: river gen + spine + registry + generated paint + controller lifecycle", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/river.test.ts",
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
  await gate.try("(a) windy braided river → channel features in cache + rendered, contained + deterministic", async () => {
    id = await newRiver(WINDY, LAZY_PARAMS);
    const n = channelCount(id);
    if (n < 1) throw new Error("no river-channel features rendered");
    const cont = containment(id);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the corridor`);
    // Channel water exists in the persisted cache too.
    const recs = regionCacheRecords(id);
    if (recs.size === 0) throw new Error("no region cache records for the river");
    // Determinism: regenerate twice → byte-identical region records.
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    for (const [k, feats] of r1) {
      if (r2.get(k) !== feats) throw new Error(`record ${k} not byte-identical across regenerate — determinism broke`);
    }
    console.log(`     [a] ${n} river-channel features; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) vertex edit adapts far less than a re-roll (locality) + stays contained", async () => {
    const base = riverBuckets(id);
    // Move the LAST vertex (open-index 3) — moveVertex runs the full commit path.
    const ok = await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 3, [20, -4]); }`);
    if (ok !== true) throw new Error("moveVertex returned false (reverted)");
    const editOverlap = overlapPct(base, riverBuckets(id));
    if (containment(id).outside > 0) throw new Error("coords outside after vertex edit");
    // Reset, then re-roll from the same geometry → every segment re-meanders.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 3, [16, -8]); }`);
    const pre = riverBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const rerollOverlap = overlapPct(pre, riverBuckets(id));
    console.log(`     [b] edit overlap ${editOverlap.toFixed(1)}% | re-roll overlap ${rerollOverlap.toFixed(1)}%`);
    if (!(editOverlap > rerollOverlap + 15)) {
      throw new Error(`edit (${editOverlap.toFixed(1)}%) did not stay more stable than re-roll (${rerollOverlap.toFixed(1)}%)`);
    }
  });

  await gate.try("(c) windiness UP widens the corridor; output stays fully contained", async () => {
    // Re-roll left a random seed; re-create a clean straight-ish river.
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { windiness: 0.1, braiding: 0, width: 14, widthGrowth: 0, braidBias: 0 }); }`);
    if (containment(id).outside > 0) throw new Error("outside before widening");
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { windiness: 0.95, braiding: 0.2, width: 14, widthGrowth: 0, braidBias: 0 }); }`);
    const cont = containment(id);
    if (cont.count < 1) throw new Error("no features after widening");
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the WIDER corridor — containment tracks params`);
    console.log(`     [c] contained against the wider corridor: ${cont.count} coords, 0 outside`);
  });

  await gate.try("(d) re-roll → new seed, output changes", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${LAZY_PARAMS}); }`);
    const seedBefore = fabricFeature(id)?.properties.procgen?.seed;
    const pre = riverBuckets(id);
    await evalAsync(`function(v){ return v.rerollRegion(${JSON.stringify(id)}); }`);
    const seedAfter = fabricFeature(id)?.properties.procgen?.seed;
    const overlap = overlapPct(pre, riverBuckets(id));
    console.log(`     [d] seed ${seedBefore} → ${seedAfter}; re-roll overlap ${overlap.toFixed(1)}%`);
    if (seedBefore === seedAfter) throw new Error("re-roll did not change the persisted seed");
    if (overlap > 85) throw new Error("re-roll did not visibly change the river");
    if (containment(id).outside > 0) throw new Error("coords outside after re-roll");
  });

  await gate.try("(e) sketch-edit undo restores the previous river", async () => {
    const pre = riverBuckets(id);
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(id)}, 3, [22, -2]); }`);
    const edited = riverBuckets(id);
    if (overlapPct(pre, edited) > 97) throw new Error("edit didn't change the river — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    const back = overlapPct(pre, riverBuckets(id));
    console.log(`     [e] restored-vs-pre-edit overlap ${back.toFixed(1)}%`);
    if (back < 98) throw new Error(`undo did not restore the pre-edit river (${back.toFixed(1)}%)`);
    if (containment(id).outside > 0) throw new Error("coords outside after undo");
  });

  await gate.try("(f) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[16,-18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: windy braided river", async () => {
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, ${LAZY_PARAMS}); }`);
    sync("(function(){v.map.fitBounds([[6,-32],[22,-4]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.5-river-windy-braided.png`);
  });

  let canalId = "";
  await gate.try("screenshot: dead-straight canal", async () => {
    canalId = await newRiver(CANAL, CANAL_PARAMS);
    if (containment(canalId).outside > 0) throw new Error("canal spilled outside its corridor");
    sync("(function(){v.map.fitBounds([[26,-32],[38,-4]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.5-river-canal.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.5"));
}

main();

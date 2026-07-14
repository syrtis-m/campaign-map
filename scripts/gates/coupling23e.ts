#!/usr/bin/env tsx
// Box 23-E gate — paddy terraces + river-slope coupling (plan 022 §3.1/§3.5
// deferrals over the plan 023 elevation field).
//
// Live against dev-vault via the obsidian CLI. Cross-KIND coupling: farmland's
// `paddy-terraces` field type and the river's meander both read the elevation
// field the SKETCHED MOUNTAINS define (fields/mountainField.ts — a pure
// function of the durable sketch layer carried on the constraints; never
// another generator's output). Headless twins (createRegionForTest /
// createSpineForTest — modals hang CLI) run the FULL commit path.
//
//   (a) mountain + overlapping paddy farmland → farm-bank contour lines in
//       cache + rendered, contained; regenerate twice → byte-identical;
//   (b) SEAM: the banks span ≥2 tiles (one artifact, per-tile clip);
//   (c) COUPLING: a river crossing the mountain meanders visibly LESS than an
//       identical control river on flat ground (max lateral deviation);
//   (d) ISOLATION: regenerating far (no-overlap) regions — the control river
//       and a patchwork farmland — with mountains present in the constraints
//       is byte-identical (the no-mountain byte-identity rule, live);
//   (e) sketch-edit undo on the paddy region → cache records byte-identical
//       to pre-edit;
//   (f) pan/zoom → generatorRunCount unchanged (explicit-only preserved);
//   (g) dev:errors clean end-to-end;
//   screenshots → review/: paddy terracing (stepped banks over relief) and the
//       coupled river vs the flat control.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__c23e_test__";
// Display units (1 unit = 50 m). Fixtures sit inside bounds [-48,-36,48,36]
// and clear of the migrated Vespergate district (~[-4.8, 6]).
// West: a big alpine mountain; a paddy farmland fully inside it; a river
// crossing it. East (flat): the control river + a patchwork farmland.
const MOUNTAIN_RING = "[[-44,-32],[-16,-32],[-16,-4],[-44,-4]]";
const MOUNTAIN = "{ terrain: 'alpine', amplitude: 0.85, roughness: 0.5 }";
const PADDY_RING = "[[-40,-28],[-26,-28],[-26,-14],[-40,-14]]";
const PADDY = "{ fieldType: 'paddy-terraces', fieldSize: 0.35, hedging: 'none', laneDensity: 0.4, farmsteads: 0.25 }";
const RIVER_COUPLED = "[[-46,-10],[-14,-10]]";
const RIVER_CONTROL = "[[14,-10],[46,-10]]";
const RIVER = "{ windiness: 0.85, braiding: 0, width: 14, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 }";
const RIVER_Y_METERS = -500; // both spines sit at y = -10 units × 50 m
const PATCHWORK_RING = "[[16,-32],[36,-32],[36,-16],[16,-16]]";
const PATCHWORK = "{ fieldType: 'enclosed-patchwork', fieldSize: 0.5, hedging: 'hedgerows', laneDensity: 0.4, farmsteads: 0.45 }";

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
/** Runs an async MapView method in-app, parking the result on window.__c23e. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__c23e = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__c23e = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__c23e = { ok: r }; }, function(e){ window.__c23e = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__c23e === undefined ? null : window.__c23e)");
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
function containment(id: string): { count: number; outside: number } {
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
function bankCount(id: string): number {
  return sync(`v.regionFeatureIds(${JSON.stringify(id)}, 'farm-bank').length`) as number;
}
/** Distinct tiles (render keys) carrying ≥1 farm-bank feature for a region. */
function bankTileCount(id: string): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var t=new Set();v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;var has=feats.some(function(f){return f.properties&&f.properties.generatorId==='farm-bank';});if(has)t.add(k);});return t.size;})()`;
  return evalJs(code) as number;
}
/** Max |y − spineY| (gen-space meters) over a region's river-channel coords —
 * the meander-amplitude measure for a straight horizontal spine. Fixture seeds
 * are timestamp-derived (fresh every run), so the threshold below carries a
 * measured margin: with the rcCap pinned (river.ts, box 23-E) the coupled/
 * control ratio sat in [0.50, 0.77] across 12 seeded headless draws of these
 * exact fixtures — 0.85 is outside the observed range, not a lucky cut. */
function maxLateralDev(id: string, spineYMeters: number): number {
  const code = `(function(){var v=${viewExpr()};var pre='region:'+${JSON.stringify(id)}+':';var best=0;var scan=function(c){if(!Array.isArray(c))return;if(typeof c[0]==='number'&&typeof c[1]==='number'){var d=Math.abs(c[1]-(${spineYMeters}));if(d>best)best=d;return;}for(var i=0;i<c.length;i++)scan(c[i]);};v.loadedTiles.forEach(function(feats,k){if(k.indexOf(pre)!==0)return;feats.forEach(function(f){if(!f.properties||f.properties.generatorId!=='river-channel')return;scan(f.geometry.coordinates);});});return best;})()`;
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
function expectRecordsEqual(a: Map<string, string>, b: Map<string, string>, what: string): void {
  if (a.size === 0) throw new Error(`${what}: no cache records to compare`);
  for (const [k, feats] of a) {
    if (b.get(k) !== feats) throw new Error(`${what}: record ${k} not byte-identical`);
  }
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
async function newRegion(ring: string, algorithmId: string, params: string, kind: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createRegionForTest(${ring}, '${algorithmId}', ${params}, '${TEST_NAME}', '${kind}'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error(`no ${algorithmId} features generated`);
  if (res.outside > 0) throw new Error(`${res.outside} coords outside at creation (${algorithmId})`);
  return res.featureId;
}
async function newRiver(line: string): Promise<string> {
  const res = (await evalAsync(
    `function(v){ return v.createSpineForTest(${line}, 'river', 'river', ${RIVER}, '${TEST_NAME}'); }`
  )) as { featureId: string; count: number; outside: number };
  if (res.count < 1) throw new Error("no river features generated");
  if (res.outside > 0) throw new Error(`${res.outside} coords outside the corridor at creation`);
  return res.featureId;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Box 23-E gate (paddy terraces + river-slope coupling) ==\n");

  await gate.try("unit gates: mountainField + farmland (paddy) + river (coupling) + generated paint", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/fields/mountainField.test.ts",
        "src/gen/farmland.test.ts",
        "src/gen/river.test.ts",
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

  let paddyId = "";
  await gate.try("(a) mountain + overlapping paddy → contour banks, contained, regen byte-identical", async () => {
    await newRegion(MOUNTAIN_RING, "mountain", MOUNTAIN, "mountain");
    paddyId = await newRegion(PADDY_RING, "farmland", PADDY, "farmland");
    const banks = bankCount(paddyId);
    if (banks < 4) throw new Error(`too few terrace banks (${banks})`);
    const cont = containment(paddyId);
    if (cont.outside > 0) throw new Error(`${cont.outside} coords outside the paddy ring`);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(paddyId)}); }`);
    const r1 = regionCacheRecords(paddyId);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(paddyId)}); }`);
    const r2 = regionCacheRecords(paddyId);
    expectRecordsEqual(r1, r2, "paddy regenerate");
    console.log(`     [a] ${banks} terrace banks; ${r1.size} records byte-identical twice`);
  });

  await gate.try("(b) SEAM: paddy banks span multiple tiles (per-tile clip of one artifact)", () => {
    const tiles = bankTileCount(paddyId);
    if (tiles < 2) throw new Error(`banks confined to ${tiles} tile(s) — expected them to cross tile edges`);
    console.log(`     [b] banks present in ${tiles} distinct tiles`);
  });

  let controlId = "";
  await gate.try("(c) COUPLING: river across the mountain meanders less than the flat control", async () => {
    const coupledId = await newRiver(RIVER_COUPLED);
    controlId = await newRiver(RIVER_CONTROL);
    const devCoupled = maxLateralDev(coupledId, RIVER_Y_METERS);
    const devControl = maxLateralDev(controlId, RIVER_Y_METERS);
    console.log(`     [c] max lateral deviation: coupled ${devCoupled.toFixed(1)} m vs control ${devControl.toFixed(1)} m`);
    if (!(devControl > 0)) throw new Error("control river has no meander — fixture broken");
    if (!(devCoupled < devControl * 0.85)) {
      throw new Error(`coupled river not visibly straighter (${devCoupled.toFixed(1)} vs ${devControl.toFixed(1)})`);
    }
  });

  await gate.try("(d) ISOLATION: regenerating far no-overlap regions is byte-identical (mountains present)", async () => {
    const patchId = await newRegion(PATCHWORK_RING, "farmland", PATCHWORK, "farmland");
    const riverPre = regionCacheRecords(controlId);
    const patchPre = regionCacheRecords(patchId);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(controlId)}); }`);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(patchId)}); }`);
    expectRecordsEqual(riverPre, regionCacheRecords(controlId), "no-overlap river");
    expectRecordsEqual(patchPre, regionCacheRecords(patchId), "no-overlap patchwork");
    console.log(`     [d] ${riverPre.size + patchPre.size} far-region records byte-stable under regen`);
  });

  await gate.try("(e) sketch-edit undo restores the paddy byte-identically", async () => {
    const pre = regionCacheRecords(paddyId);
    // Move a corner INWARD so terrace banks near the rim are re-clipped.
    await evalAsync(`function(v){ return v.moveVertex(${JSON.stringify(paddyId)}, 1, [-30, -24]); }`);
    const edited = regionCacheRecords(paddyId);
    let changed = false;
    for (const [k, feats] of pre) if (edited.get(k) !== feats) changed = true;
    if (!changed) throw new Error("edit didn't change the paddy — can't test undo");
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    expectRecordsEqual(pre, regionCacheRecords(paddyId), "undo");
    if (containment(paddyId).outside > 0) throw new Error("coords outside after undo");
    console.log(`     [e] ${pre.size} records byte-identical after edit → undo`);
  });

  await gate.try("(f) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-20],zoom:5});v.map.jumpTo({center:[24,-10],zoom:11});v.map.jumpTo({center:[-30,-10],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot: paddy terracing (stepped contour banks over the relief)", async () => {
    sync("(function(){v.map.fitBounds([[-42,-30],[-24,-12]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.13-paddy-terraces.png`);
  });

  await gate.try("screenshot: coupled river across the mountain (straightened)", async () => {
    sync("(function(){v.map.fitBounds([[-48,-14],[-12,-4]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.13-river-coupled.png`);
  });

  await gate.try("screenshot: flat control river (full meander, comparison)", async () => {
    sync("(function(){v.map.fitBounds([[12,-14],[48,-4]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.13-river-control.png`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Box 23-E"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

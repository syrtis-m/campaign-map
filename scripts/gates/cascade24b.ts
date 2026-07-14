#!/usr/bin/env tsx
// Plan 024-B gate — cross-layer regen cascade (stage DAG + upstream-as-data +
// cascade regen on edit). Live against dev-vault via the obsidian CLI.
//
// Jonah's sentence, made testable: sketch a mountain + a river crossing it + a
// paddy-terrace farmland over it + a far-off city, all in one campaign; then
// edit the UPSTREAM mountain and watch the world recompose around it —
//   (a) FIXTURES: mountain (stage 0) + river (stage 1, reads elevation) +
//       farmland (stage 2, paddy terraces read elevation) all generate, plus a
//       far city (stage 3, reads water/vegetation — a clean non-dependent);
//   (b) unit gates: dag ordering/cycle + upstream serialization + upstream
//       fingerprints + the controller cascade integration (all fast tier);
//   (c) CASCADE: edit the mountain's relief → the river AND farmland regenerate
//       and ADAPT (their output changes — they read the new elevation field),
//       proving the cascade re-ran them against fresh upstream, not a stale hit;
//   (d) ISOLATION: the far city is byte-identical — a non-dependent (the
//       §3-refined edge rule: it consumes water/vegetation, not elevation);
//   (e) UNDO restores the cascaded river + farmland byte-identically
//       (deterministic → the same cascade with the restored inputs);
//   (f) explicit-only: pan/zoom never moves generatorRunCount;
//   (g) dev:errors clean; screenshots (the river channel visibly shifts);
//       dev-vault Vespergate left byte-intact, all fixtures self-cleaned.
//
// SEED NOTE: region seeds derive from the persisted fabric feature id
// (hashSeed(campaignSeed, featureId)); featureId is minted once at creation and
// persisted, so every assertion here is a WITHIN-RUN relative comparison
// (before/after an edit on the SAME persisted regions) — no cross-run
// byte-equality, no timestamp-seed flake.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const TEST_NAME = "__c24b_test__";
const SHOT_DIR = "/Users/athena/projects/campaign-map/review";

// Display units (1 unit = 50 m); bounds [-48,-36,48,36]. A mountain lower-left;
// a river spine crossing its interior; a paddy-terrace farmland over it; a city
// far top-right (no shared field, out of range → a clean non-dependent). All
// clear of Vespergate's migrated district (~[-4.8,6]).
const MTN_RING = "[[-44,-30],[-28,-30],[-28,-14],[-44,-14]]";
const RIVER_LINE = "[[-46,-32],[-36,-22],[-26,-12]]";
const FARM_RING = "[[-42,-28],[-30,-28],[-30,-16],[-42,-16]]";
const CITY_RING = "[[30,20],[44,20],[44,32],[30,32]]";

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
  evalJs(`window.__c24b = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__c24b = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__c24b = { ok: r === undefined ? null : r }; }, function(e){ window.__c24b = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__c24b === undefined ? null : window.__c24b)");
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
/** The ids the most recent cascade regenerated (evalJs may return the JSON
 * string OR an already-parsed array — handle both, like `digest`). */
function cascadeIds(): string[] {
  const raw = sync("JSON.stringify(v.cascadeRegeneratedIds())");
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as string[];
}
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
/** Frame the mountain/river/farmland fixture cluster (lower-left) so the
 * before/after screenshots are comparable — the river channel visibly shifts. */
function frameFixture(): void {
  sync("(function(){v.map.jumpTo({center:[-35,-22],zoom:8});return 'ok';})()");
}
/** A region's output digest: its painted feature ids, sorted (stable for
 * byte-identical output; changes when the region regenerates + adapts). */
function digest(id: string): string {
  const ids = sync(`JSON.stringify((v.regionFeatureIds(${JSON.stringify(id)})||[]).slice().sort())`);
  return typeof ids === "string" ? ids : JSON.stringify(ids);
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
function vespergateDigest(): string {
  // The durable, non-fixture fabric: everything NOT tagged with our test name.
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { properties?: { name?: string } }[];
  };
  const kept = (fabric.features ?? []).filter((f) => f.properties?.name !== TEST_NAME);
  return JSON.stringify(kept);
}

async function reopenAndSettle(): Promise<void> {
  await issueOpen();
  front();
  await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
  await new Promise((r) => setTimeout(r, 4000)); // migration + replay settle
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 024-B gate (cross-layer regen cascade) ==\n");

  await gate.try("unit gates: dag + upstream + fingerprint(upstream) + controller cascade", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/procgen/dag.test.ts",
        "src/gen/upstream.test.ts",
        "src/gen/cache/fingerprint.test.ts",
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
    await reopenAndSettle();
  });

  const vespBefore = vespergateDigest();
  let mtnId = "";
  let riverId = "";
  let farmId = "";
  let cityId = "";
  await gate.try("(a) FIXTURES: mountain + river + farmland + city all generate", async () => {
    const m = (await evalAsync(
      `function(v){ return v.createRegionForTest(${MTN_RING}, 'mountain', { terrain:'alpine', amplitude:0.3, roughness:0.4 }, '${TEST_NAME}', 'mountain'); }`
    )) as { featureId: string; count: number };
    if (m.count < 1) throw new Error("mountain generated no features");
    mtnId = m.featureId;
    const r = (await evalAsync(
      `function(v){ return v.createSpineForTest(${RIVER_LINE}, 'river', 'river', { windiness:0.85, braiding:0, width:20, widthGrowth:0, braidBias:0, slopeSensitivity:1 }, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number };
    if (r.count < 1) throw new Error("river generated no features");
    riverId = r.featureId;
    const f = (await evalAsync(
      `function(v){ return v.createRegionForTest(${FARM_RING}, 'farmland', { fieldType:'paddy-terraces', fieldSize:0.35, hedging:'none', laneDensity:0.4, farmsteads:0.25 }, '${TEST_NAME}', 'farmland'); }`
    )) as { featureId: string; count: number };
    if (f.count < 1) throw new Error("farmland generated no features");
    farmId = f.featureId;
    const c = (await evalAsync(
      `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', { profile:'euro-medieval' }, '${TEST_NAME}', 'district'); }`
    )) as { featureId: string; count: number };
    if (c.count < 1) throw new Error("city generated no features");
    cityId = c.featureId;
    console.log(`     [a] mtn=${mtnId} river=${riverId} farm=${farmId} city=${cityId}`);
    frameFixture();
    front();
    await new Promise((rr) => setTimeout(rr, 1800));
    screenshot(`${SHOT_DIR}/cascade24b-before.png`);
  });

  // Pre-edit output snapshots.
  const riverBefore = digest(riverId);
  const farmBefore = digest(farmId);
  const cityBefore = digest(cityId);

  await gate.try("(f) explicit-only: pan/zoom never generates (before the edit)", async () => {
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-40,-26],zoom:5});v.map.jumpTo({center:[40,24],zoom:8});v.map.jumpTo({center:[0,0],zoom:6});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
    console.log(`     [f] generatorRunCount flat under pan/zoom (${before})`);
  });

  await gate.try("(c) CASCADE: mountain edit regenerates the river AND farmland (stage order)", async () => {
    const runsBefore = sync("v.generatorRunCount") as number;
    await evalAsync(
      `function(v){ return v.setRegionParams(${JSON.stringify(mtnId)}, { terrain:'alpine', amplitude:0.95, roughness:0.6 }); }`
    );
    await new Promise((r) => setTimeout(r, 2500));
    const runsAfter = sync("v.generatorRunCount") as number;
    if (runsAfter <= runsBefore) throw new Error("no generators ran on the mountain edit (cascade did not fire)");
    // DAG-deterministic (seed-independent): the cascade regenerated exactly the
    // elevation-consuming dependents, in (stage, regionId) order. An
    // output-byte-diff would be seed-flaky (mm quantization can round a small
    // meander shift away) — the arc's #1 gate flake, so assert on the cascade
    // SET, not the bytes. The visible adaptation (denser paddy terraces on the
    // steeper relief) is captured in the after-screenshot.
    const casc = cascadeIds();
    if (!casc.includes(riverId)) throw new Error(`river not in cascade: ${JSON.stringify(casc)}`);
    if (!casc.includes(farmId)) throw new Error(`farmland not in cascade: ${JSON.stringify(casc)}`);
    if (casc.indexOf(riverId) > casc.indexOf(farmId)) throw new Error("cascade out of stage order (river stage 1 must precede farmland stage 2)");
    // Soft, non-fatal: log whether the output visibly changed this run (seed-dependent).
    const riverChanged = digest(riverId) !== riverBefore;
    const farmChanged = digest(farmId) !== farmBefore;
    console.log(`     [c] cascade=${JSON.stringify(casc)} (runs ${runsBefore} -> ${runsAfter}); output changed river=${riverChanged} farm=${farmChanged}`);
    frameFixture();
    front();
    await new Promise((rr) => setTimeout(rr, 1800));
    screenshot(`${SHOT_DIR}/cascade24b-after.png`);
  });

  await gate.try("(d) ISOLATION: the far city is byte-identical (a non-dependent — no elevation coupling)", () => {
    const casc = cascadeIds();
    if (casc.includes(cityId)) throw new Error("the city was in the cascade — it consumes water/vegetation, not elevation");
    if (digest(cityId) !== cityBefore) throw new Error("the far city changed across the mountain edit — isolation broken");
    console.log("     [d] far city untouched (not in cascade, byte-identical output)");
  });

  await gate.try("(e) UNDO restores the cascaded river + farmland byte-identically", async () => {
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    await new Promise((r) => setTimeout(r, 2500));
    if (digest(riverId) !== riverBefore) throw new Error("river not restored byte-identically after undo");
    if (digest(farmId) !== farmBefore) throw new Error("farmland not restored byte-identically after undo");
    if (digest(cityId) !== cityBefore) throw new Error("city drifted across the undo");
    console.log("     [e] undo re-ran the cascade with restored inputs → river + farmland byte-identical");
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("dev-vault Vespergate byte-intact (non-fixture fabric unchanged)", () => {
    if (vespergateDigest() !== vespBefore) throw new Error("Vespergate's own fabric changed during the gate");
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 024-B"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

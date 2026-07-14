#!/usr/bin/env tsx
// Plan 024-C gate — the cross-layer cascade's FIRST byte-changing consumer: a
// city that reads the GENERATED upstream river CHANNEL (`upstream.water`). This
// is Jonah's sentence made live: increase a river's WINDINESS, it regenerates,
// and the CITY around it regenerates and tracks the NEW channel.
//
//   (a) FIXTURES: a multi-stage world in one campaign — mountain (stage 0) +
//       river (stage 1, crossing the district) + forest (stage 2) + city
//       (stage 3, its district straddling the river) all generate;
//   (b) WINDINESS: bump the river's windiness → the CITY is in the cascade
//       (it consumes water), the river channel changes, AND the city OUTPUT
//       changes (proving consumption is wired — a city that ignored the
//       channel would be byte-identical); before/after screenshots show the
//       bridges/quays tracking the meandered channel;
//   (c) UNDO restores the river + city byte-identically (deterministic → the
//       same cascade with the restored inputs);
//   (d) CASCADE-ORDER determinism: shuffle the Fabric.geojson feature order on
//       disk, reopen — every region's output is byte-identical (order comes
//       from (stage, regionId), never file order);
//   (e) rm `.mapcache/` MULTI-STAGE replay: delete the cache, reopen — the
//       whole five-region world regenerates byte-identically (the release-
//       blocker determinism property, now ACROSS the cascade);
//   (f) explicit-only: pan/zoom never moves generatorRunCount;
//   (g) dev:errors clean; dev-vault Vespergate left byte-intact; fixtures
//       self-cleaned.
//
// SEED NOTE: region seeds derive from the persisted fabric feature id
// (hashSeed(campaignSeed, featureId)), minted once at creation and persisted, so
// every assertion is a WITHIN-RUN relative comparison (before/after an edit, or
// across a reopen of the SAME persisted regions) — no cross-run byte-equality,
// no timestamp-seed flake.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const TEST_NAME = "__c24c_test__";
const SHOT_DIR = "/Users/athena/projects/campaign-map/review";

// Display units (1 unit = 50 m); bounds [-48,-36,48,36]. A district straddling a
// river spine (lower-left, clear of Vespergate's migrated district ~[-4.8,6]);
// a mountain below (stage 0), a forest beside it (stage 2). The river crosses
// the district interior so the city is a genuine water-consuming DEPENDENT.
const CITY_RING = "[[-40,-26],[-20,-26],[-20,-10],[-40,-10]]";
const RIVER_LINE = "[[-47,-24],[-34,-18],[-21,-12]]";
const MTN_RING = "[[-46,-35],[-30,-35],[-30,-24],[-46,-24]]";
const FOREST_RING = "[[-17,-27],[-4,-27],[-4,-15],[-17,-15]]";
const RIVER_STRAIGHT = "{ windiness:0, braiding:0, width:20, widthGrowth:0, braidBias:0, slopeSensitivity:0 }";
const RIVER_WINDY = "{ windiness:0.95, braiding:0, width:20, widthGrowth:0, braidBias:0, slopeSensitivity:0 }";

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
  evalJs(`window.__c24c = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__c24c = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__c24c = { ok: r === undefined ? null : r }; }, function(e){ window.__c24c = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__c24c === undefined ? null : window.__c24c)");
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
/** Frame the district+river cluster so the before/after screenshots are
 * comparable — bridges/quays visibly track the meandered channel. */
function frameFixture(): void {
  sync("(function(){v.map.jumpTo({center:[-30,-18],zoom:9});return 'ok';})()");
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
/** Reverse the order of ONLY the test fixtures inside Fabric.geojson (leaving
 * Vespergate's own features in place) — the cascade-order determinism probe:
 * generation order is (stage, regionId), never file order. */
function shuffleTestFabric(): void {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { properties?: { name?: string } }[];
  };
  const mine = fabric.features.filter((f) => f.properties?.name === TEST_NAME).reverse();
  let mi = 0;
  fabric.features = fabric.features.map((f) => (f.properties?.name === TEST_NAME ? mine[mi++] : f));
  writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
}
function vespergateDigest(): string {
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
  await new Promise((r) => setTimeout(r, 4500)); // migration + multi-stage replay settle
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 024-C gate (city consumes the generated river channel) ==\n");

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
  let forestId = "";
  let cityId = "";
  await gate.try("(a) FIXTURES: mountain + river + forest + city (district straddles the river) all generate", async () => {
    const m = (await evalAsync(
      `function(v){ return v.createRegionForTest(${MTN_RING}, 'mountain', { terrain:'alpine', amplitude:0.6, roughness:0.5 }, '${TEST_NAME}', 'mountain'); }`
    )) as { featureId: string; count: number };
    if (m.count < 1) throw new Error("mountain generated no features");
    mtnId = m.featureId;
    const r = (await evalAsync(
      `function(v){ return v.createSpineForTest(${RIVER_LINE}, 'river', 'river', ${RIVER_STRAIGHT}, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number };
    if (r.count < 1) throw new Error("river generated no features");
    riverId = r.featureId;
    const fo = (await evalAsync(
      `function(v){ return v.createRegionForTest(${FOREST_RING}, 'forest', { variety:'broadleaf', density:0.7, clearings:0.12, edgeRaggedness:0.45 }, '${TEST_NAME}', 'forest'); }`
    )) as { featureId: string; count: number };
    if (fo.count < 1) throw new Error("forest generated no features");
    forestId = fo.featureId;
    const c = (await evalAsync(
      `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', { profile:'euro-medieval' }, '${TEST_NAME}', 'district'); }`
    )) as { featureId: string; count: number };
    if (c.count < 1) throw new Error("city generated no features");
    cityId = c.featureId;
    console.log(`     [a] mtn=${mtnId} river=${riverId} forest=${forestId} city=${cityId}`);
    frameFixture();
    front();
    await new Promise((rr) => setTimeout(rr, 1800));
    screenshot(`${SHOT_DIR}/cascade24c-before.png`);
  });

  // Pre-edit output snapshots (windiness 0 — the channel hugs the straight spine).
  const mtnBefore = digest(mtnId);
  const riverBefore = digest(riverId);
  const forestBefore = digest(forestId);
  const cityBefore = digest(cityId);

  await gate.try("(f) explicit-only: pan/zoom never generates (before the edit)", async () => {
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-18],zoom:5});v.map.jumpTo({center:[20,20],zoom:8});v.map.jumpTo({center:[0,0],zoom:6});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
    console.log(`     [f] generatorRunCount flat under pan/zoom (${before})`);
  });

  await gate.try("(b) WINDINESS: river windiness bump cascades to the CITY, and the city OUTPUT tracks the new channel", async () => {
    const runsBefore = sync("v.generatorRunCount") as number;
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(riverId)}, ${RIVER_WINDY}); }`);
    await new Promise((r) => setTimeout(r, 3000));
    const runsAfter = sync("v.generatorRunCount") as number;
    if (runsAfter <= runsBefore) throw new Error("no generators ran on the river edit (cascade did not fire)");
    const casc = cascadeIds();
    // The city consumes water → it is a river dependent, in the cascade.
    if (!casc.includes(cityId)) throw new Error(`city not in cascade (it must consume the channel): ${JSON.stringify(casc)}`);
    // The river channel adapted (windiness 0 → 0.95 is a large, quantization-
    // proof meander shift).
    if (digest(riverId) === riverBefore) throw new Error("river channel did not change on the windiness bump");
    // THE consumption proof: the city output CHANGED. A city that ignored the
    // channel would be byte-identical here — this is what proves 24-C wired it.
    if (digest(cityId) === cityBefore) throw new Error("city output unchanged — it did NOT consume the new channel (consumption not wired)");
    console.log(`     [b] cascade=${JSON.stringify(casc)}; river + city both adapted to the windier channel`);
    frameFixture();
    front();
    await new Promise((rr) => setTimeout(rr, 1800));
    screenshot(`${SHOT_DIR}/cascade24c-after.png`);
  });

  await gate.try("(c) UNDO restores the river + city byte-identically", async () => {
    await evalAsync(`function(v){ return v.undoLastEdit(); }`);
    await new Promise((r) => setTimeout(r, 3000));
    if (digest(riverId) !== riverBefore) throw new Error("river not restored byte-identically after undo");
    if (digest(cityId) !== cityBefore) throw new Error("city not restored byte-identically after undo");
    console.log("     [c] undo re-ran the cascade with restored inputs → river + city byte-identical");
  });

  await gate.try("(d) CASCADE-ORDER determinism: shuffled Fabric.geojson order → identical bytes", async () => {
    resetLeaves();
    await new Promise((r) => setTimeout(r, 800));
    shuffleTestFabric();
    await reopenAndSettle();
    if (digest(mtnId) !== mtnBefore) throw new Error("mountain drifted under shuffled file order");
    if (digest(riverId) !== riverBefore) throw new Error("river drifted under shuffled file order");
    if (digest(forestId) !== forestBefore) throw new Error("forest drifted under shuffled file order");
    if (digest(cityId) !== cityBefore) throw new Error("city drifted under shuffled file order");
    console.log("     [d] all four regions byte-identical after a Fabric.geojson reorder (order is (stage, regionId))");
  });

  await gate.try("(e) rm .mapcache/ MULTI-STAGE replay → whole world byte-identical", async () => {
    resetLeaves();
    await new Promise((r) => setTimeout(r, 800));
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    await reopenAndSettle();
    if (digest(mtnId) !== mtnBefore) throw new Error("mountain not byte-identical after cache delete");
    if (digest(riverId) !== riverBefore) throw new Error("river not byte-identical after cache delete");
    if (digest(forestId) !== forestBefore) throw new Error("forest not byte-identical after cache delete");
    if (digest(cityId) !== cityBefore) throw new Error("city not byte-identical after cache delete (cascade replay broke determinism)");
    console.log("     [e] deleting .mapcache regenerated mountain+river+forest+city byte-identically");
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

  process.exit(gate.summarize("Plan 024-C"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env tsx
// Procgen v4.1 gate — sketch-driven procgen regions (plan 020 §10, v4.1).
//
// Live against dev-vault via the obsidian CLI:
//   (a) headless district sketch + procgen-set → city features appear, all
//       inside the polygon (createRegionForTest reports outside===0);
//   (b) migration ran: Generated.json domains empty, a migrated district
//       feature with a city procgen block exists, the city renders;
//   (c) determinism: rm .mapcache → reopen → byte-identical region records
//       (network + per-tile clips);
//   (d) explicit-only: pan/zoom never bumps generatorRunCount;
//   (e) "Remove generated city here" strips the block (shape stays, paint
//       dies), and the city stays gone after reopen;
//   (f) dev:errors clean.
//
// Screenshot lands in review/ (town visibly shaped inside the sketched box).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const MANIFEST_ABS = `${FOLDER}/Generated.json`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
// Display units (1 unit = 50 m). A square well inside the campaign bounds
// [-48,-36,48,36] and clear of the migrated Vespergate district (~[-4.8, 6]).
const TEST_RING = "[[10,-26],[26,-26],[26,-10],[10,-10]]";
const TEST_NAME = "__p40_test__";
const TEST_POINT: [number, number] = [18, -18];

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
    if (out.includes("Executed")) break;
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

/** Runs an async MapView method in-app, parking the result on window.__p40. */
async function evalAsync(body: string, timeoutMs = 120000): Promise<unknown> {
  evalJs(`window.__p40 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p40 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p40 = { ok: r }; }, function(e){ window.__p40 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p40 === undefined ? null : window.__p40)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}

/** Region cache records (network + per-tile clips), normalized to
 * key→features so `generatedAt` noise can't fake a diff. */
function regionCacheRecords(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CACHE_ABS)) return out;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; features: unknown };
    if (rec.key.startsWith("region:")) out.set(rec.key, JSON.stringify(rec.features));
  }
  return out;
}

/** Strip any leftover gate-test district from Fabric.geojson (keeps reruns
 * clean; the migrated district — which has no test name — is preserved). Runs
 * with the app closed, so no in-memory/disk race. */
function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length !== before) writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.1 gate (sketch-driven procgen regions) ==\n");

  await gate.try("unit gates: generationService + region + citynet + fabric", () => {
    execFileSync(
      "npx",
      ["vitest", "run", "src/map/generation", "src/gen/region.test.ts", "src/gen/citynet", "src/model/fabric.test.ts"],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
  });

  await gate.try("plugin loads (reloaded — picks up the current build), no errors", () => {
    stripTestFabric();
    // Start from a clean cache so stale records from a prior run can't shadow
    // the byte-diff (regenerates deterministically on open — harmless).
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration runs on load)", async () => {
    await issueOpen();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3000)); // style + migration + replay settle
  });

  await gate.try("(b) migration: manifest.domains empty, migrated district has a city procgen block, city renders", async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.domains ?? []).length !== 0) throw new Error(`domains not empty: ${JSON.stringify(manifest.domains)}`);
    if ((manifest.entries ?? []).some((e: { domainId?: string }) => e.domainId)) {
      throw new Error("a city-tier domainId entry survived migration");
    }
    const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
      features: { properties: { kind: string; name?: string; procgen?: { algorithm: string } } }[];
    };
    const migrated = fabric.features.filter(
      (f) => f.properties.kind === "district" && f.properties.procgen?.algorithm === "city" && f.properties.name !== TEST_NAME
    );
    if (migrated.length < 1) throw new Error("no migrated district feature with a city procgen block");
    try {
      execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
    } catch {
      /* best-effort */
    }
    await waitFor(() => {
      const n = evalJs(
        `(function(){ var v=${viewExpr()}; if(!v||!v.map) return 0; return v.map.queryRenderedFeatures(undefined, {layers:['generated-street']}).length; })()`
      );
      return typeof n === "number" && n > 0;
    }, 20000, "rendered generated-street features (migrated city)");
  });

  let testFeatureId = "";
  await gate.try("(a) headless district sketch + procgen-set → city features, all inside the polygon", async () => {
    const result = (await evalAsync(
      `function(v){ return v.createRegionForTest(${TEST_RING}, 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number; outside: number };
    testFeatureId = result.featureId;
    if (result.count < 1) throw new Error("no city features generated in the sketched district");
    if (result.outside > 0) throw new Error(`${result.outside} generated coordinate(s) fell outside the polygon`);
  });

  await gate.try("(c) determinism: delete .mapcache → replay → byte-identical region records", async () => {
    const before = regionCacheRecords();
    if (before.size === 0) throw new Error("no region records before delete");
    rmSync(CACHE_ABS);
    if (existsSync(CACHE_ABS)) throw new Error("cache file survived delete");
    await issueOpen(); // fresh view → replay regenerates every region from the sketch layer
    await waitFor(() => {
      const now = regionCacheRecords();
      return [...before.keys()].every((k) => now.has(k));
    }, 120000, "replay to rewrite all region records");
    const after = regionCacheRecords();
    for (const [key, features] of before) {
      if (after.get(key) !== features) {
        throw new Error(`record ${key} differs after cache delete + replay — determinism broke (release blocker)`);
      }
    }
  });

  await gate.try("(d) explicit-only: pan/zoom never generates", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const before = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[20,10], zoom:5}); v.map.jumpTo({center:[-20,-10], zoom:11}); v.map.jumpTo({center:[${TEST_POINT[0]},${TEST_POINT[1]}], zoom:9}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot (town visibly shaped inside the sketched box)", async () => {
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${TEST_POINT[0] - 12},${TEST_POINT[1] - 12}],[${TEST_POINT[0] + 12},${TEST_POINT[1] + 12}]],{animate:false,padding:20}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v4.1-vespergate-sketch-city.png");
  });

  await gate.try("(e) remove-generated-city: shape stays, paint dies, city stays gone after reopen", async () => {
    const removed = await evalAsync(`function(v){ return v.removeGeneratedCityHere([${TEST_POINT[0]}, ${TEST_POINT[1]}]); }`);
    if (typeof removed !== "number" || removed < 1) throw new Error(`removeGeneratedCityHere returned ${removed}`);
    // Shape stays (feature still in Fabric) but its procgen block is gone.
    const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
      features: { id: string; properties: { procgen?: unknown } }[];
    };
    const feat = fabric.features.find((f) => f.id === testFeatureId);
    if (!feat) throw new Error("removed the shape, not just the city");
    if (feat.properties.procgen) throw new Error("procgen block survived removal");
    // Its region cache records are gone.
    const recs = [...regionCacheRecords().keys()].filter((k) => k.startsWith(`region:${testFeatureId}:`));
    if (recs.length !== 0) throw new Error(`${recs.length} region records survived removal`);
    // And it stays gone after reopen (region replay only touches shapes with a block).
    await issueOpen();
    await new Promise((r) => setTimeout(r, 3000));
    const after = [...regionCacheRecords().keys()].filter((k) => k.startsWith(`region:${testFeatureId}:`));
    if (after.length !== 0) throw new Error("removed city resurrected on reopen");
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  process.exit(gate.summarize("Procgen v4.1"));
}

main();

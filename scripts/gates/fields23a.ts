#!/usr/bin/env tsx
// Plan 023-A gate — constraint fields core + BIT-EXACT interiorT/constraint
// retrofit onto src/gen/fields/ (plan 023 §2).
//
// The retrofit MOVED region.ts's distance/containment primitives into
// src/gen/fields/ and imports them back (one-way, acyclic); interiorT /
// distanceToBoundary / pointInRing became thin wrappers. The contract is ZERO
// output change. This gate proves that against the DEPLOYED plugin build and
// the REAL Vespergate city (not just headless fixtures):
//
//   prologue: the committed goldens re-run against the shipped source
//     (fields unit tests + the pre-retrofit city DIGEST golden + region /
//     fabricConstraints / citynet suites) — a byte drift = phase failure.
//   (a) the REAL migrated Vespergate district regenerates BYTE-IDENTICAL twice
//       through the retrofit (live determinism on a Vespergate-scale city);
//   (b) a CONSTRAINED test city (a sketched river crossing it → live
//       blockedByWater/pointInRing) generates, stays inside its ring, and
//       regenerates byte-identical twice;
//   (c) pan/zoom never generates (explicit-only preserved);
//   (d) dev:errors clean end-to-end.
//
// Fixtures are name-tagged + self-cleaning; Vespergate's tracked files stay
// byte-intact (asserted via git). Modals hang CLI, so the headless test-API
// twins (createRegionForTest / createSpineForTest / regenerateRegionById) run
// the FULL commit path — exactly what confirming a sketch does interactively.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const TEST_NAME = "__f23a_test__";
// Display units (1 unit = 50 m). A box well inside campaign bounds
// [-48,-36,48,36] and clear of the migrated district (~[-4.8, 6]).
const CITY_RING = "[[10,-26],[26,-26],[26,-10],[10,-10]]";
// River line crossing the city box horizontally through its middle (y = -18):
// forces the city's streets against live blockedByWater during generation.
const RIVER_LINE = "[[8,-18],[28,-18]]";
const CITY_PARAMS = "{ profile: 'euro-medieval' }";
const RIVER_PARAMS = "{ windiness: 0.3, braiding: 0.2, width: 18, widthGrowth: 0.4, braidBias: 0.2 }";

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
/** Runs an async MapView method in-app, parking the result on window.__f23a. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__f23a = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__f23a = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__f23a = { ok: r }; }, function(e){ window.__f23a = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__f23a === undefined ? null : window.__f23a)");
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
/** Cache records for one region, keyed by cache key → JSON of its features. */
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
function assertByteIdentical(a: Map<string, string>, b: Map<string, string>, what: string): void {
  if (a.size === 0) throw new Error(`${what}: no region cache records to compare`);
  if (a.size !== b.size) throw new Error(`${what}: record count changed ${a.size} → ${b.size}`);
  for (const [k, feats] of a) {
    if (b.get(k) !== feats) throw new Error(`${what}: record ${k} not byte-identical across regenerate — retrofit changed output`);
  }
}
function containment(id: string): { count: number; outside: number } {
  return sync(`JSON.stringify(v.regionContainmentReport(${JSON.stringify(id)}))`) as { count: number; outside: number };
}
function migratedDistrictId(): string {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { id: string; properties: { kind: string; name?: string; procgen?: { algorithm?: string } } }[];
  };
  const m = fabric.features.find(
    (f) => f.properties.kind === "district" && f.properties.procgen?.algorithm === "city" && f.properties.name !== TEST_NAME
  );
  if (!m) throw new Error("no migrated Vespergate city district found");
  return m.id;
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

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 023-A gate (constraint fields core + bit-exact retrofit) ==\n");

  await gate.try("prologue: committed goldens re-run against shipped source (bit-exact contract)", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/fields/fields.test.ts",
        "src/gen/fields/cityGolden.test.ts",
        "src/gen/region.test.ts",
        "src/gen/fabricConstraints.test.ts",
        "src/gen/citynet",
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
    await new Promise((r) => setTimeout(r, 4000));
  });

  await gate.try("(a) REAL migrated district regenerates BYTE-IDENTICAL twice (live retrofit determinism)", async () => {
    const id = migratedDistrictId();
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r1 = regionCacheRecords(id);
    if (r1.size === 0) throw new Error("migrated district produced no region cache records");
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = regionCacheRecords(id);
    assertByteIdentical(r1, r2, "migrated district");
    console.log(`     [a] migrated district ${id}: ${r1.size} region records byte-identical across regenerate`);
  });

  let riverId = "";
  let cityId = "";
  await gate.try("(b) constrained city (river crosses it) → generated, contained, byte-identical twice", async () => {
    // River first so it is in the fabric collection when the city generates
    // (live blockedByWater/pointInRing constraint path).
    const river = (await evalAsync(
      `function(v){ return v.createSpineForTest(${RIVER_LINE}, 'river', 'river', ${RIVER_PARAMS}, '${TEST_NAME}'); }`
    )) as { featureId: string };
    riverId = river.featureId;
    const city = (await evalAsync(
      `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', ${CITY_PARAMS}, '${TEST_NAME}', 'district'); }`
    )) as { featureId: string; count: number; outside: number };
    cityId = city.featureId;
    if (city.count < 1) throw new Error("constrained city generated no features");
    if (city.outside > 0) throw new Error(`${city.outside} city coords outside the ring at creation`);
    const c1 = regionCacheRecords(cityId);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(cityId)}); }`);
    const c2 = regionCacheRecords(cityId);
    assertByteIdentical(c1, c2, "constrained city");
    if (containment(cityId).outside > 0) throw new Error("city coords outside after regenerate");
    console.log(`     [b] constrained city ${cityId}: ${city.count} features, ${c1.size} records byte-identical`);
  });

  await gate.try("(c) pan/zoom never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[18,-18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("(d) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 023-A"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

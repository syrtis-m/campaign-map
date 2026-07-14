#!/usr/bin/env tsx
// Version-adoption gate — the pinned-version consent lifecycle, live in
// Obsidian against dev-vault.
//
//   (a) a fresh region pins the algorithm's current version at creation;
//   (b) simulate a bump (test-only override) → a param edit PROMPTS; decline
//       cancels the edit and keeps the cached bytes byte-identical;
//   (c) proceed adopts: version raised, edit applied, regenerated, logged;
//   (d) cache deleted while pinned-old → the region renders NOTHING + a
//       needs-adoption badge — the generator NEVER runs under an old pin;
//   (e) explicit adopt clears the badge, raises the pin, repaints;
//   (f) creation under a bumped version pins the bumped version;
//   (g) the adopt-all command is registered (its behavior is unit-tested —
//       running it here would adopt Vespergate's own district);
//   (h) dev:errors clean end-to-end; Vespergate's real features byte-intact.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__v29_test__";
// Display units (1 unit = 50 m), inside campaign bounds, clear of the
// migrated Vespergate district (~[-4.8, 6]).
const RING_A = "[[8,-28],[28,-28],[28,-8],[8,-8]]";
const RING_B = "[[-40,-30],[-20,-30],[-20,-10],[-40,-10]]";

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
  evalJs(`window.__v29 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__v29 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__v29 = { ok: r === undefined ? null : r }; }, function(e){ window.__v29 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__v29 === undefined ? null : window.__v29)");
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
/** `evalJs` returns an already-parsed payload — only parse when it's a string. */
function syncList(expr: string): string[] {
  const out = sync(expr);
  return (typeof out === "string" ? JSON.parse(out) : out) as string[];
}
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
/** Region cache records (last-write-wins), key→features bytes. */
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
function fabricBlock(id: string): { version?: number; params?: { profile?: string } } | undefined {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { id: string; properties: { procgen?: { version?: number; params?: { profile?: string } } } }[];
  };
  return fabric.features.find((f) => f.id === id)?.properties.procgen;
}
/** Everything that is NOT a gate fixture — the byte-intact reference. */
function nonTestFabricBytes(): string {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as { features?: { properties?: { name?: string } }[] };
  return JSON.stringify((fabric.features ?? []).filter((f) => f.properties?.name !== TEST_NAME));
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
/** Drop one region's cache records from the JSONL (simulates a fresh machine
 * for that region only — the rest of the cache stays). */
function dropRegionCache(regionId: string): void {
  if (!existsSync(CACHE_ABS)) return;
  const prefix = `region:${regionId}:`;
  const kept = readFileSync(CACHE_ABS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .filter((l) => {
      try {
        return !(JSON.parse(l) as { key: string }).key.startsWith(prefix);
      } catch {
        return true;
      }
    });
  writeFileSync(CACHE_ABS, kept.join("\n") + "\n");
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
  console.log("== Version-adoption gate (pinned-version consent lifecycle) ==\n");

  await gate.try("unit gates: versioning + adoption lifecycle + fingerprint", () => {
    execFileSync(
      "npx",
      ["vitest", "run", "src/gen/procgen/versioning.test.ts", "src/gen/cache/fingerprint.test.ts", "src/controller/MapController.test.ts"],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
  });

  await gate.try("plugin loads (reloaded), no errors", () => {
    stripTestFabric();
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  let vespergateBytes = "";
  await gate.try("vespergate opens (replay settles)", async () => {
    await issueOpen();
    front();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3500));
    vespergateBytes = nonTestFabricBytes();
  });

  let id = "";
  await gate.try("(a) creation pins the current version (v1 today)", async () => {
    id = await newRegion(RING_A);
    const block = fabricBlock(id);
    if (block?.version !== 1) throw new Error(`fresh region pinned v${block?.version}, expected 1`);
  });

  await gate.try("(b) bump → edit prompts; DECLINE cancels the edit, bytes byte-identical", async () => {
    sync(`v.overrideCurrentVersionForTest('city', 2)`);
    const pre = regionCacheRecords(id);
    if (pre.size === 0) throw new Error("no cache records before decline test");
    const runsBefore = sync("v.generatorRunCount") as number;
    sync(`v.queueConfirmResponseForTest(false)`);
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { profile: 'na-grid' }); }`);
    const block = fabricBlock(id);
    if (block?.version !== 1) throw new Error(`decline changed the pin: v${block?.version}`);
    if (block?.params?.profile !== "euro-medieval") throw new Error("decline did not cancel the param edit");
    const post = regionCacheRecords(id);
    if (post.size !== pre.size) throw new Error(`record count moved ${pre.size} → ${post.size} on decline`);
    for (const [k, bytes] of pre) if (post.get(k) !== bytes) throw new Error(`record ${k} changed on decline`);
    const runsAfter = sync("v.generatorRunCount") as number;
    if (runsAfter !== runsBefore) throw new Error(`generator ran on decline: ${runsBefore} → ${runsAfter}`);
    console.log(`     [b] ${pre.size} records byte-identical after declined edit`);
  });

  await gate.try("(c) PROCEED adopts: version 1→2, edit applied, regenerated", async () => {
    sync(`v.queueConfirmResponseForTest(true)`);
    await evalAsync(`function(v){ return v.setRegionParams(${JSON.stringify(id)}, { profile: 'na-grid' }); }`);
    const block = fabricBlock(id);
    if (block?.version !== 2) throw new Error(`adoption did not raise the pin: v${block?.version}`);
    if (block?.params?.profile !== "na-grid") throw new Error("adoption did not apply the edit");
    const n = sync(`v.regionFeatureIds(${JSON.stringify(id)}).length`) as number;
    if (n < 1) throw new Error("no features after adoption");
    console.log(`     [c] adopted to v2, ${n} features painted`);
  });

  let badgeId = "";
  await gate.try("(d) cache deleted while pinned-old → renders NOTHING + needs-adoption badge, generator never runs", async () => {
    // A fresh v1 fixture: reset the override, create, re-bump.
    sync(`v.overrideCurrentVersionForTest('city', null)`);
    badgeId = await newRegion(RING_B);
    sync(`v.overrideCurrentVersionForTest('city', 2)`);
    dropRegionCache(badgeId);
    const runsBefore = sync("v.generatorRunCount") as number;
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(badgeId)}); }`);
    const runsAfter = sync("v.generatorRunCount") as number;
    if (runsAfter !== runsBefore) throw new Error(`generator ran under an old pin: ${runsBefore} → ${runsAfter}`);
    const painted = sync(`v.regionFeatureIds(${JSON.stringify(badgeId)}).length`) as number;
    if (painted !== 0) throw new Error(`pinned-old region painted ${painted} features with no cache`);
    const badges = syncList(`JSON.stringify(v.needsAdoptionIds())`);
    if (!badges.includes(badgeId)) throw new Error(`no needs-adoption badge: ${JSON.stringify(badges)}`);
    console.log(`     [d] renders nothing, badge set, generatorRunCount stable at ${runsAfter}`);
  });

  await gate.try("(e) explicit adopt clears the badge, raises the pin, repaints", async () => {
    const adopted = await evalAsync(`function(v){ return v.adoptRegionForTest(${JSON.stringify(badgeId)}); }`);
    if (adopted !== true) throw new Error("adoptRegionForTest returned false");
    const block = fabricBlock(badgeId);
    if (block?.version !== 2) throw new Error(`adopt did not raise the pin: v${block?.version}`);
    const badges = syncList(`JSON.stringify(v.needsAdoptionIds())`);
    if (badges.length !== 0) throw new Error(`badge not cleared: ${JSON.stringify(badges)}`);
    const painted = sync(`v.regionFeatureIds(${JSON.stringify(badgeId)}).length`) as number;
    if (painted < 1) throw new Error("adopted region did not repaint");
    console.log(`     [e] adopted, badge cleared, ${painted} features painted`);
  });

  await gate.try("(f) creation under a bumped version pins the bumped version", async () => {
    const region = (await evalAsync(
      `function(v){ return v.createRegionForTest([[34,-46],[46,-46],[46,-34],[34,-34]], 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
    )) as { featureId: string };
    const block = fabricBlock(region.featureId);
    if (block?.version !== 2) throw new Error(`fresh region under bump pinned v${block?.version}, expected 2`);
  });

  await gate.try("(g) adopt-all command registered (behavior unit-tested; never run on Vespergate)", () => {
    const found = evalJs(`!!app.commands.findCommand('campaign-map:adopt-all-regions')`);
    if (found !== true) throw new Error("adopt-all-regions command not registered");
  });

  await gate.try("screenshot: needs-adoption panel badge", async () => {
    // Re-pin one fixture old (override still 2; drop to v1 via a fresh fixture
    // is overkill — reuse badge flow on the (f) fixture): create v1 + bump.
    sync(`v.overrideCurrentVersionForTest('city', null)`);
    const sid = await newRegion("[[-44,10],[-30,10],[-30,24],[-44,24]]");
    sync(`v.overrideCurrentVersionForTest('city', 2)`);
    await evalAsync(`function(v){ return v.selectFeature(${JSON.stringify(sid)}); }`);
    sync("(function(){v.map.fitBounds([[-46,8],[-28,26]],{animate:false,padding:60});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2000));
    screenshot(`${REVIEW}/v29-needs-adoption-panel.png`);
  });

  await gate.try("(h) dev:errors clean; override reset", () => {
    sync(`v.overrideCurrentVersionForTest('city', null)`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate real features byte-intact", () => {
    const now = nonTestFabricBytes();
    if (now !== vespergateBytes) throw new Error("non-fixture fabric changed — Vespergate not byte-intact");
  });

  // Self-clean: strip every gate fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Version adoption (plan 029-B)"));
}

main();

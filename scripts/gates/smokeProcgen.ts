#!/usr/bin/env tsx
// Smoke: SKETCH → REGION → GENERATE → REPLAY, live. The one procgen gate the
// headless tiers cannot replace: it proves the full pipeline paints in a real
// renderer, replays from cache with zero generator runs on reopen, never
// generates from pan/zoom, keeps glyph images alive across a hard setStyle,
// and leaves Jonah's Vespergate data byte-intact. Absorbs the retired
// procgen40 (create/paint/containment), phase3's replay half, phase4's
// explicit-only half (+ its two advisory perf probes), and procgen51's live
// glyph-lifecycle half. Everything else procgen lives headless: generator
// suites + shared invariants + metric bands + perceptual goldens.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const TEST_NAME = "__smoke_test__";
// Display units (1 unit = 50 m), inside campaign bounds, clear of the
// migrated Vespergate district (~[-4.8, 6]).
const CITY_RING = "[[8,-28],[28,-28],[28,-8],[8,-8]]";
const FOREST_RING = "[[-40,-30],[-24,-30],[-24,-14],[-40,-14]]";

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
  evalJs(`window.__smoke = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__smoke = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__smoke = { ok: r === undefined ? null : r }; }, function(e){ window.__smoke = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__smoke === undefined ? null : window.__smoke)");
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
/** macOS App Nap suspends timers for occluded windows — front before polling. */
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}
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

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Smoke: sketch → region → generate → replay ==\n");

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

  let cityId = "";
  await gate.try("(a) sketch district → city generates, paints, stays inside the line", async () => {
    const res = (await evalAsync(
      `function(v){ return v.createRegionForTest(${CITY_RING}, 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number; outside: number };
    cityId = res.featureId;
    if (res.count < 100) throw new Error(`only ${res.count} city features`);
    if (res.outside > 0) throw new Error(`${res.outside} coords outside the polygon`);
    // Painted for real: the generated source carries this region's features.
    const painted = sync(`v.regionFeatureIds(${JSON.stringify(cityId)}).length`) as number;
    if (painted < 1) throw new Error("nothing painted for the new region");
    // Cache written: whole-network record + per-tile clips.
    const cache = readFileSync(CACHE_ABS, "utf8");
    if (!cache.includes(`region:${cityId}:network`)) throw new Error("no network cache record");
    console.log(`     [a] ${res.count} features, painted ${painted}`);
  });

  await gate.try("(b) reopen → replays from cache, ZERO generator runs", async () => {
    await issueOpen();
    front();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view (reopen)");
    // Replay settles when the region paints again.
    await waitFor(
      () => (sync(`v.regionFeatureIds(${JSON.stringify(cityId)}).length`) as number) > 0,
      60000,
      "replayed region paint"
    );
    const runs = sync("v.generatorRunCount") as number;
    if (runs !== 0) throw new Error(`replay ran generators: ${runs}`);
  });

  await gate.try("(c) pan/zoom storm generates NOTHING (explicit-only)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[20,10],zoom:5});v.map.jumpTo({center:[-20,-10],zoom:11});v.map.jumpTo({center:[18,-18],zoom:9});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 1500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("(d) forest region → tree glyph images registered", async () => {
    const res = (await evalAsync(
      `function(v){ return v.createRegionForTest(${FOREST_RING}, 'forest', { variety: 'broadleaf', density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 }, '${TEST_NAME}', 'forest'); }`
    )) as { featureId: string; count: number; outside: number };
    if (res.count < 1) throw new Error("no forest features");
    if (res.outside > 0) throw new Error(`${res.outside} forest coords outside`);
    await new Promise((r) => setTimeout(r, 1500)); // images register on first render
    const has = sync(`v.map.hasImage('tree-broadleaf-0')`);
    if (has !== true) throw new Error("tree-broadleaf-0 glyph image not registered");
  });

  await gate.try("(e) fixtures RENDER pixels (queryRenderedFeatures) + screenshot", async () => {
    sync("(function(){v.map.fitBounds([[-44,-34],[32,-4]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    const rendered = sync("v.map.queryRenderedFeatures().length") as number;
    if (!(rendered > 0)) throw new Error("nothing rendered over the fixtures — paint is blank");
    screenshot("/Users/athena/projects/campaign-map/shots/gate-smoke-procgen.png");
    if (!existsSync("shots/gate-smoke-procgen.png")) throw new Error("screenshot missing");
  });

  await gate.try("(f) glyph images survive a hard setStyle (styleimagemissing provider)", async () => {
    sync("(function(){v.map.setStyle(v.buildStyle(v.campaign));return 'restyled';})()");
    await new Promise((r) => setTimeout(r, 2500)); // restyle + missing-image round-trip
    const healthy = sync("v.map.isStyleLoaded() && !!v.map.getLayer('background')");
    if (healthy !== true) throw new Error("style unhealthy after hard setStyle");
    const has = sync(`v.map.hasImage('tree-broadleaf-0')`);
    if (has !== true) throw new Error("glyph image lost across setStyle");
  });

  await gate.try("(g) perf probes (advisory — budget target is a Surface Pro, never fail on the dev machine)", async () => {
    const rescan = evalJs("app.plugins.plugins['campaign-map'].rescanTimeMs");
    console.log(`     [f] rescanTimeMs=${String(rescan)} (advisory)`);
  });

  await gate.try("(h) dev:errors clean end-to-end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate real features byte-intact", () => {
    const now = nonTestFabricBytes();
    if (now !== vespergateBytes) throw new Error("non-fixture fabric changed — Vespergate not byte-intact");
  });

  // Self-clean: strip fixtures with the app closed (no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Smoke procgen"));
}

main();

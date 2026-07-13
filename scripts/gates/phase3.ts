#!/usr/bin/env tsx
// Phase 3 Tier A gate — procedural generation (docs/03 Phase 3, docs/06 §2).
// Pure-function determinism/seam guarantees are exhaustively unit-tested —
// this gate covers the integration surface unit tests can't: live cache
// persistence, the generate/regenerate flow, and screenshots.
//
// Modernized 2026-07-12 for plan 020 (the three-layer model): generation is
// explicit-only via generate-fabric-here (world tier from zoom; city tier is
// sketch-driven — a sketched district IS the request, founded here via
// createRegionForTest), canonization is deleted (fabric never promotes —
// asserted below), and the plan-018 toolbar holds 5 core buttons with generate
// living in the control modal. Every stateful check clears generated state
// first so the gate is idempotent across reruns; the test district is stripped
// from Ashfall's Fabric.geojson at the end so dev-vault stays git-clean.
//
// Note on evalJs: it already JSON.parses whatever the CLI prints after
// "=> ". Returning `JSON.stringify(x)` from eval code round-trips back into
// a parsed object anyway (double-encode, single-decode) — always return
// plain values from eval code and let evalJs do the one parse.
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

// The city tier is sketch-driven (plan 020): the gate founds its test city by
// sketching a district (createRegionForTest) rather than the retired disc
// domainChoice. That district is a real fabric feature persisted to Ashfall's
// Fabric.geojson — strip it (by name) + its region cache records at the end so
// the committed dev-vault baseline stays byte-intact.
const ASHFALL_FABRIC = "dev-vault/Campaigns/Ashfall/Fabric.geojson";
const ASHFALL_CACHE = "dev-vault/Campaigns/Ashfall/.mapcache/generated.jsonl";
const TEST_NAME = "__phase3_test__";
// A district filling most of Ashfall's ±8/±6-unit bounds (50 m/unit) — the
// city-tier analog of the old radius-400 disc at the campaign center.
const TEST_RING = "[[-7.5,-5.5],[7.5,-5.5],[7.5,5.5],[-7.5,5.5]]";

function stripAshfallTestFabric(): void {
  if (!existsSync(ASHFALL_FABRIC)) return;
  const fabric = JSON.parse(readFileSync(ASHFALL_FABRIC, "utf8")) as {
    features?: { id?: string; properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  const removedIds = fabric.features.filter((f) => f.properties?.name === TEST_NAME).map((f) => f.id);
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length === before) return;
  writeFileSync(ASHFALL_FABRIC, JSON.stringify(fabric, null, 2));
  if (!existsSync(ASHFALL_CACHE)) return;
  const kept = readFileSync(ASHFALL_CACHE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .filter((l) => {
      try {
        const r = JSON.parse(l) as { key: string };
        return !removedIds.some((id) => id && r.key.startsWith(`region:${id}:`));
      } catch {
        return true;
      }
    });
  writeFileSync(ASHFALL_CACHE, kept.length ? kept.join("\n") + "\n" : "");
}

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

interface GeneratedFeature {
  id: number | string;
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

function generatedFeatures(): GeneratedFeature[] {
  return evalJs("app.plugins.plugins['campaign-map'].generated") as GeneratedFeature[];
}
/** Poll the canon index size until it's stable for several consecutive reads,
 * then return it. Canonize creates a note whose vault-change -> debounced
 * rescan -> index-update chain lands asynchronously; without settling first, a
 * prior check's still-propagating +1 gets misattributed to the next check. */
async function settleIndexSize(): Promise<number> {
  let prev = -1;
  let stable = 0;
  let size = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 250));
    size = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;
    if (size === prev) stable++;
    else {
      stable = 0;
      prev = size;
    }
  }
  return size;
}

/** Runs an async MapView method against the open Ashfall view (evalJs can't
 * await, so the promise parks its result on a window global we poll). */
async function runOnAshfall(body: string, timeoutMs = 120000): Promise<unknown> {
  const viewExpr =
    "app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='ashfall'})";
  evalJs(`window.__p3r = undefined; (function(){ var v=${viewExpr};
    if (!v) { window.__p3r = { error: 'no ashfall view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p3r = { ok: r === undefined ? true : r }; }, function(e){ window.__p3r = { error: String(e && e.message || e) }; });
    return 'started'; })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p3r === undefined ? null : window.__p3r)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(parsed.error);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("in-app async timed out");
}

function countsByGenerator(features: GeneratedFeature[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const f of features) {
    const id = String(f.properties.generatorId);
    c[id] = (c[id] ?? 0) + 1;
  }
  return c;
}

/**
 * `obsidian-native` rebuilds its MapLibre style on Obsidian's `css-change`
 * event (Phase 1), which can fire from CLI automation independently of our
 * own commands — `map.getStyle()`/`queryRenderedFeatures()` can transiently
 * see a torn-down style (`isStyleLoaded() === false`) mid-rebuild. Poll
 * instead of a fixed wait before anything that reads style/render state.
 */
async function waitForStyleLoaded(maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (evalJs("app.plugins.plugins['campaign-map'].map.isStyleLoaded()") === true) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const gate = new Gate();
  console.log("== Phase 3 gate ==\n");

  resetLeaves();
  // Clear any test district a crashed prior run left behind (app detached above).
  stripAshfallTestFabric();

  await gate.try("no Node API in bundle", () => {
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    const bad = bundle.match(/require\(["']fs["']\)|require\(["']node:[a-z/]+["']\)/g);
    if (bad) throw new Error(`found ${bad.join(", ")}`);
  });

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("open Ashfall campaign", () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("on-map toolbar renders its core action buttons (plan 003+)", () => {
    const result = evalJs(`(() => {
      var view = app.workspace.getLeavesOfType('campaign-map-view')[0].view;
      var bar = view.contentEl.querySelector('.campaign-map-toolbar');
      var buttons = bar ? bar.querySelectorAll('.campaign-map-toolbar-btn').length : 0;
      return { hasToolbar: !!bar, buttonCount: buttons };
    })()`) as { hasToolbar: boolean; buttonCount: number };
    if (!result.hasToolbar) throw new Error("no .campaign-map-toolbar found in view.contentEl");
    // Plan 018 decluttered the toolbar to 5 core buttons (add / pencil /
    // search / theme / settings) — generate & export live in the settings
    // modal. Assert the core set, not an exact count.
    if (result.buttonCount < 5) throw new Error(`expected >= 5 toolbar buttons, found ${result.buttonCount}`);
  });

  await gate.try("generate-fabric-here (world tier) generates from a clean slate", async () => {
    clearErrors();
    await runOnAshfall("function(v){ return v.clearAllGenerated(); }");
    evalJs("app.plugins.plugins['campaign-map'].map.jumpTo({center:[0,0], zoom:5}); 'ok'");
    const before = generatedFeatures().length;
    obsidian("command id=campaign-map:generate-fabric-here");
    let after = before;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      after = generatedFeatures().length;
      if (after > before) break;
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    if (after <= before) throw new Error(`generate-fabric-here didn't increase generated features (before ${before}, after ${after})`);
    const counts = countsByGenerator(generatedFeatures());
    if (!counts["world-region"]) throw new Error(`no world-region features: ${JSON.stringify(counts)}`);
  });

  let testRegionId = "";
  await gate.try("city tier: sketching a district produces streets/blocks/parcels/footprints/wards (plan 020)", async () => {
    clearErrors();
    await runOnAshfall("function(v){ return v.clearAllGenerated(); }");
    // The sketched district IS the city-tier request — no zoom gate, no disc.
    const res = (await runOnAshfall(
      `function(v){ return v.createRegionForTest(${TEST_RING}, 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number; outside: number };
    testRegionId = res.featureId;
    if (res.count < 100) throw new Error(`only ${res.count} features generated in the district`);
    if (res.outside > 0) throw new Error(`${res.outside} coords fell outside the sketched district`);
    const counts = (await runOnAshfall(
      `function(v){ return Promise.resolve((function(){ var c={}; var pre='region:'+${JSON.stringify(res.featureId)}+':';
        v.loadedTiles.forEach(function(feats,k){ if(k.indexOf(pre)!==0) return; feats.forEach(function(f){ var g=(f.properties||{}).generatorId; c[g]=(c[g]||0)+1; }); });
        return c; })()); }`
    )) as Record<string, number>;
    for (const id of ["city-street", "city-block", "city-parcel", "city-footprint", "city-district"]) {
      if (!counts[id] || counts[id] < 1) throw new Error(`missing/empty ${id}: ${JSON.stringify(counts)}`);
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("world background is biome-driven, not a flat fill (plans/002)", () => {
    const result = evalJs(`(() => {
      var map = app.plugins.plugins['campaign-map'].map;
      return {
        hasRegion: !!map.getLayer('generated-region'),
        fillIsExpression: Array.isArray(map.getPaintProperty('generated-region', 'fill-color')),
      };
    })()`) as { hasRegion: boolean; fillIsExpression: boolean };
    if (!result.hasRegion) throw new Error("generated-region layer missing");
    if (!result.fillIsExpression) {
      throw new Error(
        `generated-region fill-color is not a data-driven expression: ${JSON.stringify(result)}`
      );
    }
  });

  await gate.try("generated fabric renders alongside canon (provenance-invisible layers, F2)", async () => {
    // zoom 6, not fitBounds' auto-computed ~4.7: Ashfall City's zoomMin is 5
    // (docs/06 §3 type taxonomy) — below that, by design, nothing qualifies
    // to render yet (cartographic zoom-range discipline, not a bug).
    await waitForStyleLoaded();
    evalJs("app.plugins.plugins['campaign-map'].map.jumpTo({center:[0,0], zoom:6}); 'ok'");
    // Poll rather than a single fixed wait: queryRenderedFeatures reflects
    // the last painted frame, and a camera jump needs at least one
    // requestAnimationFrame tick before it does — a fixed wait occasionally
    // races that under CLI load.
    let canonCount = 0;
    for (let i = 0; i < 10; i++) {
      await waitForStyleLoaded();
      await new Promise((r) => setTimeout(r, 300));
      canonCount = evalJs(
        "app.plugins.plugins['campaign-map'].map.queryRenderedFeatures(undefined, {layers:['canon-point']}).length"
      ) as number;
      if (canonCount > 0) break;
    }
    if (typeof canonCount !== "number" || canonCount < 1) throw new Error(`canon-point features: ${canonCount}`);
    await waitForStyleLoaded();
    const genCount = evalJs(
      "app.plugins.plugins['campaign-map'].map.queryRenderedFeatures(undefined, {layers:['generated-street','generated-district']}).length"
    );
    if (typeof genCount !== "number" || genCount < 1) throw new Error(`generated features: ${genCount}`);
  });

  await gate.try(
    "determinism: cache-delete + replay produces hash-identical output (docs/06 §2)",
    async () => {
      // The sketched-district city generated above replays from the sketch
      // layer; its region cache records must survive a full .mapcache delete
      // (regenerated on replay by a fresh view). rmSync, not the CLI delete
      // command — the command can't resolve dot-folder files, and deleting out
      // from under Obsidian is the truest "GM deletes .mapcache" simulation.
      const cachePath = "dev-vault/Campaigns/Ashfall/.mapcache/generated.jsonl";
      if (!existsSync(cachePath)) throw new Error("expected a populated cache before the delete");
      const readRecords = (): Map<string, string> => {
        const out = new Map<string, string>();
        for (const line of readFileSync(cachePath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const rec = JSON.parse(line) as { key: string; features: unknown };
          out.set(rec.key, JSON.stringify(rec.features));
        }
        return out;
      };
      const before = readRecords();
      if (before.size === 0) throw new Error("no cache records before delete");
      rmSync(cachePath);

      resetLeaves();
      obsidian("command id=campaign-map:open-map-ashfall");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (existsSync(cachePath)) {
          const now = readRecords();
          if ([...before.keys()].every((k) => now.has(k))) break;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      const after = readRecords();
      for (const [key, features] of before) {
        if (after.get(key) !== features) {
          throw new Error(`record ${key} differs after cache delete + replay — determinism broke (release blocker)`);
        }
      }
    }
  );

  // Plan 019 deleted canonization outright (fabric never promotes) and the
  // per-tier generate commands were unified into generate-fabric-here; the
  // old canonize/regenerate-city-here checks tested commands that no longer
  // exist. The replacement checks assert the CURRENT contract.
  await gate.try("canonization is gone (plan 019: fabric never promotes)", () => {
    // evalJs already JSON.parses the CLI payload — return the plain object.
    const c = evalJs(
      `(function(){ return {
        canonize: !!app.commands.commands['campaign-map:canonize-nearest-generated'],
        oldCity: !!app.commands.commands['campaign-map:generate-city-here'],
        oldWorld: !!app.commands.commands['campaign-map:generate-world-here'],
        fabricHere: !!app.commands.commands['campaign-map:generate-fabric-here'],
        regenHere: !!app.commands.commands['campaign-map:regenerate-fabric-here'],
        clearHere: !!app.commands.commands['campaign-map:clear-generated-here'],
      }; })()`
    ) as Record<string, boolean>;
    const cmds = JSON.stringify(c);
    if (c.canonize || c.oldCity || c.oldWorld) {
      throw new Error(`pre-019 commands still registered: ${cmds}`);
    }
    if (!c.fabricHere || !c.regenHere || !c.clearHere) {
      throw new Error(`plan-019 generate/regenerate/clear commands missing: ${cmds}`);
    }
  });

  await gate.try("regenerate adapts to canon changes; canon itself never touched (plan 020 region)", async () => {
    clearErrors();
    // Snapshot the sketched-district city founded by the city-tier check above
    // (this check depends on it — the district covers Ashfall's center).
    // regenerateFabricHere finds the region by point, zoom-independently.
    const before = (await runOnAshfall(
      `function(v){ return v.regenerateFabricHere([0,0]).then(function(f){
        return JSON.stringify(f.filter(function(x){return x.properties && x.properties.generatorId === 'city-street';})); }); }`
    )) as string;

    const beforeIndexSize = await settleIndexSize();
    // A new canon Location inside the district is a CONSTRAINT change: cityness
    // bumps ("the city grows around the GM's pins") + canon clearance.
    evalJs(
      `app.plugins.plugins['campaign-map'].createLocation('ashfall', [1, 0.5], 'Gate3 Regen Probe', 'village', 'mid'); 'ok'`
    );
    let afterIndexSize = beforeIndexSize;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      afterIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;
      if (afterIndexSize > beforeIndexSize) break;
    }
    if (afterIndexSize !== beforeIndexSize + 1) {
      throw new Error(`probe note never joined the index (${beforeIndexSize} -> ${afterIndexSize})`);
    }

    const after = (await runOnAshfall(
      `function(v){ return v.regenerateFabricHere([0,0]).then(function(f){
        return JSON.stringify(f.filter(function(x){return x.properties && x.properties.generatorId === 'city-street';})); }); }`
    )) as string;
    if (before === after) {
      throw new Error("regenerate with a new canon Location inside the district left streets byte-identical — constraints aren't reshaping fabric");
    }
    const finalIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;
    if (finalIndexSize !== afterIndexSize) {
      throw new Error(`regenerate touched canon: index ${afterIndexSize} -> ${finalIndexSize}`);
    }

    // Delete the probe note (the district itself is torn down in the final
    // fixture-cleanup step so dev-vault stays byte-intact).
    obsidianRaw(["delete", "path=Campaigns/Ashfall/Locations/Gate3 Regen Probe.md", "permanent"]);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("survives full app reload", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("screenshot: generated city fabric alongside canon", async () => {
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    // The test district replays from the sketch layer on open — wait for it.
    await new Promise((r) => setTimeout(r, 2500));
    evalJs("app.plugins.plugins['campaign-map'].map.fitBounds([[-7.5,-5.5],[7.5,5.5]], {padding:20, animate:false}); 'ok'");
    await new Promise((r) => setTimeout(r, 1200));
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase3-ashfall-generated.png");
    if (!existsSync("shots/gate-phase3-ashfall-generated.png")) throw new Error("screenshot missing");
  });

  await gate.try("fixture cleanup: dev-vault left byte-intact", async () => {
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    await new Promise((r) => setTimeout(r, 2000));
    // clearAllGenerated drops world entries + strips region procgen blocks +
    // drops region cache; stripAshfallTestFabric (app detached) removes the
    // test district feature itself + any residual region records.
    await runOnAshfall("function(v){ return v.clearAllGenerated(); }");
    resetLeaves();
    await new Promise((r) => setTimeout(r, 800));
    stripAshfallTestFabric();
    const gen = JSON.parse(readFileSync("dev-vault/Campaigns/Ashfall/Generated.json", "utf8")) as {
      entries?: unknown[];
      domains?: unknown[];
    };
    if ((gen.entries ?? []).length !== 0 || (gen.domains ?? []).length !== 0) {
      throw new Error(`Ashfall manifest not clean: ${JSON.stringify(gen)}`);
    }
    const fab = JSON.parse(readFileSync(ASHFALL_FABRIC, "utf8")) as { features: { properties?: { name?: string } }[] };
    if (fab.features.some((f) => f.properties?.name === TEST_NAME)) throw new Error("test district survived cleanup");
  });

  process.exit(gate.summarize("Phase 3"));
}

main();

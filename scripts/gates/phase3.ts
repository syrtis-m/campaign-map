#!/usr/bin/env tsx
// Phase 3 Tier A gate — procedural generation (docs/03 Phase 3, docs/06 §2).
// Pure-function determinism/seam guarantees are exhaustively unit-tested
// (npm test: 17 dedicated tests in src/gen/{city,world}/*.test.ts) — this
// gate covers the integration surface unit tests can't: live cache
// persistence, the generate/canonize/regenerate UI flow, and screenshots.
//
// Note on evalJs: it already JSON.parses whatever the CLI prints after
// "=> ". Returning `JSON.stringify(x)` from eval code round-trips back into
// a parsed object anyway (double-encode, single-decode) — always return
// plain values from eval code and let evalJs do the one parse.
import { readFileSync, existsSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

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
    // >= 6: plan 003 shipped 6 core buttons; later plans append more (e.g. 007's
    // poster-export button). Assert the core set is present, not an exact count.
    if (result.buttonCount < 6) throw new Error(`expected >= 6 toolbar buttons, found ${result.buttonCount}`);
  });

  await gate.try("on-map toolbar's generate button is wired to real generation (plan 003)", async () => {
    clearErrors();
    // Zoom to world band so "Generate fabric here" produces world fabric.
    evalJs("app.plugins.plugins['campaign-map'].map.setZoom(5); 'ok'");

    // setZoom fires zoomend, which also triggers the view's own debounced
    // viewport dispatcher — so `generated.length` can grow from that
    // automatic dispatch, not from the button click. Poll until the count
    // stops changing (the dispatch has settled) before capturing `before`,
    // so a subsequent increase can only be attributed to the click.
    let before = generatedFeatures().length;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = generatedFeatures().length;
      if (now === before) break;
      before = now;
    }

    evalJs(
      "app.workspace.getLeavesOfType('campaign-map-view')[0].view.contentEl.querySelectorAll('.campaign-map-toolbar-btn')[1].click(); 'clicked'"
    );

    let after = before;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      after = generatedFeatures().length;
      if (after > before) break;
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    if (after <= before) throw new Error(`toolbar generate click didn't increase generated features (before ${before}, after ${after})`);
  });

  await gate.try("generate-city-here produces streets/districts/blocks/footprints", async () => {
    clearErrors();
    evalJs("app.plugins.plugins['campaign-map'].map.jumpTo({center:[2,-4], zoom:6}); 'ok'");
    obsidian("command id=campaign-map:generate-city-here");
    // Poll rather than a fixed wait: Phase 4's viewport dispatcher now also
    // fires on this same jumpTo (moveend) and competes for cache I/O with
    // the manual command's own generateTile() calls — a fixed 900ms budget
    // that was comfortable in Phase 3 can legitimately not be enough now.
    let counts: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      counts = countsByGenerator(generatedFeatures());
      if (["city-street", "city-district", "city-block", "city-footprint"].every((id) => counts[id] > 0)) break;
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    for (const id of ["city-street", "city-district", "city-block", "city-footprint"]) {
      if (!counts[id] || counts[id] < 1) throw new Error(`missing/empty ${id}: ${JSON.stringify(counts)}`);
    }
  });

  await gate.try("generate-world-here produces regions/settlements/routes", async () => {
    clearErrors();
    evalJs("app.plugins.plugins['campaign-map'].map.jumpTo({center:[-6,5], zoom:4}); 'ok'");
    obsidian("command id=campaign-map:generate-world-here");
    let counts: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      counts = countsByGenerator(generatedFeatures());
      if (counts["world-region"] > 0) break;
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    if (!counts["world-region"]) throw new Error(`no world-region features: ${JSON.stringify(counts)}`);
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
    "determinism: cache-delete + regenerate produces hash-identical output (docs/06 §2)",
    async () => {
      // A fresh view both times (`generatedFeatures()` accumulates across a
      // view's lifetime, merged by feature id — comparing it against itself
      // mid-session would just be comparing "everything so far" against
      // "everything so far plus a bit more", not this one tile in isolation).
      const centerExpr = "[3.5,-2.5]";

      resetLeaves();
      obsidian("command id=campaign-map:open-map-ashfall");
      evalJs(`app.plugins.plugins['campaign-map'].map.jumpTo({center:${centerExpr}, zoom:6}); 'ok'`);
      obsidian("command id=campaign-map:generate-city-here");
      await new Promise((r) => setTimeout(r, 900));
      const before = JSON.stringify(generatedFeatures());

      // Delete the on-disk cache entirely (CLAUDE.md: "Deleting .mapcache/ must
      // be harmless — regenerates identically"). Vault content is written/removed
      // via the CLI's own file commands, not eval (docs/05 §"Rules for agents").
      if (existsSync("dev-vault/Campaigns/Ashfall/.mapcache/generated.jsonl")) {
        obsidianRaw(["delete", "path=Campaigns/Ashfall/.mapcache/generated.jsonl", "permanent"]);
      }

      resetLeaves();
      obsidian("command id=campaign-map:open-map-ashfall");
      evalJs(`app.plugins.plugins['campaign-map'].map.jumpTo({center:${centerExpr}, zoom:6}); 'ok'`);
      obsidian("command id=campaign-map:generate-city-here");
      await new Promise((r) => setTimeout(r, 900));
      const after = JSON.stringify(generatedFeatures());

      if (before !== after) {
        throw new Error(`regenerated output differs after cache delete (before ${before.length}, after ${after.length} chars)`);
      }
    }
  );

  await gate.try("canonize-nearest-generated: creates note, strips from cache+view, joins canon index", async () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");

    // Settlement placement is an independent per-region-site suitability roll
    // (world/settlements.ts) — deliberately not spacing-aware/guaranteed
    // (order-dependence would break seams), so a given tile may legitimately
    // roll zero. Sweep several spread-out centers within campaign bounds.
    const candidateCenters: [number, number][] = [
      [3, 3], [-6, 5], [-2, -4], [6, -5], [-6, -4], [4, 4], [0, -5], [-4, 1], [5, 1],
    ];
    let settlement: GeneratedFeature | undefined;
    for (const [cx, cy] of candidateCenters) {
      settlement = generatedFeatures().find((f) => f.properties.generatorId === "world-settlement");
      if (settlement) break;
      evalJs(`app.plugins.plugins['campaign-map'].map.jumpTo({center:[${cx},${cy}], zoom:4}); 'ok'`);
      obsidian("command id=campaign-map:regenerate-world-here"); // force: a prior run may have left a stale/stripped cache entry
      // Poll rather than a fixed wait: the command's async generateWorldHere
      // isn't awaited by the checkCallback, so a fixed delay can race it.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (generatedFeatures().find((f) => f.properties.generatorId === "world-settlement")) break;
      }
    }
    settlement = settlement ?? generatedFeatures().find((f) => f.properties.generatorId === "world-settlement");
    if (!settlement) throw new Error(`no generated settlement found after sweeping ${candidateCenters.length} tiles`);

    const [x, y] = settlement.geometry.coordinates as [number, number];
    const name = String(settlement.properties.name);

    const beforeIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;

    evalJs(`app.plugins.plugins['campaign-map'].map.jumpTo({center:[${x},${y}], zoom:8}); 'ok'`);
    obsidian("command id=campaign-map:canonize-nearest-generated");

    // Poll for the index to actually pick up the new note: canonize creates
    // the file, then the vault-change -> debounced rescanLocations() ->
    // index-update chain runs asynchronously relative to the command. Budget
    // widened for Phase 4: the viewport dispatcher's own ongoing cache I/O
    // now competes with this reconcile chain for the vault adapter, so it
    // can legitimately take longer than Phase 3's original 3s allowed.
    let afterIndexSize = beforeIndexSize;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      afterIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;
      if (afterIndexSize > beforeIndexSize) break;
    }

    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);

    const stillGenerated = generatedFeatures().filter(
      (f) => f.properties.generatorId === "world-settlement" && f.properties.name === name
    ).length;
    if (stillGenerated !== 0) throw new Error(`${name} still present in generated fabric after canonizing`);

    if (afterIndexSize !== beforeIndexSize + 1) {
      throw new Error(`index size ${beforeIndexSize} -> ${afterIndexSize}, expected +1`);
    }

    const noteExists = evalJs(`!!app.vault.getAbstractFileByPath('Campaigns/Ashfall/Locations/${name}.md')`);
    if (noteExists !== true) throw new Error(`note not found for ${name}`);
  });

  await gate.try("regenerate-city-here after canonize: canon survives, fabric actually regenerates", async () => {
    clearErrors();
    const beforeIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;

    // Phase 4's viewport dispatcher now runs continuously alongside this
    // check, independently fetching/evicting tiles across the whole
    // viewport — comparing the *global* `generated` getter before/after
    // (the original approach) started spuriously passing/failing on
    // whether unrelated dispatcher churn happened to touch city-street
    // features in that window, not on whether *this* regenerate call did
    // its job. Call generateCityHere() directly and diff its own return
    // value instead — scoped to exactly the one tile under test, immune
    // to what else the dispatcher is doing. Full geometry, not just ids:
    // a street's id is `hashSeed(seed, cellX, cellY, "street", partIndex)`
    // (src/gen/city/index.ts) — a function of cell position only, so a
    // canon-avoidance path change can alter geometry while keeping the same
    // id. An id-only fingerprint would miss exactly the change this check
    // exists to catch.
    const snapshot = (force: boolean) =>
      evalJs(`(async () => {
        const view = app.workspace.getLeavesOfType('campaign-map-view')[0].view;
        const c = view.map.getCenter();
        const result = await view.generateCityHere([c.lng, c.lat], ${force});
        return JSON.stringify(result.filter(f => f.properties.generatorId === 'city-street'));
      })()`) as string;

    const before = snapshot(false);
    const after = snapshot(true);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);

    const afterIndexSize = evalJs("app.plugins.plugins['campaign-map'].index.size") as number;
    if (afterIndexSize !== beforeIndexSize) {
      throw new Error(`regenerate touched canon: index ${beforeIndexSize} -> ${afterIndexSize}`);
    }

    // "Surroundings adapt" isn't just a claim: force-regenerating the same
    // tile with fresh canon constraints (the just-canonized settlement is
    // now in `canonFeatures`) must actually re-run the generator, not
    // silently return the prior cached/in-memory streets untouched.
    if (before === after) {
      throw new Error("regenerate-city-here left city-street fabric byte-identical — it didn't actually re-run");
    }
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
    await new Promise((r) => setTimeout(r, 800));
    evalJs("app.plugins.plugins['campaign-map'].map.jumpTo({center:[-8,-6],zoom:2}); 'ok'");
    obsidian("command id=campaign-map:generate-city-here");
    await new Promise((r) => setTimeout(r, 500));
    evalJs("app.plugins.plugins['campaign-map'].map.fitBounds([[0,-6],[12,6]], {padding:20, animate:false}); 'ok'");
    await new Promise((r) => setTimeout(r, 800));
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase3-ashfall-generated.png");
    if (!existsSync("shots/gate-phase3-ashfall-generated.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Phase 3"));
}

main();

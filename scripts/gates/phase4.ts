#!/usr/bin/env tsx
// Phase 4 Tier A gate — continuous LOD (docs/03 Phase 4, docs/06 §2).
// Covers what unit tests can't: the live viewport dispatcher (tile-keyed
// store, eviction, worker wiring, zoom-band transitions), and the two
// perf assertions docs/06 §2 calls out (frame-time sampler, index rebuild
// time). See scripts/gates/phase3.ts for the evalJs double-encoding note —
// same rule applies here.
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

/**
 * A dense city-band tile carries hundreds of block/footprint polygons
 * (Phase 3 advisor review: "blocks alone were 476/tile") — pulling the
 * *full* `generated` feature array across the CLI's eval bridge at city
 * zoom blows past execFileSync's default 1MB stdout buffer and the eval
 * round-trip just fails outright. Aggregate inside the browser context
 * instead and ship only the small summary back — the geometry-correctness
 * side of this is already covered by src/gen/**\/*.test.ts's deep-equal
 * unit tests; this gate only needs to confirm the *live dispatcher* path
 * (cache/worker → tile store → MapLibre source) didn't drop or duplicate
 * anything, which counts and id-sets are sufficient to prove.
 */
function generatedCounts(): Record<string, number> {
  return evalJs(`(() => {
    const feats = app.plugins.plugins['campaign-map'].generated;
    const c = {};
    for (const f of feats) { const id = f.properties.generatorId; c[id] = (c[id]||0) + 1; }
    return c;
  })()`) as Record<string, number>;
}

/** Sorted feature-id list for one generatorId — ids are content-derived
 * hashes (`hashSeed(campaignSeed, cellX, cellY, ...)`, src/gen/city/index.ts),
 * not sequential counters, so an identical id set is a valid (and far
 * smaller) determinism proxy for the full deep-equal the unit tests already do. */
function generatedIdFingerprint(generatorId: string): string {
  return evalJs(`(() => {
    const feats = app.plugins.plugins['campaign-map'].generated;
    return feats.filter(f => f.properties.generatorId === '${generatorId}').map(f => f.id).sort().join(',');
  })()`) as string;
}

/** See phase3.ts — obsidian-native's css-change listener can rebuild the
 * MapLibre style independently of any gate command; poll before reading
 * render state instead of a fixed wait. */
async function waitForStyleLoaded(maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (evalJs("app.plugins.plugins['campaign-map'].map.isStyleLoaded()") === true) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function jumpAndSettle(center: [number, number], zoom: number, waitMs = 900): Promise<void> {
  evalJs(`app.plugins.plugins['campaign-map'].map.jumpTo({center:[${center[0]},${center[1]}], zoom:${zoom}}); 'ok'`);
  await new Promise((r) => setTimeout(r, waitMs));
}

async function main() {
  const gate = new Gate();
  console.log("== Phase 4 gate ==\n");

  resetLeaves();

  await gate.try("no Node API in bundle (main + generation worker)", () => {
    for (const file of ["main.js", "generation-worker.js"]) {
      const bundle = readFileSync(`dev-vault/.obsidian/plugins/campaign-map/${file}`, "utf8");
      const bad = bundle.match(/require\(["']fs["']\)|require\(["']node:[a-z/]+["']\)/g);
      if (bad) throw new Error(`${file}: found ${bad.join(", ")}`);
    }
  });

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("open Ashfall, viewport dispatcher auto-populates world tier without a manual command", async () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    await new Promise((r) => setTimeout(r, 500));
    // Below CITY_BAND_MIN_ZOOM (8) — world tier. No generate-world-here
    // command issued: moveend from jumpTo alone must trigger the dispatcher.
    await jumpAndSettle([0, 0], 5);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    const counts = generatedCounts();
    if (!counts["world-region"]) throw new Error(`no world-region features after a bare pan: ${JSON.stringify(counts)}`);
  });

  await gate.try("crossing the zoom band evicts world tiles and loads city tiles", async () => {
    clearErrors();
    await jumpAndSettle([0, 0], 5);
    const worldCounts = generatedCounts();
    if (!worldCounts["world-region"]) throw new Error(`expected world tier at zoom 5: ${JSON.stringify(worldCounts)}`);

    await jumpAndSettle([0, 0], 10);
    const cityCounts = generatedCounts();
    if (cityCounts["world-region"]) throw new Error(`world-region survived the band crossing: ${JSON.stringify(cityCounts)}`);
    if (!cityCounts["city-street"] && !cityCounts["city-district"]) {
      throw new Error(`no city tier after crossing into it: ${JSON.stringify(cityCounts)}`);
    }
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("eviction bounds the tile store — panning far away drops out-of-view tiles", async () => {
    await jumpAndSettle([0, 0], 10);
    const nearCount = evalJs("app.plugins.plugins['campaign-map'].loadedTileCount") as number;
    if (nearCount < 1) throw new Error(`expected loaded tiles near [0,0]: ${nearCount}`);

    // Far outside Ashfall's own bounds ([-8,-6,8,6]) but still a valid city-band tile.
    await jumpAndSettle([150, 70], 10);
    const farCount = evalJs("app.plugins.plugins['campaign-map'].loadedTileCount") as number;
    // Bounded, not "near + far accumulated": the near tiles must have been evicted,
    // not just added to — this is the load-bearing property (advisor review),
    // distinguishing a viewport window from the old flat merge-by-id array.
    if (farCount > nearCount * 2) {
      throw new Error(`tile store grew rather than replaced on a far pan: near=${nearCount} far=${farCount}`);
    }
  });

  await gate.try("determinism: revisiting a tile after eviction reproduces identical output", async () => {
    await jumpAndSettle([150, 70], 10); // pan away — evicts the [0,0] tiles from Phase 3's determinism gate
    await jumpAndSettle([0, 0], 10);
    const before = generatedIdFingerprint("city-street");
    if (!before) throw new Error("no city-street features loaded at [0,0] to fingerprint");

    await jumpAndSettle([150, 70], 10);
    await jumpAndSettle([0, 0], 10);
    const after = generatedIdFingerprint("city-street");

    if (before !== after) throw new Error("revisiting the same tile after eviction produced a different id set");
  });

  await gate.try("dispatcher renders through to MapLibre (not just the source)", async () => {
    await waitForStyleLoaded();
    await jumpAndSettle([0, 0], 10);
    await waitForStyleLoaded();
    let rendered = 0;
    for (let i = 0; i < 10; i++) {
      await waitForStyleLoaded();
      await new Promise((r) => setTimeout(r, 300));
      rendered = evalJs(
        "app.plugins.plugins['campaign-map'].map.queryRenderedFeatures(undefined, {layers:['generated-street','generated-district','generated-region']}).length"
      ) as number;
      if (rendered > 0) break;
    }
    if (rendered < 1) throw new Error(`no generated features actually painted: ${rendered}`);
  });

  await gate.try(
    "perf: frame-time sampler during a scripted pan (docs/06 §2 — CI-machine number, not a Surface Pro verification)",
    async () => {
      await jumpAndSettle([0, 0], 10);
      const result = evalJs(`(async () => {
        const map = app.plugins.plugins['campaign-map'].map;
        const frames = [];
        const onRender = () => frames.push(performance.now());
        map.on('render', onRender);
        map.panBy([400, 0], {duration: 1500});
        await new Promise(r => setTimeout(r, 1800));
        map.off('render', onRender);
        const deltas = [];
        for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i-1]);
        deltas.sort((a,b) => a-b);
        const p95ms = deltas.length ? deltas[Math.floor(deltas.length * 0.95)] : null;
        return { frameCount: frames.length, p95ms };
      })()`) as { frameCount: number; p95ms: number | null };

      if (!result.frameCount || result.p95ms === null) throw new Error(`no frames sampled: ${JSON.stringify(result)}`);
      const p95fps = 1000 / result.p95ms;
      console.log(`    p95 frame time ${result.p95ms.toFixed(1)}ms (~${p95fps.toFixed(1)}fps on this CI machine, ${result.frameCount} frames sampled)`);
      // A conservative CI-safe floor, not the docs/06 Surface Pro target (50fps) —
      // this machine's compositor/hardware differs from Jonah's; the honest claim
      // here is "didn't stall," not "hits the device target." Record the real
      // number in PROGRESS.md for Jonah's eyes rather than gating on a number
      // this environment can't actually verify against the real device.
      if (p95fps < 15) throw new Error(`p95 fps ${p95fps.toFixed(1)} — pan stalled badly, investigate before trusting the number at all`);
    }
  );

  await gate.try("perf: index rebuild time <1s for a synthetic 500-note campaign (docs/06 §2)", async () => {
    const campaignDir = "dev-vault/Campaigns/PerfTest500";
    const locationsDir = `${campaignDir}/Locations`;
    try {
      mkdirSync(locationsDir, { recursive: true });
      writeFileSync(
        `${campaignDir}/PerfTest500.map.md`,
        `---\nmap-campaign: true\ncrs: fictional\ntheme: obsidian-native\nseed: 1\nscaleMetersPerUnit: 1\nbounds: [-500, -500, 500, 500]\n---\n`
      );
      for (let i = 0; i < 500; i++) {
        const x = (i % 50) * 10 - 250;
        const y = Math.floor(i / 50) * 10 - 250;
        writeFileSync(
          `${locationsDir}/Perf Location ${i}.md`,
          `---\nmap: perftest500\ngeometry: [${x}, ${y}]\ntype: village\n---\n`
        );
      }

      obsidianRaw(["reload"]);
      await new Promise((r) => setTimeout(r, 5000));

      // rescanAll() runs once automatically on onLayoutReady (main.ts) after
      // the reload picks up the 500 new files; poll rescanTimeMs rather than
      // a fixed wait since layout-ready timing varies under CLI load.
      let rescanMs = 0;
      for (let i = 0; i < 15; i++) {
        rescanMs = evalJs("app.plugins.plugins['campaign-map'].rescanTimeMs") as number;
        if (rescanMs > 0) break;
        await new Promise((r) => setTimeout(r, 300));
      }

      console.log(`    last rescanAll() pass: ${rescanMs.toFixed(1)}ms (500-note synthetic campaign)`);
      if (typeof rescanMs !== "number" || rescanMs <= 0) throw new Error(`no rescan timing recorded: ${rescanMs}`);
      if (rescanMs >= 1000) throw new Error(`rescanAll() took ${rescanMs.toFixed(1)}ms, budget is <1000ms`);
    } finally {
      rmSync(campaignDir, { recursive: true, force: true });
      obsidianRaw(["reload"]);
      await new Promise((r) => setTimeout(r, 4000));
    }
  });

  await gate.try("survives full app reload", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("screenshot: city fabric via the automatic dispatcher (no generate-*-here command)", async () => {
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    await new Promise((r) => setTimeout(r, 800));
    await jumpAndSettle([6, 6], 11, 1200);
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase4-dispatcher-city.png");
    if (!existsSync("shots/gate-phase4-dispatcher-city.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Phase 4"));
}

main();

#!/usr/bin/env tsx
// Phase 4 Tier A gate — modernized 2026-07-11 for plan 019 + procgen v3.
// The original subject (the viewport dispatcher) was DELETED by plan 019:
// generation is explicit-only, tiers coexist (no band eviction), and the
// tile store tracks the GM's requests, not the viewport. This gate asserts
// that post-019 contract plus the two enduring perf assertions docs/06 §2
// calls out (frame-time sampler, index rebuild time). See phase3.ts for the
// evalJs double-encoding note — same rule applies here.
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

const ashfallViewExpr =
  "app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='ashfall'})";

/** Runs an async MapView method against the open Ashfall view (same pattern
 * as phase3.ts — evalJs can't await, so the result parks on a window global). */
async function runOnAshfall(body: string, timeoutMs = 120000): Promise<unknown> {
  evalJs(`window.__p4r = undefined; (function(){ var v=${ashfallViewExpr};
    if (!v) { window.__p4r = { error: 'no ashfall view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p4r = { ok: r === undefined ? true : r }; }, function(e){ window.__p4r = { error: String(e && e.message || e) }; });
    return 'started'; })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p4r === undefined ? null : window.__p4r)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(parsed.error);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("in-app async timed out");
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

  // ——— Plan 019 inverted this phase's original subject: the viewport
  // dispatcher is DELETED (generation is explicit-only), zoom-band eviction
  // is gone (both tiers coexist — Jonah: LOD only hides location names),
  // and the tile store is bounded by the GM's explicit requests, not by
  // viewport windows. The checks below assert the post-019 contract; the
  // perf assertions further down are the enduring Phase-4 Tier A items.
  await gate.try("bare pan/zoom generates NOTHING (plan 019 explicit-only)", async () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    await new Promise((r) => setTimeout(r, 2000));
    await runOnAshfall("function(v){ return v.clearAllGenerated(); }");
    const before = evalJs(`(function(){ var v=${ashfallViewExpr}; return v.generatorRunCount; })()`) as number;
    await jumpAndSettle([0, 0], 5);
    await jumpAndSettle([3, 3], 10);
    await jumpAndSettle([-5, -4], 7);
    await jumpAndSettle([0, 0], 12);
    const after = evalJs(`(function(){ var v=${ashfallViewExpr}; return v.generatorRunCount; })()`) as number;
    if (after !== before) throw new Error(`pan/zoom ran ${after - before} generators — explicit-only violated`);
    const counts = generatedCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total !== 0) throw new Error(`bare pan/zoom produced features: ${JSON.stringify(counts)}`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("explicit generates: both tiers coexist on screen (no band eviction)", async () => {
    clearErrors();
    await jumpAndSettle([0, 0], 5);
    await runOnAshfall("function(v){ return v.generateFabricHere([0,0], {}); }"); // world tier
    await jumpAndSettle([0, 0], 9);
    await runOnAshfall(
      "function(v){ return v.generateFabricHere([0,0], { domainChoice: { profile: 'euro-medieval', radius: 400 } }); }"
    );
    await jumpAndSettle([0, 0], 5); // back to world zoom — city fabric must survive
    const counts = generatedCounts();
    if (!counts["world-region"]) throw new Error(`world tier missing: ${JSON.stringify(counts)}`);
    if (!counts["city-street"]) throw new Error(`city tier evicted at world zoom: ${JSON.stringify(counts)}`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("tile store is bounded by explicit requests, immune to panning", async () => {
    const before = evalJs("app.plugins.plugins['campaign-map'].loadedTileCount") as number;
    if (before < 2) throw new Error(`expected the two explicit generates above in the store: ${before}`);
    await jumpAndSettle([150, 70], 10); // far outside campaign bounds
    await jumpAndSettle([-150, -70], 5);
    await jumpAndSettle([0, 0], 10);
    const after = evalJs("app.plugins.plugins['campaign-map'].loadedTileCount") as number;
    if (after !== before) {
      throw new Error(`tile store changed under pan (${before} -> ${after}) — it must track requests, not the viewport`);
    }
  });

  await gate.try("revisit determinism: a fresh view reproduces the identical id set from replay", async () => {
    const before = generatedIdFingerprint("city-street");
    if (!before) throw new Error("no city-street features loaded to fingerprint");
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    let after = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 800));
      after = generatedIdFingerprint("city-street");
      if (after === before) break;
    }
    if (before !== after) throw new Error("manifest replay on a fresh view produced a different city-street id set");
  });

  await gate.try("explicitly generated fabric renders through to MapLibre (not just the source)", async () => {
    try {
      execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
    } catch {
      /* best-effort — occluded windows stop painting on macOS */
    }
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

  await gate.try("screenshot: explicitly generated fabric (plan 019 model)", async () => {
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

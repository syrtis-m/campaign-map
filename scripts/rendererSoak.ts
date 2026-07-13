#!/usr/bin/env tsx
// Renderer-degradation repro harness (plan 021 §2.2). Runs N reload→open→
// flyTo→screenshot cycles in ONE Obsidian process, probing render health and a
// timing proxy each cycle, and logs the cycle number at first failure.
//
// This is the investigation instrument, not a gate. It reproduces (or fails to
// reproduce) the long-session degradation described in docs/05 §pitfalls:
// `isStyleLoaded()` → false everywhere, `idle` stops firing, only a full
// process quit clears it. Prime suspect (advisor 2026-07-12): MapLibre `Map`/GL
// contexts surviving `plugin:reload` because the view's `onClose` teardown isn't
// invoked on plugin reload (MapView.onClose does `this.map.remove()`, but a
// plugin reload may not detach the leaf).
//
// Fixture-safe: touches only ashfall (open + flyTo + screenshot), no vault
// writes → nothing to clean. Use `--generate` to additionally stress with a
// throwaway region (restored via git at the end).
//
// Usage:
//   npm run soak                 # 50 cycles, reload/open/screenshot
//   npm run soak -- --cycles=20
//   npm run soak -- --generate   # add a createRegionForTest per cycle (dirties → auto-restored)
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { obsidian, obsidianRaw, evalJs, screenshot, ObsidianCliError } from "./lib/cli.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAMPAIGN = "ashfall";
const GEN_CAMPAIGN = "vespergate";
const SHOT = "/Users/athena/projects/campaign-map/shots/soak-latest.png";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

function viewExpr(campaign: string): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${campaign}'})`;
}

async function issueOpen(campaign: string): Promise<boolean> {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${campaign}`);
    if (String(out).includes("Executed")) break;
    await sleep(1200);
  }
  for (let i = 0; i < 25; i++) {
    if (evalJs(`!!(${viewExpr(campaign)})`) === true) return true;
    await sleep(400);
  }
  return false;
}

interface Health {
  styleLoaded: boolean;
  loaded: boolean;
  background: boolean;
  querySane: boolean;
  glCount: number; // # of <canvas> with a live WebGL context in the document (leak proxy)
}

function readHealth(campaign: string): Health & { healthy: boolean } {
  const raw = evalJs(`(function(){
    var v = ${viewExpr(campaign)};
    var styleLoaded=false, loaded=false, bg=false, querySane=false;
    if (v && v.map) {
      var m = v.map;
      try { styleLoaded = m.isStyleLoaded(); } catch(e){}
      try { loaded = m.loaded(); } catch(e){}
      try { bg = !!m.getLayer('background'); } catch(e){}
      try { querySane = Array.isArray(m.queryRenderedFeatures()); } catch(e){}
    }
    // GL-context leak proxy: count canvases in the DOM that still hold a live
    // (non-context-lost) WebGL context. A clean reload should keep this ~1.
    var glCount = 0;
    try {
      document.querySelectorAll('canvas.maplibregl-canvas').forEach(function(c){
        var gl = c.getContext('webgl2') || c.getContext('webgl');
        if (gl && !gl.isContextLost()) glCount++;
      });
    } catch(e){}
    return JSON.stringify({
      healthy: !!(styleLoaded && loaded && bg && querySane),
      styleLoaded: styleLoaded, loaded: loaded, background: bg, querySane: querySane, glCount: glCount
    });
  })()`);
  return typeof raw === "string" ? JSON.parse(raw) : (raw as Health & { healthy: boolean });
}

/** Frame-time proxy: ms to reach `idle` after a flyTo. A degraded renderer never
 * idles (returns the timeout). */
async function idleLatency(campaign: string, timeoutMs = 8000): Promise<number> {
  evalJs(`window.__soakIdle = undefined; (function(){
    var v = ${viewExpr(campaign)};
    if (!v || !v.map) { window.__soakIdle = -1; return; }
    var m = v.map; var t0 = performance.now();
    m.once('idle', function(){ window.__soakIdle = performance.now() - t0; });
    m.flyTo({ center: [1.5, 0.8], zoom: 11, animate: false });
    return 'flew';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = evalJs("window.__soakIdle === undefined ? null : window.__soakIdle");
    if (typeof v === "number") return v;
    await sleep(200);
  }
  return timeoutMs; // never idled
}

async function generateThrowaway(): Promise<void> {
  // createRegionForTest on vespergate — the same full commit path procgen gates use.
  const name = "__soak_test__";
  evalJs(`window.__soakGen = undefined; (function(){
    var v = ${viewExpr(GEN_CAMPAIGN)};
    if (!v) { window.__soakGen = { error: 'no view' }; return; }
    v.createRegionForTest([[12,-18],[32,-18],[32,2],[12,2]], 'city', { profile: 'euro-medieval' }, '${name}')
      .then(function(r){ window.__soakGen = { ok: r.count }; }, function(e){ window.__soakGen = { error: String(e && e.message || e) }; });
  })()`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__soakGen === undefined ? null : window.__soakGen)");
    const p = typeof out === "string" ? JSON.parse(out) : out;
    if (p !== null) return;
    await sleep(800);
  }
}

function restoreDevVault(): void {
  spawnSync("git", ["checkout", "--", "dev-vault/"], { cwd: REPO_ROOT, stdio: "inherit" });
  spawnSync("git", ["clean", "-fdq", "--", "dev-vault/"], { cwd: REPO_ROOT, stdio: "inherit" });
}

function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const cycles = typeof argv.cycles === "string" ? Number(argv.cycles) : 50;
  const doGenerate = argv.generate === true;
  const campaign = doGenerate ? GEN_CAMPAIGN : CAMPAIGN;

  console.log(`== renderer soak: ${cycles} cycles, campaign=${campaign}, generate=${doGenerate} ==\n`);
  console.log("cycle | styleLoaded loaded bg query | glCanvases | idleMs | reload+open ms");

  let firstFailure = -1;
  const glCounts: number[] = [];
  try {
    for (let c = 1; c <= cycles; c++) {
      const t0 = Date.now();
      try {
        obsidian("plugin:reload id=campaign-map");
      } catch (err) {
        console.log(`cycle ${c}: plugin:reload FAILED — ${err instanceof ObsidianCliError ? err.message : String(err)}`);
        if (firstFailure < 0) firstFailure = c;
        break;
      }
      await sleep(1500);
      const opened = await issueOpen(campaign);
      const openMs = Date.now() - t0;
      if (!opened) {
        console.log(`cycle ${c}: view never opened after reload (${openMs}ms)`);
        if (firstFailure < 0) firstFailure = c;
        break;
      }
      if (doGenerate) await generateThrowaway();
      const idle = await idleLatency(campaign);
      front();
      obsidianRaw(["dev:screenshot", `path=${SHOT}`]);
      const h = readHealth(campaign);
      glCounts.push(h.glCount);
      const flag = h.healthy && idle < 8000 ? "" : "  <<< DEGRADED";
      console.log(
        `${String(c).padStart(5)} | ${h.styleLoaded} ${h.loaded} ${h.background} ${h.querySane} | ${String(h.glCount).padStart(10)} | ${String(idle).padStart(6)} | ${openMs}${flag}`
      );
      if ((!h.healthy || idle >= 8000) && firstFailure < 0) {
        firstFailure = c;
        console.log(`\n>>> FIRST DEGRADATION at cycle ${c}. Health=${JSON.stringify(h)}, idleMs=${idle}`);
        // keep going a few more cycles to see if it's terminal or transient
      }
    }
  } finally {
    if (doGenerate) restoreDevVault();
  }

  console.log("\n== soak summary ==");
  console.log(`cycles run: ${glCounts.length}`);
  console.log(`GL-canvas count: min=${Math.min(...glCounts)} max=${Math.max(...glCounts)} last=${glCounts[glCounts.length - 1]}`);
  console.log(firstFailure > 0 ? `FIRST DEGRADATION: cycle ${firstFailure}` : `NO DEGRADATION across ${cycles} cycles`);
  process.exit(0);
}

main().catch((err) => {
  console.error("rendererSoak crashed:", err);
  process.exit(1);
});

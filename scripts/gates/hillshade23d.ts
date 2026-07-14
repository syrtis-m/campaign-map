#!/usr/bin/env tsx
// Plan 023-D gate — hillshade + 3D terrain over the generated DEM (plan 023 §4.2).
//
// Live against dev-vault via the obsidian CLI. A fictional campaign's style now
// carries a raster-dem source served by the `campaigndem` custom protocol: raw
// int height lattices (the DURABLE record) cached in .mapcache/dem.jsonl,
// terrarium PNGs encoded at SERVE time only. Determinism gates compare HEIGHTS
// numerically — never PNG bytes (§4.2 DEM-determinism trap).
//
//   (a) alpine mountain → terrain toggle ON (headless twin `setTerrainEnabled`,
//       modal-free): hillshade layer visible + 3D terrain attached (style
//       assertions); toggle OFF restores both;
//   (b) DEM heights over the mountain are non-trivial and BYTE-IDENTICAL across
//       a region regenerate (lattice hash via `demTileReport` — the full
//       protocol resolve path, cache read → compute → append);
//   (c) rm .mapcache/dem.jsonl → regenerates IDENTICALLY (heights compared,
//       cache-delete-harmless quality bar) and the cache file reappears;
//   (d) SEAM: adjacent DEM tiles' cached lattices are continuous across the
//       shared edge (numeric, from the on-disk raw records);
//   (e) explicit-only preserved: pan/zoom with terrain ON never moves
//       generatorRunCount (DEM serving is field evaluation, not procgen);
//   (f) dev:errors clean end-to-end;
//   screenshots → review/: terrain OFF baseline, hillshade ON (relief reads,
//       no tile seams), pitched 3D.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const DEM_ABS = `${FOLDER}/.mapcache/dem.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__h23d_test__";
// Display units (1 unit = 50 m); same fixture geometry as contours23c: inside
// bounds [-48,-36,48,36], clear of the migrated Vespergate district (~[-4.8,6]).
const ALPINE_RING = "[[-40,-30],[-20,-30],[-20,-10],[-40,-10]]";
const ALPINE = "{ terrain: 'alpine', amplitude: 0.85, roughness: 0.6 }";

// Slippy tile coords over the mountain (z=6): lng -40..-20, lat -30..-10.
function tileXY(z: number, lng: number, lat: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}
const Z = 6;
const T1 = tileXY(Z, -30, -20); // mountain center
const T2 = { x: T1.x + 1, y: T1.y }; // east neighbor (ring spans 20° of lng — both overlap relief)

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
/** Runs an async MapView method in-app, parking the result on window.__h23d. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__h23d = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__h23d = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__h23d = { ok: r === undefined ? null : r }; }, function(e){ window.__h23d = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__h23d === undefined ? null : window.__h23d)");
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

interface DemReport {
  res: number;
  min: number;
  max: number;
  nonZero: number;
  hash: string;
}
async function demReport(z: number, x: number, y: number): Promise<DemReport> {
  return (await evalAsync(`function(v){ return v.demTileReport(${z}, ${x}, ${y}); }`)) as DemReport;
}

/** On-disk raw lattice for a tile — the durable record (never PNG bytes). */
function diskLattice(z: number, x: number, y: number): number[] | null {
  if (!existsSync(DEM_ABS)) return null;
  let latest: number[] | null = null;
  for (const line of readFileSync(DEM_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { key: string; heights: number[] };
      if (rec.key === `dem:${z}:${x}:${y}`) latest = rec.heights; // last write wins
    } catch {
      /* skip partial line */
    }
  }
  return latest;
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
  // DEM cache is digest-invalidated + regenerable — a stale file is harmless,
  // but drop it anyway so reruns start clean.
  if (existsSync(DEM_ABS)) rmSync(DEM_ABS);
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 023-D gate (hillshade + 3D terrain) ==\n");

  await gate.try("unit gates: dem lattice/packing + dem cache + hillshade paint + style validation", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/fields/dem.test.ts",
        "src/model/demCache.test.ts",
        "src/map/themes/hillshadeLayer.test.ts",
        "src/map/styleValidation.test.ts",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
  });

  await gate.try("plugin loads (reloaded), no errors, caches clean", () => {
    stripTestFabric();
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    if (existsSync(DEM_ABS)) rmSync(DEM_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration + replay settle)", async () => {
    await issueOpen();
    front();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3500));
  });

  let id = "";
  await gate.try("alpine mountain created (full commit path, contained)", async () => {
    const res = (await evalAsync(
      `function(v){ return v.createRegionForTest(${ALPINE_RING}, 'mountain', ${ALPINE}, '${TEST_NAME}', 'mountain'); }`
    )) as { featureId: string; count: number; outside: number };
    if (res.count < 1) throw new Error("no mountain features generated");
    if (res.outside > 0) throw new Error(`${res.outside} coords outside the ring at creation`);
    id = res.featureId;
  });

  await gate.try("screenshot baseline: terrain OFF (no hillshade)", async () => {
    sync("(function(){v.map.fitBounds([[-44,-34],[-16,-6]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 2500));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.12-terrain-off.png`);
  });

  await gate.try("(a) terrain toggle ON is pitch-adaptive: hillshade top-down, 3D mesh when pitched", async () => {
    const ok = sync("v.setTerrainEnabled(true)") as boolean;
    if (ok !== true) throw new Error("setTerrainEnabled(true) returned falsy");
    if (sync("v.isTerrainEnabled()") !== true) throw new Error("isTerrainEnabled() false after enable");
    // Top-down (pitch 0): 2D shaded relief — hillshade visible, NO mesh (the two
    // never render together; maplibre 4.7.1 misrenders hillshade under a mesh).
    const vis = sync("v.map.getLayoutProperty('hillshade','visibility')");
    if (vis !== "visible") throw new Error(`hillshade visibility after enable at pitch 0: ${String(vis)}`);
    // evalJs auto-parses JSON payloads — re-stringify so the shape check is uniform.
    let terrain = JSON.stringify(sync("JSON.stringify(v.map.getTerrain())"));
    if (terrain !== "null" && terrain !== '"null"') throw new Error(`mesh attached at pitch 0: ${terrain}`);
    // Pitched: the 3D mesh attaches to the campaign DEM and hillshade hides.
    sync("(function(){v.map.easeTo({pitch:60,duration:0});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 800));
    terrain = JSON.stringify(sync("JSON.stringify(v.map.getTerrain())"));
    if (terrain === "null" || terrain === '"null"') throw new Error("map.getTerrain() null after pitching");
    if (!terrain.includes(`dem-${CAMPAIGN}`)) throw new Error(`terrain not on the campaign DEM source: ${terrain}`);
    const visPitched = sync("v.map.getLayoutProperty('hillshade','visibility')");
    if (visPitched !== "none") throw new Error(`hillshade still visible under the 3D mesh: ${String(visPitched)}`);
    // Back to top-down: mesh detaches, hillshade returns.
    sync("(function(){v.map.easeTo({pitch:0,duration:0});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 800));
    terrain = JSON.stringify(sync("JSON.stringify(v.map.getTerrain())"));
    if (terrain !== "null" && terrain !== '"null"') throw new Error(`mesh still attached back at pitch 0: ${terrain}`);
    if (sync("v.map.getLayoutProperty('hillshade','visibility')") !== "visible")
      throw new Error("hillshade did not return at pitch 0");
    console.log("     [a] pitch-adaptive: hillshade at pitch 0, mesh on dem-" + CAMPAIGN + " at pitch 60");
  });

  await gate.try("(b) DEM heights non-trivial + byte-identical across regenerate (hash of raw lattice)", async () => {
    const r1 = await demReport(Z, T1.x, T1.y);
    if (r1.res !== 256) throw new Error(`unexpected lattice res ${r1.res}`);
    if (r1.nonZero < 1000) throw new Error(`DEM over the mountain nearly flat (${r1.nonZero} nonzero of 65536)`);
    if (r1.max < 1000) throw new Error(`DEM max ${r1.max} — vertical scale not applied?`);
    await evalAsync(`function(v){ return v.regenerateRegionById(${JSON.stringify(id)}); }`);
    const r2 = await demReport(Z, T1.x, T1.y);
    if (r2.hash !== r1.hash) throw new Error(`lattice hash drifted across regenerate: ${r1.hash} -> ${r2.hash}`);
    console.log(`     [b] tile ${Z}/${T1.x}/${T1.y}: max ${r1.max}, nonZero ${r1.nonZero}, hash ${r1.hash} (stable)`);
  });

  let baselineHash = "";
  await gate.try("(c) rm dem.jsonl → regenerates IDENTICALLY (heights, not PNGs) + cache reappears", async () => {
    const before = await demReport(Z, T1.x, T1.y);
    baselineHash = before.hash;
    if (!existsSync(DEM_ABS)) throw new Error("dem.jsonl missing before delete test");
    const beforeDisk = diskLattice(Z, T1.x, T1.y);
    if (!beforeDisk) throw new Error("no on-disk lattice record before delete");
    rmSync(DEM_ABS);
    const after = await demReport(Z, T1.x, T1.y);
    if (after.hash !== before.hash) throw new Error(`heights changed after cache delete: ${before.hash} -> ${after.hash}`);
    if (!existsSync(DEM_ABS)) throw new Error("dem.jsonl not recreated by the resolve path");
    const afterDisk = diskLattice(Z, T1.x, T1.y);
    if (!afterDisk) throw new Error("no on-disk lattice record after regenerate");
    if (JSON.stringify(afterDisk) !== JSON.stringify(beforeDisk))
      throw new Error("on-disk raw lattice not byte-identical across cache delete");
    console.log(`     [c] cache delete harmless: ${afterDisk.length} heights byte-identical`);
  });

  await gate.try("(d) SEAM: adjacent DEM tiles continuous across the shared edge (raw records)", async () => {
    await demReport(Z, T2.x, T2.y); // ensure the neighbor is resolved + cached
    const a = diskLattice(Z, T1.x, T1.y);
    const b = diskLattice(Z, T2.x, T2.y);
    if (!a || !b) throw new Error("missing on-disk lattices for seam check");
    const res = Math.sqrt(a.length);
    let worst = 0;
    for (let j = 0; j < res; j++) {
      const east = a[j * res + (res - 1)]; // T1's east edge column
      const west = b[j * res]; // T2's west edge column
      worst = Math.max(worst, Math.abs(east - west));
    }
    // Adjacent pixel centers are ~one pixel of ground apart; the steepest real
    // gradient (rim mask ramp) stays well under 2500 encoded-m per step, while
    // a tile-identity bug jumps by full amplitude (~26 000). Same bound as the
    // unit seam test.
    if (worst >= 2500) throw new Error(`DEM seam discontinuity: worst edge step ${worst}`);
    console.log(`     [d] seam worst edge step ${worst} (continuous)`);
  });

  await gate.try("(e) pan/zoom with terrain ON never generates (explicit-only preserved)", async () => {
    await new Promise((r) => setTimeout(r, 1200));
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-30,-20],zoom:5});v.map.jumpTo({center:[-25,-15],zoom:8});v.map.jumpTo({center:[-30,-20],zoom:6});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
    // And the DEM stayed deterministic under the viewport churn.
    const r = await demReport(Z, T1.x, T1.y);
    if (r.hash !== baselineHash) throw new Error("lattice hash drifted under pan/zoom");
  });

  await gate.try("screenshot: hillshade ON over the alpine massif (relief reads, no seams)", async () => {
    sync("(function(){v.map.fitBounds([[-44,-34],[-16,-6]],{animate:false,padding:40});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 4000)); // let DEM tiles fetch + shade
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.12-hillshade-on.png`);
  });

  await gate.try("screenshot: pitched 3D terrain (mesh + draped relief marks, hillshade auto-hidden)", async () => {
    sync("(function(){v.map.easeTo({pitch:60,bearing:-20,duration:0});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 3000));
    front();
    await new Promise((r) => setTimeout(r, 800));
    screenshot(`${REVIEW}/v4.12-terrain-3d.png`);
  });

  await gate.try("(a′) terrain toggle OFF restores 2D + hides hillshade", async () => {
    sync("(function(){v.map.easeTo({pitch:0,bearing:0,duration:0});return 'ok';})()");
    await new Promise((r) => setTimeout(r, 800));
    const ok = sync("v.setTerrainEnabled(false)") as boolean;
    if (ok !== true) throw new Error("setTerrainEnabled(false) returned falsy");
    if (sync("v.isTerrainEnabled()") !== false) throw new Error("isTerrainEnabled() true after disable");
    const vis = sync("v.map.getLayoutProperty('hillshade','visibility')");
    if (vis !== "none") throw new Error(`hillshade visibility after disable: ${String(vis)}`);
    const terrain = JSON.stringify(sync("JSON.stringify(v.map.getTerrain())"));
    if (terrain !== "null" && terrain !== '"null"') throw new Error(`terrain still attached after disable: ${terrain}`);
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 023-D"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

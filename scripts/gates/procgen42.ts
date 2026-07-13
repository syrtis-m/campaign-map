#!/usr/bin/env tsx
// Procgen v4.3 gate — sketch-driven city CONTENT (plan 020 §6 + §10 v4.3).
//
// Consolidates the distinctive live assertions of the retired disc-era gates
// procgen30 (skeleton + bridge-on-river), procgen31 (dense growth + junction
// histogram), procgen32 (faces/parcels/footprints/wards + one-network-compute)
// and procgen33 (cityness/outskirts/walls/gates) onto the CURRENT contract: a
// single euro-medieval region sketched via createRegionForTest, straddling the
// River Vesper. The pure-pipeline coverage (skeleton math, growth budgets,
// footprint frontage, wall closure…) lives in `npx vitest run` (src/gen/**) —
// this gate only proves that content flows through the live worker + cache +
// paint path and lands correctly inside the sketched polygon. Determinism
// (rm .mapcache → byte-identical replay), explicit-only pan, and remove-city
// live in procgen40; edit/undo/center live in procgen41 — not re-asserted here.
//
//   (a) one whole-region generate costs EXACTLY ONE generator execution (the
//       network compute — per-tile clips reuse it); every emitted coord inside;
//   (b) cached whole-network record carries the full pipeline: streets, blocks,
//       parcels, footprints, wards (districts) + a T-dominant junction histogram
//       (the euro-medieval organic signature);
//   (c) walled-city payoff: wall + gates + a ring road (insetRing) + outskirts
//       fields, and a BRIDGE where an arterial crosses the straddled river;
//   (d) it actually paints: wall + gate + footprint/parcel render live;
//   (e) delete-the-shape lifecycle: removing the district drops its region
//       cache records (the old clearDomainHere analog, now sketch-remove);
//   (f) dev:errors clean; screenshot → review/.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p42_test__";
// Display units (1 unit = 50 m). A river-straddling square in the SE, clear of
// the migrated Vespergate district (bbox maxX ≈ 8.2) — the River Vesper crosses
// it near y≈-1..-2, so a centroid arterial reaching the north edge spans it.
const RING = "[[10,-16],[30,-16],[30,4],[10,4]]"; // center ~[20,-6]
const TEST_POINT: [number, number] = [20, -6];

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
/** Runs an async MapView method in-app, parking the result on window.__p42. */
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p42 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p42 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p42 = { ok: r }; }, function(e){ window.__p42 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p42 === undefined ? null : window.__p42)");
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
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

interface NetStats {
  total: number;
  byType: Record<string, number>;
  byRoad: Record<string, number>;
  T: number;
  X: number;
}
/** Tally the cached whole-network record (`region:<id>:network`) — a file read,
 * robust to a backgrounded window (no queryRenderedFeatures needed). */
function networkStats(regionId: string): NetStats {
  const key = `region:${regionId}:network`;
  if (!existsSync(CACHE_ABS)) throw new Error("no cache file");
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; features: GeoJSON.Feature[] };
    if (rec.key !== key) continue;
    const byType: Record<string, number> = {};
    const byRoad: Record<string, number> = {};
    const degree = new Map<string, number>();
    for (const f of rec.features) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      byType[String(p.type)] = (byType[String(p.type)] ?? 0) + 1;
      if (p.roadClass) byRoad[String(p.roadClass)] = (byRoad[String(p.roadClass)] ?? 0) + 1;
      if (f.geometry.type === "LineString" && p.generatorId === "city-street") {
        const cs = f.geometry.coordinates as [number, number][];
        for (const pt of [cs[0], cs[cs.length - 1]]) {
          const k = `${pt[0]},${pt[1]}`;
          degree.set(k, (degree.get(k) ?? 0) + 1);
        }
      }
    }
    let t = 0;
    let x = 0;
    for (const d of degree.values()) {
      if (d === 3) t++;
      else if (d >= 4) x++;
    }
    return { total: rec.features.length, byType, byRoad, T: t, X: x };
  }
  throw new Error(`no network record for region ${regionId}`);
}
function regionRecordKeys(regionId: string): string[] {
  if (!existsSync(CACHE_ABS)) return [];
  const prefix = `region:${regionId}:`;
  const keys: string[] = [];
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // A concurrent async cache write can truncate the tail line mid-read —
    // skip unparseable lines rather than throwing (the poll retries).
    let rec: { key: string };
    try {
      rec = JSON.parse(line) as { key: string };
    } catch {
      continue;
    }
    if (rec.key.startsWith(prefix)) keys.push(rec.key);
  }
  return keys;
}
/** Strip any leftover gate-test district from Fabric.geojson AND its region
 * cache records (app must be closed → no in-memory/disk race). Keeps the
 * committed Vespergate baseline (migrated district, inert fab-* districts)
 * byte-intact for reruns and the board-run git-clean check. */
function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { id?: string; properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  const removedIds = fabric.features.filter((f) => f.properties?.name === TEST_NAME).map((f) => f.id);
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length === before) return;
  writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
  if (!existsSync(CACHE_ABS)) return;
  const kept = readFileSync(CACHE_ABS, "utf8")
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
  writeFileSync(CACHE_ABS, kept.length ? kept.join("\n") + "\n" : "");
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v4.3 gate — sketch-driven city content ==\n");

  await gate.try("plugin loads (reloaded — picks up the current build), no errors", () => {
    stripTestFabric();
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration + replay settle)", async () => {
    await issueOpen();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 3000));
  });

  let id = "";
  let stats: NetStats | undefined;
  await gate.try("(a) sketch a river-straddling district → ONE generator execution, all coords inside", async () => {
    const before = sync("v.generatorRunCount") as number;
    const res = (await evalAsync(
      `function(v){ return v.createRegionForTest(${RING}, 'city', { profile: 'euro-medieval' }, '${TEST_NAME}'); }`
    )) as { featureId: string; count: number; outside: number };
    id = res.featureId;
    if (res.count < 100) throw new Error(`only ${res.count} features — pipeline didn't populate the district`);
    if (res.outside > 0) throw new Error(`${res.outside} coord(s) fell outside the sketched polygon`);
    const after = sync("v.generatorRunCount") as number;
    if (after - before !== 1) {
      throw new Error(`whole-region generate ran ${after - before} generator executions, expected exactly 1 (one network compute, per-tile clips reuse it)`);
    }
    console.log(`     [a] ${res.count} features, 0 outside, 1 network compute`);
  });

  await gate.try("(b) cached network carries the full pipeline + a T-dominant junction histogram", () => {
    stats = networkStats(id);
    for (const gid of ["street", "block", "parcel", "footprint", "district"]) {
      if (!stats.byType[gid]) throw new Error(`no ${gid} features in the network: ${JSON.stringify(stats.byType)}`);
    }
    if (!(stats.T > 0)) throw new Error("no T-junctions — growth isn't snapping");
    if (!(stats.T > stats.X)) throw new Error(`T=${stats.T} !> X=${stats.X} — not the euro-medieval organic profile`);
    if (!stats.byRoad.alley) throw new Error(`euro-medieval grew no alleys: ${JSON.stringify(stats.byRoad)}`);
    console.log(`     [b] T=${stats.T} X=${stats.X}; types ${JSON.stringify(stats.byType)}`);
  });

  await gate.try("(c) walled-city payoff: wall + gates + ring road + outskirts fields + bridge on the river", () => {
    const s = stats ?? networkStats(id);
    if (!s.byType.wall) throw new Error("no wall (insetRing perimeter) generated");
    if (!s.byType.gate) throw new Error("no gates where arterials cross the wall");
    if (!s.byRoad.ring) throw new Error("no ring road following the wall inset");
    if (!s.byType.field) throw new Error("no outskirts fields at the rim");
    if (!s.byType.bridge) throw new Error("no bridge — an arterial should cross the straddled River Vesper");
    console.log(`     [c] wall ${s.byType.wall}, gate ${s.byType.gate}, ring ${s.byRoad.ring}, field ${s.byType.field}, bridge ${s.byType.bridge}`);
  });

  await gate.try("(d) it paints: wall + gate + footprint/parcel render live", async () => {
    front();
    sync(`(function(){ v.map.fitBounds([[${TEST_POINT[0] - 13},${TEST_POINT[1] - 13}],[${TEST_POINT[0] + 13},${TEST_POINT[1] + 13}]],{animate:false,padding:20}); return 'ok'; })()`);
    await waitFor(() => {
      const out = sync(
        `(function(){ if(!v||!v.map) return '0,0,0'; var w=0,g=0,d=0;
          try { w = v.map.queryRenderedFeatures(undefined,{layers:['generated-landmark']}).filter(function(f){return f.properties.type==='wall';}).length; } catch(e){}
          try { g = v.map.queryRenderedFeatures(undefined,{layers:['generated-gate']}).length; } catch(e){}
          try { d = v.map.queryRenderedFeatures(undefined,{layers:['generated-footprint','generated-parcel']}).length; } catch(e){}
          return w+','+g+','+d; })()`
      );
      const [w, g, d] = String(out).split(",").map(Number);
      return w > 0 && g > 0 && d > 0;
    }, 25000, "rendered wall + gate + footprint/parcel");
  });

  await gate.try("screenshot (Tier B: walled town shaped inside the sketched box, river crossed)", async () => {
    front();
    sync(`(function(){ v.map.fitBounds([[${TEST_POINT[0] - 13},${TEST_POINT[1] - 13}],[${TEST_POINT[0] + 13},${TEST_POINT[1] + 13}]],{animate:false,padding:20}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 2500));
    screenshot(`${REVIEW}/v4.3-vespergate-city-content.png`);
  });

  await gate.try("(e) delete-the-shape drops its region cache records (sketch-remove lifecycle)", async () => {
    if (regionRecordKeys(id).length === 0) throw new Error("no region records to remove before delete");
    const removed = await evalAsync(`function(v){ return v.deleteFabricForTest(${JSON.stringify(id)}); }`);
    if (removed !== true) throw new Error(`deleteFabricForTest returned ${JSON.stringify(removed)}`);
    // The sketch-remove persist + cache drop are async (fire-and-forget in the
    // real handler) — poll for the shape AND its region records to disappear.
    // Reads can race a concurrent write (truncated JSON) — treat a parse error
    // as "not settled yet" and keep polling.
    await waitFor(() => {
      try {
        const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as { features: { id: string }[] };
        return !fabric.features.some((f) => f.id === id) && regionRecordKeys(id).length === 0;
      } catch {
        return false;
      }
    }, 20000, "shape + its region cache records to be dropped");
  });

  await gate.try("(f) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip any residual fixture (app closed → no race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.3 (city content)"));
}

main();

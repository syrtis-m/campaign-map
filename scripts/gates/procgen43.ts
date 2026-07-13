#!/usr/bin/env tsx
// Procgen v4.3 gate — profile signatures + dead-code sweep (plan 020 §6, §10 v4.3).
//
// Modernizes the retired disc-era procgen34 onto the current sketch-driven
// contract: sketch FOUR districts side by side (one per profile) via
// createRegionForTest and assert each profile's signature FLIPS in its cached
// whole-network record — the payoff that the four generators are genuinely
// distinct, not one recolored. Plus the dead-v2-generator sweep procgen34
// carried (the pre-v3 streamline/Voronoi/bisection city generators stay gone).
//
// Signatures (from `region:<id>:network`):
//   euro-medieval : T-junctions dominate 4-ways, has alleys, has a wall
//   na-grid       : 4-ways dominate T-junctions, has alleys, NO wall
//   na-suburb     : has court bulbs, NO wall
//   euro-continental : T-dominant, NO alleys (boulevards, not medieval warren)
//
// Pure per-profile histogram/court/alley math is unit-tested (src/gen/citynet);
// this gate proves the flip survives the live sketch→worker→cache path at a
// realistic region size (~20 display-unit / ~1 km span, matching the old disc
// radii so signatures develop). Determinism/explicit-only live in procgen40.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const REVIEW = "/Users/athena/projects/campaign-map/review";
const TEST_NAME = "__p43_test__";
// Four non-overlapping ~20×20-unit (≈1 km) districts, clear of the migrated
// Vespergate district (bbox ≈ [-17.8,-7 .. 8.2,19]) and of each other.
const REGIONS: Array<{ profile: string; ring: string; at: [number, number] }> = [
  { profile: "euro-medieval", ring: "[[12,-18],[32,-18],[32,2],[12,2]]", at: [22, -8] },
  { profile: "na-grid", ring: "[[12,10],[32,10],[32,30],[12,30]]", at: [22, 20] },
  { profile: "na-suburb", ring: "[[-42,8],[-22,8],[-22,28],[-42,28]]", at: [-32, 18] },
  { profile: "euro-continental", ring: "[[-42,-28],[-22,-28],[-22,-8],[-42,-8]]", at: [-32, -18] },
];

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
async function evalAsync(body: string, timeoutMs = 240000): Promise<unknown> {
  evalJs(`window.__p43 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p43 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p43 = { ok: r }; }, function(e){ window.__p43 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p43 === undefined ? null : window.__p43)");
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
  byType: Record<string, number>;
  byRoad: Record<string, number>;
  T: number;
  X: number;
}
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
    return { byType, byRoad, T: t, X: x };
  }
  throw new Error(`no network record for region ${regionId}`);
}
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
  console.log("== Procgen v4.3 gate — profile signatures + dead-code sweep ==\n");

  await gate.try("dead v2 city generators stay gone (districts.ts / blocks.ts / generateCityStreets)", () => {
    for (const p of ["src/gen/city/districts.ts", "src/gen/city/blocks.ts"]) {
      if (existsSync(p)) throw new Error(`${p} still exists`);
    }
    const cityIndex = readFileSync("src/gen/city/index.ts", "utf8");
    // The barrel may mention the deleted symbols in a doc comment; what must
    // NOT survive is an actual export of them.
    if (/export\s+(function\s+generateCityStreets|\{[^}]*\bgenerateCityStreets\b)/.test(cityIndex)) {
      throw new Error("generateCityStreets still exported from city/index.ts");
    }
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    for (const sym of ["generateDistricts", "generateCityBlocks", "generateCityStreets"]) {
      if (bundle.includes(sym)) throw new Error(`legacy generator ${sym} still reachable in the built bundle`);
    }
  });

  await gate.try("plugin loads (reloaded), no errors", () => {
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

  const ids = new Map<string, string>();
  await gate.try("sketch four districts, one per profile, side by side", async () => {
    for (const r of REGIONS) {
      const res = (await evalAsync(
        `function(v){ return v.createRegionForTest(${r.ring}, 'city', { profile: '${r.profile}' }, '${TEST_NAME}'); }`
      )) as { featureId: string; count: number; outside: number };
      if (res.count < 100) throw new Error(`${r.profile}: only ${res.count} features`);
      if (res.outside > 0) throw new Error(`${r.profile}: ${res.outside} coords outside the polygon`);
      ids.set(r.profile, res.featureId);
    }
  });

  await gate.try("profile signatures flip in the cached networks", () => {
    const s = (p: string): NetStats => networkStats(ids.get(p)!);
    const em = s("euro-medieval");
    if (!(em.T > em.X)) throw new Error(`euro-medieval not T-dominant (T=${em.T}, X=${em.X})`);
    if (!em.byRoad.alley) throw new Error("euro-medieval has no alleys");
    if (!em.byType.wall) throw new Error("euro-medieval grew no wall");

    const ng = s("na-grid");
    if (!(ng.X >= ng.T)) throw new Error(`na-grid not 4-way-dominant (T=${ng.T}, X=${ng.X})`);
    if (!ng.byRoad.alley) throw new Error("na-grid has no alleys");
    if (ng.byType.wall) throw new Error("na-grid grew a wall (NA profiles are unwalled)");

    const ns = s("na-suburb");
    if (!ns.byType.court) throw new Error("na-suburb has no court bulbs");
    if (ns.byType.wall) throw new Error("na-suburb grew a wall (NA profiles are unwalled)");

    const ec = s("euro-continental");
    if (!(ec.T > ec.X)) throw new Error(`euro-continental not T-dominant (T=${ec.T}, X=${ec.X})`);
    if (ec.byRoad.alley) throw new Error("euro-continental grew alleys (should be boulevards, not warren)");

    console.log(
      `     euro-medieval T=${em.T}/X=${em.X} · na-grid T=${ng.T}/X=${ng.X} · na-suburb courts=${ns.byType.court} · euro-continental T=${ec.T}/X=${ec.X}`
    );
  });

  await gate.try("screenshot (Tier B: four genres side by side)", async () => {
    front();
    sync("(function(){ v.map.fitBounds([[-46,-32],[36,32]],{animate:false,padding:12}); return 'ok'; })()");
    await new Promise((r) => setTimeout(r, 3000));
    screenshot(`${REVIEW}/v4.3-four-profiles.png`);
  });

  await gate.try("dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean every fixture (app closed → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Procgen v4.3 (profiles)"));
}

main();

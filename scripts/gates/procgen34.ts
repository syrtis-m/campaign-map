#!/usr/bin/env tsx
// Procgen v3.4 gate — remaining profiles + cleanup (design §9, v3.4).
//
// Live half: founds FOUR domains side by side in Vespergate (one per
// profile), asserts each profile's signature from the cached whole-network
// records (na-grid: 4-way ≥ T; na-suburb: courts present; euro profiles:
// alleys/rings per §6), replays the whole four-city manifest byte-identically
// after a cache delete, screenshots the four cities together, and clears.
// The "all prior gates green + npm test + test:app" sweep runs as separate
// commands after this gate (see PROGRESS.md v3.4 checklist) — one process
// per gate, to sidestep the known long-session renderer degradation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const CACHE_REL = "Campaigns/Vespergate/.mapcache/generated.jsonl";
const CACHE_ABS = `dev-vault/${CACHE_REL}`;
const MANIFEST_ABS = "dev-vault/Campaigns/Vespergate/Generated.json";
// Display units (1 unit = 50 m). Four non-overlapping discs in the 4.8x3.6 km map.
// na-grid sits on sketch-free ground: Vespergate's NE corner carries a
// sketched road + the bay, whose immutable pre-seeded edges legitimately
// jog a grid (real NA grids jog at old roads too) — but the signature
// check wants the clean flip, so the grid city gets open land.
const DOMAINS: Array<{ profile: string; at: [number, number]; radius: number }> = [
  { profile: "euro-medieval", at: [0, 2], radius: 500 },
  { profile: "na-grid", at: [12, 24], radius: 550 },
  { profile: "na-suburb", at: [-28, 20], radius: 450 },
  { profile: "euro-continental", at: [28, -20], radius: 450 },
];
const DOMAIN_GIDS = ["city-network", "city-street", "city-block", "city-parcel", "city-footprint", "city-landmark", "city-district"];

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
    if (out.includes("Executed")) break;
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
  evalJs(`window.__p34 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p34 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p34 = { ok: r }; }, function(e){ window.__p34 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p34 === undefined ? null : window.__p34)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}

interface NetRecord {
  key: string;
  features: Array<GeoJSON.Feature>;
}

function networksByDomain(): Map<string, GeoJSON.Feature[]> {
  const out = new Map<string, GeoJSON.Feature[]>();
  if (!existsSync(CACHE_ABS)) return out;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as NetRecord & { generatorId: string };
    if (rec.generatorId !== "city-network") continue;
    const domainId = (rec.features[0]?.properties as Record<string, unknown> | undefined)?.domainId as string | undefined;
    if (domainId) out.set(domainId, rec.features);
  }
  return out;
}

function domainRecords(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CACHE_ABS)) return out;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; generatorId: string; features: unknown };
    if (DOMAIN_GIDS.includes(rec.generatorId)) out.set(rec.key, JSON.stringify(rec.features));
  }
  return out;
}

/** Endpoint-coincidence degree histogram over one network's streets. */
function histogram(net: GeoJSON.Feature[]): { t: number; x: number } {
  const degree = new Map<string, number>();
  for (const f of net) {
    if (f.geometry.type !== "LineString") continue;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    if (props.generatorId !== "city-street") continue;
    const coords = f.geometry.coordinates as [number, number][];
    for (const pt of [coords[0], coords[coords.length - 1]]) {
      const k = `${pt[0]},${pt[1]}`;
      degree.set(k, (degree.get(k) ?? 0) + 1);
    }
  }
  let t = 0;
  let x = 0;
  for (const d of degree.values()) {
    if (d === 3) t++;
    else if (d >= 4) x++;
  }
  return { t, x };
}

function countType(net: GeoJSON.Feature[], type: string): number {
  return net.filter((f) => (f.properties as Record<string, unknown>)?.type === type).length;
}
function countRoadClass(net: GeoJSON.Feature[], rc: string): number {
  return net.filter((f) => (f.properties as Record<string, unknown>)?.roadClass === rc).length;
}

function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v3.4 gate (all profiles + cleanup) ==\n");

  await gate.try("unit gates: per-profile histograms/courts/alleys/fuzz/budgets + corridor survivals", () => {
    execFileSync("npx", ["vitest", "run", "src/gen"], { encoding: "utf8", stdio: "pipe", timeout: 900_000 });
  });

  await gate.try("dead v2 generators are gone (districts.ts, blocks.ts, ambient streets)", () => {
    for (const p of ["src/gen/city/districts.ts", "src/gen/city/blocks.ts"]) {
      if (existsSync(p)) throw new Error(`${p} still exists`);
    }
    const cityIndex = readFileSync("src/gen/city/index.ts", "utf8");
    if (cityIndex.includes("export function generateCityStreets")) {
      throw new Error("generateCityStreets still exported from city/index.ts");
    }
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    if (bundle.includes("generateDistricts") || bundle.includes("generateCityBlocks")) {
      throw new Error("legacy generators still reachable in the built bundle");
    }
  });

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens", async () => {
    await issueOpen();
    await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
    await new Promise((r) => setTimeout(r, 2000));
  });

  await gate.try("clean slate", async () => {
    await evalAsync("function(v){ return v.clearAllGenerated(); }");
  });

  await gate.try("four profiles found four cities side by side", async () => {
    for (const d of DOMAINS) {
      evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${d.at[0]},${d.at[1]}], zoom:9}); return 'ok'; })()`);
      const n = await evalAsync(
        `function(v){ return v.generateFabricHere([${d.at[0]},${d.at[1]}], { domainChoice: { profile: '${d.profile}', radius: ${d.radius} } }).then(function(f){ return f.length; }); }`
      );
      if (typeof n !== "number" || n < 100) throw new Error(`${d.profile}: only ${n} features`);
    }
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.domains ?? []).length !== 4) throw new Error(`expected 4 domains, got ${(manifest.domains ?? []).length}`);
  });

  const nets = new Map<string, GeoJSON.Feature[]>();
  await gate.try("profile signatures flip (from cached networks)", () => {
    const byDomain = networksByDomain();
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    for (const d of DOMAINS) {
      const dom = (manifest.domains as Array<{ id: string; profile: string }>).find((m) => m.profile === d.profile);
      if (!dom) throw new Error(`no manifest domain for ${d.profile}`);
      const net = byDomain.get(dom.id);
      if (!net) throw new Error(`no cached network for ${d.profile}`);
      nets.set(d.profile, net);
    }
    const em = histogram(nets.get("euro-medieval")!);
    if (em.t <= em.x) throw new Error(`euro-medieval not T-dominant (T=${em.t}, X=${em.x})`);
    const ng = histogram(nets.get("na-grid")!);
    if (ng.x < ng.t) throw new Error(`na-grid not 4-way-dominant (T=${ng.t}, X=${ng.x})`);
    if (countType(nets.get("na-suburb")!, "court") < 1) throw new Error("na-suburb has no court bulbs");
    if (countRoadClass(nets.get("euro-medieval")!, "alley") < 1) throw new Error("euro-medieval has no alleys");
    if (countRoadClass(nets.get("na-grid")!, "alley") < 1) throw new Error("na-grid has no alleys");
    if (countRoadClass(nets.get("euro-continental")!, "alley") > 0) throw new Error("euro-continental grew alleys");
    if (countType(nets.get("na-grid")!, "wall") > 0 || countType(nets.get("na-suburb")!, "wall") > 0) {
      throw new Error("NA profile grew a wall");
    }
  });

  await gate.try("determinism: delete .mapcache → replay of all four cities → byte-identical", async () => {
    const before = domainRecords();
    if (before.size === 0) throw new Error("no domain records before delete");
    rmSync(CACHE_ABS);
    await issueOpen();
    await waitFor(() => {
      const now = domainRecords();
      return [...before.keys()].every((k) => now.has(k));
    }, 240000, "replay to rewrite all four domains' records");
    const after = domainRecords();
    for (const [key, features] of before) {
      if (after.get(key) !== features) {
        throw new Error(`record ${key} differs after cache delete + replay — determinism broke (release blocker)`);
      }
    }
  });

  await gate.try("explicit-only: pan/zoom never generates", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const before = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[28,20], zoom:11}); v.map.jumpTo({center:[-28,20], zoom:6}); v.map.jumpTo({center:[0,2], zoom:9}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshots (Tier B: four genres side by side + per-profile closeups)", async () => {
    front();
    evalJs(`(function(){ var v=${viewExpr()}; v.map.fitBounds([[-46,-34],[46,34]],{animate:false,padding:10}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 3000));
    screenshot("/Users/athena/projects/campaign-map/review/v3.4-vespergate-four-profiles.png");
    for (const d of DOMAINS.slice(1)) {
      evalJs(
        `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${d.at[0] - 10},${d.at[1] - 9}],[${d.at[0] + 10},${d.at[1] + 9}]],{animate:false,padding:10}); return 'ok'; })()`
      );
      await new Promise((r) => setTimeout(r, 2500));
      screenshot(`/Users/athena/projects/campaign-map/review/v3.4-${d.profile}.png`);
    }
  });

  await gate.try("clear all four (fixture left clean)", async () => {
    await evalAsync("function(v){ return v.clearAllGenerated(); }");
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.entries ?? []).length !== 0 || (manifest.domains ?? []).length !== 0) {
      throw new Error("manifest not empty after clear-all");
    }
    if (domainRecords().size !== 0) throw new Error("domain cache records survived clear-all");
  });

  await gate.try("dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  process.exit(gate.summarize("Procgen v3.4"));
}

main();

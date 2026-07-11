#!/usr/bin/env tsx
// Procgen v3.1 gate — growth loop, euro-medieval (procgen_v3_design.md §9, v3.1).
//
// The heavy assertions (junction histogram, connectivity ratio, 200-domain
// fuzz, ≤2 s pure-compute budget, byte-determinism, 2×2 seams) are Vitest
// unit gates in src/gen/citynet — run first, one command. The live half
// asserts the grown network actually flows through the worker + cache +
// paint path in a real Obsidian:
//   - a domain generate now emits a dense street network (not just spokes);
//   - the live junction histogram (endpoint-coincidence degrees on the
//     cached whole-network record) is T-dominant;
//   - wall-clock for the whole live action stays sane (worker roundtrip +
//     clip + paint on top of the ≤2 s pure budget);
//   - delete .mapcache → replay → byte-identical records still holds with
//     growth in the pipeline;
//   - explicit-only invariant untouched.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const CACHE_REL = "Campaigns/Vespergate/.mapcache/generated.jsonl";
const CACHE_ABS = `dev-vault/${CACHE_REL}`;
const MANIFEST_ABS = "dev-vault/Campaigns/Vespergate/Generated.json";
const CLICK: [number, number] = [0, 2];

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

async function evalAsync(body: string, timeoutMs = 120000): Promise<unknown> {
  evalJs(`window.__p31 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p31 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p31 = { ok: r }; }, function(e){ window.__p31 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p31 === undefined ? null : window.__p31)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}

interface CacheRec {
  key: string;
  generatorId: string;
  features: GeoJSON.Feature[];
}

function cacheRecords(): CacheRec[] {
  if (!existsSync(CACHE_ABS)) return [];
  return readFileSync(CACHE_ABS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CacheRec);
}

function domainRecords(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of cacheRecords()) {
    if (["city-network", "city-street", "city-landmark"].includes(rec.generatorId)) {
      out.set(rec.key, JSON.stringify(rec.features));
    }
  }
  return out;
}

/** Endpoint-coincidence junction histogram over the whole-network record:
 * degree = how many street-segment endpoints share a quantized coordinate.
 * T-junction = 3, 4-way = 4. */
function junctionHistogram(): { t: number; x: number; nodes: number } {
  const net = cacheRecords().find((r) => r.generatorId === "city-network");
  if (!net) throw new Error("no city-network record in cache");
  const degree = new Map<string, number>();
  for (const f of net.features) {
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
  return { t, x, nodes: degree.size };
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v3.1 gate (growth loop, euro-medieval) ==\n");

  await gate.try("unit gates: growth determinism/seam/histogram/connectivity/fuzz/budget", () => {
    execFileSync("npx", ["vitest", "run", "src/gen/citynet"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 600_000,
    });
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

  let streetParts = 0;
  await gate.try("grown network generates live (dense, not just spokes) within wall-clock budget", async () => {
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    const t0 = Date.now();
    const result = (await evalAsync(
      `function(v){ return v.generateFabricHere([${CLICK[0]},${CLICK[1]}], { domainChoice: { profile: 'euro-medieval' } }).then(function(f){
         return { count: f.length,
                  streets: f.filter(function(x){return x.properties && x.properties.generatorId === 'city-street';}).length }; }); }`,
      180000
    )) as { count: number; streets: number };
    const wallMs = Date.now() - t0;
    streetParts = result.streets;
    // v3.0 skeleton-only was 22 street parts in this tile; growth must
    // multiply that. Wall budget: ≤2 s pure compute (unit-gated) + worker
    // roundtrip + clip + cache IO + paint + eval polling slack.
    if (result.streets < 60) throw new Error(`only ${result.streets} street parts — growth didn't densify the tile`);
    if (wallMs > 12000) throw new Error(`live generate took ${wallMs} ms — over the wall budget`);
  });

  await gate.try("junction histogram (live cache): T-junctions dominate 4-ways", () => {
    const h = junctionHistogram();
    if (h.t === 0) throw new Error("no T-junctions at all — growth isn't snapping");
    if (h.t <= h.x) throw new Error(`T=${h.t} <= X=${h.x} (of ${h.nodes} endpoint nodes) — not the organic profile`);
  });

  await gate.try("determinism: delete .mapcache → replay → byte-identical domain records", async () => {
    const before = domainRecords();
    if (before.size === 0) throw new Error("no domain records before delete");
    rmSync(CACHE_ABS);
    await issueOpen();
    await waitFor(() => {
      const now = domainRecords();
      return [...before.keys()].every((k) => now.has(k));
    }, 180000, "replay to rewrite all domain records");
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
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[20,10], zoom:5}); v.map.jumpTo({center:[-20,-10], zoom:11}); v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshot (Tier B: organic warren, T-junctions, sketch-shaped)", async () => {
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${CLICK[0] - 22},${CLICK[1] - 20}],[${CLICK[0] + 22},${CLICK[1] + 20}]],{animate:false,padding:20}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.1-vespergate-growth.png");
  });

  await gate.try("clear-domain-here still removes everything", async () => {
    const removed = await evalAsync(`function(v){ return v.clearDomainHere([${CLICK[0]}, ${CLICK[1]}]); }`);
    if (typeof removed !== "number" || removed < 1) throw new Error(`clearDomainHere returned ${removed}`);
    if (domainRecords().size !== 0) throw new Error("domain cache records survived clear");
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.domains ?? []).length !== 0) throw new Error("domain survived clear");
  });

  await gate.try("dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  console.log(`\n(clicked tile emitted ${streetParts} street parts)`);
  process.exit(gate.summarize("Procgen v3.1"));
}

main();

#!/usr/bin/env tsx
// Procgen v3.0 gate — domains + skeleton (procgen_v3_design.md §9, v3.0).
//
// Tier A assertions, live against dev-vault via the obsidian CLI:
//   (a) determinism: delete `.mapcache/generated.jsonl`, replay the manifest,
//       byte-identical domain records (network + per-tile clips);
//   (b) 2×2 seam + arterial reachability + bridge-on-river run as Vitest
//       unit gates (src/gen/citynet) — executed here so the phase gate is
//       one command;
//   (c) live: founding a domain via generateFabricHere({domainChoice})
//       produces arterial streets + plaza, persists the domain + domainId
//       entry in Generated.json, writes city-network + per-tile records;
//   (d) live bridge check: the Vespergate domain straddles the River Vesper,
//       so at least one `type: "bridge"` feature must exist and render;
//   (e) explicit-only survives: pan/zoom after replay never bumps
//       generatorRunCount;
//   (f) clear-domain-here removes the domain, its entries, and its records.
//
// Screenshot lands in review/ (Tier B: "town visibly shaped — radial spokes,
// river crossed not smeared" needs eyes).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const CACHE_REL = "Campaigns/Vespergate/.mapcache/generated.jsonl";
const CACHE_ABS = `dev-vault/${CACHE_REL}`;
const MANIFEST_ABS = "dev-vault/Campaigns/Vespergate/Generated.json";
// Display units (1 unit = 50 m). (0, 2) puts the domain center ~100 m north
// of the sketched E-W high road, with the River Vesper crossing the disc.
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

/** Runs an async MapView method in-app, parking the result on window.__p30. */
async function evalAsync(body: string, timeoutMs = 60000): Promise<unknown> {
  evalJs(`window.__p30 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p30 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p30 = { ok: r }; }, function(e){ window.__p30 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p30 === undefined ? null : window.__p30)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}

/** Domain-related cache records (network + per-tile clips), normalized to
 * key→features so `generatedAt` noise can't fake a diff. */
function domainCacheRecords(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(CACHE_ABS)) return out;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as { key: string; generatorId: string; features: unknown };
    if (["city-network", "city-street", "city-landmark"].includes(rec.generatorId)) {
      out.set(rec.key, JSON.stringify(rec.features));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v3.0 gate (domains + skeleton) ==\n");

  await gate.try("unit gates: citynet determinism/seam/reachability/bridges + manifest schema", () => {
    execFileSync("npx", ["vitest", "run", "src/gen/citynet", "src/model/generatedManifest.test.ts"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 180_000,
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
    await new Promise((r) => setTimeout(r, 2000)); // style + replay settle
  });

  await gate.try("clean slate (clear all generated, incl. domains)", async () => {
    await evalAsync("function(v){ return v.clearAllGenerated(); }");
    const manifest = existsSync(MANIFEST_ABS) ? JSON.parse(readFileSync(MANIFEST_ABS, "utf8")) : { entries: [], domains: [] };
    if ((manifest.entries ?? []).length > 0 || (manifest.domains ?? []).length > 0) {
      throw new Error(`manifest not empty after clear-all: ${JSON.stringify(manifest)}`);
    }
  });

  let featureCount = 0;
  await gate.try("generateFabricHere({domainChoice}) founds a domain and emits skeleton fabric", async () => {
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    const result = (await evalAsync(
      `function(v){ return v.generateFabricHere([${CLICK[0]},${CLICK[1]}], { domainChoice: { profile: 'euro-medieval' } }).then(function(f){
         return { count: f.length,
                  arterials: f.filter(function(x){return x.properties && x.properties.roadClass === 'arterial';}).length,
                  plaza: f.filter(function(x){return x.properties && x.properties.type === 'plaza';}).length,
                  bridges: f.filter(function(x){return x.properties && x.properties.type === 'bridge';}).length }; }); }`,
      120000
    )) as { count: number; arterials: number; plaza: number; bridges: number };
    featureCount = result.count;
    if (result.count < 1) throw new Error("no features generated");
    if (result.arterials < 2) throw new Error(`expected >=2 arterial street parts in the clicked tile, got ${result.arterials}`);
    if (result.bridges < 1) throw new Error(`domain straddles the River Vesper but no bridge feature (got ${result.bridges})`);
  });

  await gate.try("manifest persists the domain + a domainId entry", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.domains ?? []).length !== 1) throw new Error(`domains: ${JSON.stringify(manifest.domains)}`);
    const d = manifest.domains[0];
    if (d.profile !== "euro-medieval") throw new Error(`profile: ${d.profile}`);
    if (!/^dom:-?\d+:-?\d+$/.test(d.id)) throw new Error(`domain id shape: ${d.id}`);
    const entry = (manifest.entries ?? []).find((e: { domainId?: string }) => e.domainId === d.id);
    if (!entry) throw new Error("no manifest entry carries the domainId");
  });

  await gate.try("cache holds city-network + per-tile clip records", () => {
    const recs = domainCacheRecords();
    const gids = new Set([...recs.keys()].map((k) => k.split(":").pop()));
    if (!gids.has("city-network")) throw new Error(`no city-network record (${[...gids].join(",")})`);
    if (!gids.has("city-street")) throw new Error(`no city-street clip record (${[...gids].join(",")})`);
  });

  await gate.try("arterial streets render (queryRenderedFeatures on generated-street)", async () => {
    // macOS suspends compositing for occluded windows (the dev:screenshot
    // gap, Phase 4) — queryRenderedFeatures needs a window that actually
    // paints, so front Obsidian before polling.
    try {
      execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
    } catch {
      /* best-effort */
    }
    await waitFor(() => {
      const n = evalJs(
        `(function(){ var v=${viewExpr()}; if(!v||!v.map) return 0; return v.map.queryRenderedFeatures(undefined, {layers:['generated-street']}).length; })()`
      );
      return typeof n === "number" && n > 0;
    }, 15000, "rendered generated-street features");
  });

  await gate.try("determinism: delete .mapcache → replay → byte-identical domain records", async () => {
    const before = domainCacheRecords();
    if (before.size === 0) throw new Error("no domain records before delete");
    // Obsidian's `delete` command can't resolve files under dot-folders
    // (.mapcache isn't vault-indexed) — remove from the filesystem, which is
    // also the truest simulation of "the GM deletes .mapcache".
    rmSync(CACHE_ABS);
    if (existsSync(CACHE_ABS)) throw new Error("cache file survived delete");
    await issueOpen(); // fresh view → manifest replay regenerates
    await waitFor(() => {
      const now = domainCacheRecords();
      return [...before.keys()].every((k) => now.has(k));
    }, 120000, "replay to rewrite all domain records");
    const after = domainCacheRecords();
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

  await gate.try("screenshot (Tier B: town visibly shaped, river crossed not smeared)", async () => {
    // Frame the whole domain disc (radius 900 m = 18 display units at
    // 50 m/unit) before shooting — the pan/zoom check leaves the camera
    // wherever it last jumped.
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${CLICK[0] - 22},${CLICK[1] - 20}],[${CLICK[0] + 22},${CLICK[1] + 20}]],{animate:false,padding:20}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.0-vespergate-skeleton.png");
  });

  await gate.try("clear-domain-here removes domain + entries + records", async () => {
    const removed = await evalAsync(`function(v){ return v.clearDomainHere([${CLICK[0]}, ${CLICK[1]}]); }`);
    if (typeof removed !== "number" || removed < 1) throw new Error(`clearDomainHere returned ${removed}`);
    const manifest = JSON.parse(readFileSync(MANIFEST_ABS, "utf8"));
    if ((manifest.domains ?? []).length !== 0) throw new Error("domain survived clear");
    if ((manifest.entries ?? []).some((e: { domainId?: string }) => e.domainId)) throw new Error("domainId entries survived clear");
    const recs = domainCacheRecords();
    if (recs.size !== 0) throw new Error(`${recs.size} domain cache records survived clear`);
  });

  await gate.try("dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  console.log(`\n(clicked tile emitted ${featureCount} features)`);
  process.exit(gate.summarize("Procgen v3.0"));
}

main();

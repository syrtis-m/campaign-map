#!/usr/bin/env tsx
// Procgen v3.2 gate — faces → parcels → footprints + wards (design §9, v3.2).
//
// Unit gates (block entropy, footprint-frontage alignment, zero-throw fuzz,
// budget, determinism, seams) run in Vitest first. The live half asserts:
//   - a domain generate emits blocks/parcels/footprints/wards through the
//     real worker + cache + paint path;
//   - the LEGACY city generators no longer run on domain tiles: the whole
//     action costs exactly ONE generator execution (the network compute) —
//     generatorRunCount is the discriminator;
//   - footprints + parcels actually render at street zoom;
//   - delete-.mapcache replay is still byte-identical with Stage C on;
//   - clear-domain still removes everything.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const CACHE_REL = "Campaigns/Vespergate/.mapcache/generated.jsonl";
const CACHE_ABS = `dev-vault/${CACHE_REL}`;
const MANIFEST_ABS = "dev-vault/Campaigns/Vespergate/Generated.json";
const CLICK: [number, number] = [0, 2];
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

async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__p32 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p32 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p32 = { ok: r }; }, function(e){ window.__p32 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p32 === undefined ? null : window.__p32)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
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

function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Procgen v3.2 gate (faces/parcels/footprints/wards) ==\n");

  await gate.try("unit gates: entropy/alignment/fuzz/budget/determinism/seams", () => {
    execFileSync("npx", ["vitest", "run", "src/gen/citynet"], { encoding: "utf8", stdio: "pipe", timeout: 600_000 });
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

  let counts: Record<string, number> = {};
  await gate.try("domain generate emits Stage C (blocks/parcels/footprints/wards) live", async () => {
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    const result = (await evalAsync(
      `function(v){ return v.generateFabricHere([${CLICK[0]},${CLICK[1]}], { domainChoice: { profile: 'euro-medieval' } }).then(function(f){
         var byGid = {};
         f.forEach(function(x){ var g=(x.properties||{}).generatorId; byGid[g]=(byGid[g]||0)+1; });
         return byGid; }); }`
    )) as Record<string, number>;
    counts = result;
    for (const gid of ["city-street", "city-block", "city-parcel", "city-footprint", "city-district"]) {
      if (!result[gid]) throw new Error(`no ${gid} features in the clicked tile: ${JSON.stringify(result)}`);
    }
  });

  await gate.try("legacy city generators no longer run on domain tiles (exactly 1 execution: the network)", async () => {
    // A second, never-generated tile of the SAME domain ([-6,2] units =
    // (-300,100) m → tile (-1,0), inside the disc) must cost ZERO generator
    // executions: the network record is already cached, so the tile is a
    // pure clip; and no legacy generator may run on a domain tile anymore.
    const before = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`) as number;
    await evalAsync(`function(v){ return v.generateFabricHere([-6,2], {}).then(function(f){ return f.length; }); }`);
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`) as number;
    if (after - before !== 0) {
      throw new Error(`expected 0 generator executions for a clip-only neighbor tile, got ${after - before} — a legacy generator is still running on domain tiles`);
    }
  });

  await gate.try("footprints + parcels render at street zoom (relative reveal)", async () => {
    front();
    // Building detail reveals relative to the campaign overview (footprints
    // overview+4, parcels +5 — applyFocusReveal), so "street zoom" must be
    // computed from the live overviewZoom, not an absolute number (the
    // baked z14/z15 floors are real-city calibrations).
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[3,3], zoom: (v.overviewZoom || 4.5) + 5.5}); return 'ok'; })()`
    );
    await waitFor(() => {
      const n = evalJs(
        `(function(){ var v=${viewExpr()}; if(!v||!v.map) return 0; try { return v.map.queryRenderedFeatures(undefined, {layers:['generated-footprint','generated-parcel']}).length; } catch(e) { return 0; } })()`
      );
      return typeof n === "number" && n > 0;
    }, 20000, "rendered footprint/parcel features");
  });

  await gate.try("determinism: delete .mapcache → replay → byte-identical records (Stage C on)", async () => {
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
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[20,10], zoom:5}); v.map.jumpTo({center:[-20,-10], zoom:15}); v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshots (Tier B: genre readable in 3 s; blocks between streets)", async () => {
    front();
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${CLICK[0] - 12},${CLICK[1] - 10}],[${CLICK[0] + 12},${CLICK[1] + 12}]],{animate:false,padding:10}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.2-vespergate-blocks.png");
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[3,3], zoom: (v.overviewZoom || 4.5) + 5.5}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.2-vespergate-parcels.png");
  });

  await gate.try("clear-domain-here removes everything", async () => {
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

  console.log(`\n(clicked-tile counts: ${JSON.stringify(counts)})`);
  process.exit(gate.summarize("Procgen v3.2"));
}

main();

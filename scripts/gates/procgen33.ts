#!/usr/bin/env tsx
// Procgen v3.3 gate — cityness, outskirts, walls/gates, landmarks (design §9, v3.3).
//
// Unit gates (monotonic ring density, ribbon placement, wall closure, gates
// on arterials, fuzz, budget, determinism, seams) run in Vitest. Live half:
// the euro-medieval Vespergate domain emits wall/gates/ring/fields through
// the real pipeline, they render, replay determinism still holds, and the
// screenshots capture the outskirts ribbon for Tier B review.
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
  evalJs(`window.__p33 = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__p33 = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__p33 = { ok: r }; }, function(e){ window.__p33 = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__p33 === undefined ? null : window.__p33)");
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
  console.log("== Procgen v3.3 gate (cityness/outskirts/walls/gates) ==\n");

  await gate.try("unit gates: density/ribbon/wall-closure/gates-on-arterials/fuzz/budget", () => {
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

  let byType: Record<string, number> = {};
  await gate.try("domain generate emits wall/gates/ring/fields live", async () => {
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    const result = (await evalAsync(
      `function(v){ return v.generateFabricHere([${CLICK[0]},${CLICK[1]}], { domainChoice: { profile: 'euro-medieval' } }).then(function(f){
         var byType = {};
         f.forEach(function(x){ var p=x.properties||{}; var k=p.type; byType[k]=(byType[k]||0)+1;
           if (p.roadClass==='ring') byType['(ring)']=(byType['(ring)']||0)+1; });
         return byType; }); }`
    )) as Record<string, number>;
    byType = result;
    for (const t of ["wall", "gate", "field", "(ring)"]) {
      if (!result[t]) throw new Error(`no ${t} features: ${JSON.stringify(result)}`);
    }
  });

  await gate.try("wall + gates render", async () => {
    front();
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${CLICK[0] - 22},${CLICK[1] - 20}],[${CLICK[0] + 22},${CLICK[1] + 20}]],{animate:false,padding:20}); return 'ok'; })()`
    );
    await waitFor(() => {
      const out = evalJs(
        `(function(){ var v=${viewExpr()}; if(!v||!v.map) return '0,0';
           var w=0,g=0;
           try { w = v.map.queryRenderedFeatures(undefined, {layers:['generated-landmark']}).filter(function(f){return f.properties.type==='wall';}).length; } catch(e) {}
           try { g = v.map.queryRenderedFeatures(undefined, {layers:['generated-gate']}).length; } catch(e) {}
           return w + ',' + g; })()`
      );
      const [w, g] = String(out).split(",").map(Number);
      return w > 0 && g > 0;
    }, 20000, "rendered wall + gate features");
  });

  await gate.try("determinism: delete .mapcache → replay → byte-identical records", async () => {
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
    evalJs(`(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[20,10], zoom:5}); v.map.jumpTo({center:[-20,-10], zoom:12}); v.map.jumpTo({center:[${CLICK[0]},${CLICK[1]}], zoom:9}); return 'ok'; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = evalJs(`(function(){ var v=${viewExpr()}; return v.generatorRunCount; })()`);
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
  });

  await gate.try("screenshots (Tier B: ribbon along arterials, wall closes, fields at rim)", async () => {
    front();
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.fitBounds([[${CLICK[0] - 22},${CLICK[1] - 20}],[${CLICK[0] + 22},${CLICK[1] + 20}]],{animate:false,padding:20}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.3-vespergate-walls-outskirts.png");
    // Rim close-up: outskirts ribbon + fields along a southern arterial.
    evalJs(
      `(function(){ var v=${viewExpr()}; v.map.jumpTo({center:[${CLICK[0] - 2},${CLICK[1] - 13}], zoom: (v.overviewZoom || 4.5) + 4.5}); return 'ok'; })()`
    );
    await new Promise((r) => setTimeout(r, 2500));
    screenshot("/Users/athena/projects/campaign-map/review/v3.3-vespergate-ribbon.png");
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

  console.log(`\n(feature types: ${JSON.stringify(byType)})`);
  process.exit(gate.summarize("Procgen v3.3"));
}

main();

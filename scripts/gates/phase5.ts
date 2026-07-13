#!/usr/bin/env tsx
// Phase 5 Tier A gate — keepsakes & force multipliers (docs/03 Phase 5).
// Covers what unit tests can't: the live export pipelines (poster PNG, atlas
// PDF) actually writing files to the vault, the point-crawl/session/connection
// render layers being present, and the replay/populate/import command surfaces
// existing and running without renderer errors. Pure logic (parsers, the
// populate/import mappers, the atlas text-wrap) is unit-tested in src/**.
// Same evalJs double-encoding + screenshot-activation rules as phase3/phase4.
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "ashfall";

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

function ashfallView(): string {
  // returns a JS expression evaluating to the live Ashfall MapView
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;
}

async function openAshfall() {
  resetLeaves();
  // per-campaign commands register async on load; retry the open a few times.
  // phase5 runs right after phase4's full-app-reload step on the board — the
  // reloaded app can still be settling, so be patient (the style-load LATENCY
  // bar lives in the styleLoad gate, not here) and re-issue the open if the
  // view never materialized.
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    if (out.includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (let i = 0; i < 30; i++) {
    const state = evalJs(`(function(){var v=${ashfallView()};if(!v)return 'no-view';if(!v.map)return 'no-map';return v.map.isStyleLoaded()?'ready':'loading';})()`);
    if (state === "ready") return;
    if (state === "no-view" && i > 0 && i % 5 === 0) {
      obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Count files with `ext` in `<campaign>/Exports/`, resolved via the adapter. */
function exportsCount(ext: string): Promise<number> {
  return evalJs(`(async function(){
    var v = ${ashfallView()};
    var dir = v.campaign.path.slice(0, v.campaign.path.lastIndexOf('/')) + '/Exports';
    var has = await app.vault.adapter.exists(dir);
    if (!has) return 0;
    var listed = await app.vault.adapter.list(dir);
    return (listed.files || []).filter(function(f){ return f.toLowerCase().endsWith('.${ext}'); }).length;
  })()`) as unknown as Promise<number>;
}

/** Full file list of `<campaign>/Exports/` (vault-relative paths). */
async function listExports(): Promise<string[]> {
  const result = await (evalJs(`(async function(){
    var v = ${ashfallView()};
    var dir = v.campaign.path.slice(0, v.campaign.path.lastIndexOf('/')) + '/Exports';
    var has = await app.vault.adapter.exists(dir);
    if (!has) return JSON.stringify([]);
    var listed = await app.vault.adapter.list(dir);
    return JSON.stringify(listed.files || []);
  })()`) as unknown as Promise<unknown>);
  return typeof result === "string" ? JSON.parse(result) : (result as string[]);
}

/** Remove every Exports/ file not in `baseline` — the gate's own artifacts.
 * Committed fixture exports stay byte-intact (board hygiene rule, 021 §2.4b). */
async function removeNewExports(baseline: string[]): Promise<number> {
  const result = await (evalJs(`(async function(){
    var v = ${ashfallView()};
    var dir = v.campaign.path.slice(0, v.campaign.path.lastIndexOf('/')) + '/Exports';
    var keep = ${JSON.stringify(baseline)};
    var has = await app.vault.adapter.exists(dir);
    if (!has) return 0;
    var listed = await app.vault.adapter.list(dir);
    var files = listed.files || [];
    var removed = 0;
    for (var i = 0; i < files.length; i++) {
      if (keep.indexOf(files[i]) === -1) { await app.vault.adapter.remove(files[i]); removed++; }
    }
    return removed;
  })()`) as unknown as Promise<number>);
  return typeof result === "number" ? result : Number(result);
}

async function main() {
  const gate = new Gate();
  console.log("== Phase 5 gate ==\n");

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("open Ashfall, style loads", async () => {
    await openAshfall();
    const ok = evalJs(`(function(){var v=${ashfallView()};return !!(v&&v.map&&v.map.isStyleLoaded());})()`);
    if (ok !== true) throw new Error("Ashfall map did not load");
  });

  // snapshot committed Exports/ so the hygiene step can remove only what this
  // gate created (exports are timestamp-named — they'd dirty dev-vault forever)
  let exportsBaseline: string[] = [];
  await gate.try("snapshot Exports/ baseline", async () => {
    exportsBaseline = await listExports();
  });

  await gate.try("Phase 5 command + method surface present", () => {
    const result = evalJs(`(function(){
      var v = ${ashfallView()};
      var cmds = app.commands.commands;
      return JSON.stringify({
        cmds: ['export-map-poster','export-map-atlas','show-session-path','replay-campaign','populate-area','import-geojson'].filter(function(c){return !!cmds['campaign-map:'+c];}),
        methods: ['exportPoster','exportAtlas','showSessionPath','replayCampaign','populateArea','importGeojson'].filter(function(m){return typeof v[m]==='function';})
      });
    })()`);
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p.cmds.length !== 6) throw new Error(`missing commands, have: ${p.cmds.join(",")}`);
    if (p.methods.length !== 6) throw new Error(`missing methods, have: ${p.methods.join(",")}`);
  });

  await gate.try("point-crawl + session-path render layers registered", () => {
    const result = evalJs(`(function(){
      var v = ${ashfallView()};
      return JSON.stringify({ conn: !!v.map.getLayer('connection-line'), session: !!v.map.getLayer('session-path-line') });
    })()`);
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (!p.conn) throw new Error("connection-line layer missing");
    if (!p.session) throw new Error("session-path-line layer missing");
  });

  await gate.try("poster export writes a PNG to the vault", async () => {
    clearErrors();
    const before = await exportsCount("png");
    evalJs(`(function(){var v=${ashfallView()}; v.exportPoster().then(function(){window.__gatePoster=true;}); return 'started';})()`);
    let after = before;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await exportsCount("png");
      if (after > before) break;
    }
    evalJs("delete window.__gatePoster; true");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    if (!(after > before)) throw new Error(`no PNG written to Exports/ (before=${before} after=${after})`);
  });

  await gate.try("atlas export writes a PDF to the vault", async () => {
    clearErrors();
    const before = await exportsCount("pdf");
    evalJs(`(function(){var v=${ashfallView()}; v.exportAtlas().then(function(){window.__gateAtlas=true;}); return 'started';})()`);
    let after = before;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await exportsCount("pdf");
      if (after > before) break;
    }
    evalJs("delete window.__gateAtlas; true");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    if (!(after > before)) throw new Error(`no PDF written to Exports/ (before=${before} after=${after})`);
  });

  await gate.try("replay-campaign runs without renderer errors", async () => {
    clearErrors();
    evalJs(`(function(){var v=${ashfallView()}; v.replayCampaign(); return 'started';})()`);
    await new Promise((r) => setTimeout(r, 1500));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("fixture hygiene: gate-created exports removed", async () => {
    const removed = await removeNewExports(exportsBaseline);
    const after = await listExports();
    const extra = after.filter((f) => !exportsBaseline.includes(f));
    if (extra.length > 0) throw new Error(`Exports/ still has gate leftovers: ${extra.join(", ")}`);
    console.log(`    (removed ${removed} gate-created export file(s))`);
  });

  await gate.try("screenshot", () => {
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase5.png");
  });

  process.exit(gate.summarize("Phase 5"));
}

main();

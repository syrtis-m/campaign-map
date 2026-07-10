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
  // per-campaign commands register async on load; retry the open a few times
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    if (out.includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  // wait for style load
  for (let i = 0; i < 12; i++) {
    const ready = evalJs(`(function(){var v=${ashfallView()};return !!(v&&v.map&&v.map.isStyleLoaded());})()`);
    if (ready === true) return;
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

  await gate.try("screenshot", () => {
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase5.png");
  });

  process.exit(gate.summarize("Phase 5"));
}

main();

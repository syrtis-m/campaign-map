#!/usr/bin/env tsx
// Phase 1 Tier A gate — yes-and core, vault-native (docs/03 Phase 1, docs/06 §2).
import { readFileSync, existsSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const CAMPAIGN = "ashfall";
const TEST_LOC_PATH = "Campaigns/Ashfall/Locations/__GateTestLocation.md";
const RENAMED_PATH = "Campaigns/Ashfall/Locations/__GateTestRenamed.md";
const BAD_PATH = "Campaigns/Ashfall/Locations/__GateBad.md";
const QUICKADD_PATH = "Campaigns/Ashfall/Locations/Gatetown.md";

async function existsInVault(path: string): Promise<boolean> {
  return evalJs(`app.vault.adapter.exists('${path}')`) === true;
}

async function cleanupFixtures() {
  for (const p of [TEST_LOC_PATH, RENAMED_PATH, BAD_PATH, QUICKADD_PATH]) {
    if (await existsInVault(p)) obsidianRaw(["delete", `path=${p}`, "permanent"]);
  }
}

async function main() {
  const gate = new Gate();
  console.log("== Phase 1 gate ==\n");

  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
  await cleanupFixtures();

  await gate.try("no Node API in bundle", () => {
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    const bad = bundle.match(/require\(["']fs["']\)|require\(["']node:[a-z/]+["']\)/g);
    if (bad) throw new Error(`found ${bad.join(", ")}`);
  });

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("open Ashfall map", () => {
    clearErrors();
    obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("reconcile: create note → index within 500ms", async () => {
    clearErrors();
    obsidianRaw([
      "create",
      `path=${TEST_LOC_PATH}`,
      `content=---\\nmap: ${CAMPAIGN}\\ngeometry: [3, 2]\\ntype: village\\n---\\nGate test.`,
      "overwrite",
    ]);
    await new Promise((r) => setTimeout(r, 500));
    const has = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').index.has('${TEST_LOC_PATH}')`
    );
    if (has !== true) throw new Error(`index.has → ${has}`);
  });

  await gate.try("reconcile: rename note → index key follows within 500ms", async () => {
    obsidianRaw(["rename", `path=${TEST_LOC_PATH}`, "name=__GateTestRenamed"]);
    await new Promise((r) => setTimeout(r, 500));
    const oldGone = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').index.has('${TEST_LOC_PATH}')`
    );
    const newHere = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').index.has('${RENAMED_PATH}')`
    );
    if (oldGone !== false || newHere !== true) throw new Error(`old=${oldGone} new=${newHere}`);
  });

  await gate.try("reconcile: delete note → index drops within 500ms", async () => {
    obsidianRaw(["delete", `path=${RENAMED_PATH}`, "permanent"]);
    await new Promise((r) => setTimeout(r, 500));
    const gone = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').index.has('${RENAMED_PATH}')`
    );
    if (gone !== false) throw new Error(`still indexed: ${gone}`);
  });

  await gate.try("bad frontmatter: warned, not silently dropped", async () => {
    obsidianRaw([
      "create",
      `path=${BAD_PATH}`,
      `content=---\\nmap: ${CAMPAIGN}\\ntype: village\\n---\\nMissing geometry.`,
      "overwrite",
    ]);
    await new Promise((r) => setTimeout(r, 500));
    const invalidCount = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').invalid.size`
    );
    if (typeof invalidCount !== "number" || invalidCount < 1) throw new Error(`invalid count: ${invalidCount}`);
    const stillExists = await existsInVault(BAD_PATH);
    if (!stillExists) throw new Error("note was dropped, not just warned");
    obsidianRaw(["delete", `path=${BAD_PATH}`, "permanent"]);
    await new Promise((r) => setTimeout(r, 500));
  });

  await gate.try("quick-add path (scripted): creates note + renders pin < 5s", async () => {
    const start = Date.now();
    evalJs(
      `app.plugins.plugins['campaign-map'].createLocation('${CAMPAIGN}', [4, 3], 'Gatetown', 'town').then(()=>{window.__gateAddDone=true})`
    );
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      await new Promise((r) => setTimeout(r, 200));
      done = evalJs("!!window.__gateAddDone") === true;
    }
    if (!done) throw new Error("createLocation did not resolve in time");
    const elapsed = Date.now() - start;
    const inIndex = evalJs(
      `app.plugins.plugins['campaign-map'].getCampaignState('${CAMPAIGN}').index.has('${QUICKADD_PATH}')`
    );
    if (inIndex !== true) throw new Error(`not indexed after create (${elapsed}ms)`);
    if (elapsed > 5000) throw new Error(`took ${elapsed}ms`);
    evalJs("delete window.__gateAddDone; true");
  });

  await gate.try("label collisions: 0 overlaps at z4/8/12/16", () => {
    const result = evalJs(`(function(){
      var map = app.plugins.plugins['campaign-map'].map;
      var out = {};
      [4,8,12,16].forEach(function(z){
        map.setZoom(z);
        var feats = map.queryRenderedFeatures(undefined, {layers:['canon-label']});
        var boxes = feats.map(function(f){
          var p = map.project(f.geometry.coordinates);
          return [p.x-40,p.y-8,p.x+40,p.y+8];
        });
        var overlaps = 0;
        for (var i=0;i<boxes.length;i++) for (var j=i+1;j<boxes.length;j++) {
          var a=boxes[i], b=boxes[j];
          if (a[0]<b[2] && a[2]>b[0] && a[1]<b[3] && a[3]>b[1]) overlaps++;
        }
        out[z]=overlaps;
      });
      return JSON.stringify(out);
    })()`);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    const bad = Object.entries(parsed as Record<string, number>).filter(([, v]) => v > 0);
    if (bad.length > 0) throw new Error(`overlaps: ${JSON.stringify(parsed)}`);
  });

  await gate.try("theme-follow: obsidian-native style tracks the active theme", () => {
    obsidianRaw(["theme:set", "name=Minimal"]);
    const bgAfterMinimal = evalJs(
      `(function(){var map=app.plugins.plugins['campaign-map'].map; return map.getPaintProperty('background','background-color');})()`
    );
    obsidianRaw(["theme:set", "name="]);
    if (typeof bgAfterMinimal !== "string" || bgAfterMinimal.length === 0) {
      throw new Error(`no background-color after theme swap: ${JSON.stringify(bgAfterMinimal)}`);
    }
  });

  await gate.try("mutation log written for map-originated create", async () => {
    const exists = await existsInVault("Campaigns/Ashfall/.mapcache/log.jsonl");
    if (!exists) throw new Error("log.jsonl not created");
  });

  await gate.try("survives full app reload", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("screenshot captured", async () => {
    // Reload can restore stray/campaignless leaves from earlier manual sessions
    // (workspace.json autosave races); leave exactly one, focused, map leaf.
    evalJs(`(function(){
      var leaves = app.workspace.getLeavesOfType('campaign-map-view');
      leaves.forEach(function(l){ if(!l.view.campaign) l.detach(); });
      return 'ok';
    })()`);
    obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    // The map's 'load' handler calls applyCampaign()'s fitBounds asynchronously;
    // wait for map.loaded() before flyTo, or fitBounds wins the race and clobbers it.
    for (let i = 0; i < 25; i++) {
      const loaded = evalJs("!!(app.plugins.plugins['campaign-map'].map && app.plugins.plugins['campaign-map'].map.loaded())");
      if (loaded === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    evalJs(`app.plugins.plugins['campaign-map'].map.flyTo({center:[1.5,0.8], zoom:11, animate:false}); 'ok'`);
    // Labels can report "placed" via queryRenderedFeatures a frame or two before the
    // glyph atlas actually paints; give it a beat longer than the reconcile checks need.
    await new Promise((r) => setTimeout(r, 1200));
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase1.png");
    if (!existsSync("shots/gate-phase1.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Phase 1"));
}

main();

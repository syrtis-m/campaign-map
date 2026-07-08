#!/usr/bin/env tsx
// Phase 2 Tier A gate — real cities + themes (docs/03 Phase 2, docs/06 §2).
import { readFileSync, existsSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

const HANDCRAFTED = {
  // modern-clean's land was tuned #f8f7f2 -> #eae7de post-Phase-2 (within the
  // docs/06 §3 ±10% L/C-in-OKLCH tuning budget, logged in DECISIONS.md):
  // white roads/buildings need real separation from the land fill to read at
  // all, and #f8f7f2 was too close to white for that. See src/map/themes/tokens.ts.
  "modern-clean": "#eae7de",
  parchment: "#f2e8cf",
  "ink-soot": "#22211f",
  "neon-sprawl": "#0d0d11",
};

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

async function main() {
  const gate = new Gate();
  console.log("== Phase 2 gate ==\n");

  resetLeaves();

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

  await gate.try("basemap.pmtiles present in London campaign", () => {
    if (!existsSync("dev-vault/Campaigns/London/basemap.pmtiles")) {
      throw new Error("missing — run the pmtiles extract command in DECISIONS.md");
    }
  });

  await gate.try("regression: locations indexed on cold load (not just on vault events)", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    const londonCount = evalJs("app.plugins.plugins['campaign-map'].getCampaignState('london').index.size");
    const ashfallCount = evalJs("app.plugins.plugins['campaign-map'].getCampaignState('ashfall').index.size");
    if (typeof londonCount !== "number" || londonCount < 1) throw new Error(`london index: ${londonCount}`);
    if (typeof ashfallCount !== "number" || ashfallCount < 1) throw new Error(`ashfall index: ${ashfallCount}`);
  });

  await gate.try("real-city basemap renders (vault PMTiles protocol)", async () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-london");
    for (let i = 0; i < 25; i++) {
      const loaded = evalJs("!!(app.plugins.plugins['campaign-map'].map && app.plugins.plugins['campaign-map'].map.loaded())");
      if (loaded === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
    const earthFeatures = evalJs(
      "app.plugins.plugins['campaign-map'].map.queryRenderedFeatures(undefined, {layers:['basemap-earth']}).length"
    );
    if (typeof earthFeatures !== "number" || earthFeatures < 1) throw new Error(`basemap-earth features: ${earthFeatures}`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("canon pin renders over the real basemap", () => {
    const canonFeatures = evalJs(
      "app.plugins.plugins['campaign-map'].map.queryRenderedFeatures(undefined, {layers:['canon-point']}).length"
    );
    if (typeof canonFeatures !== "number" || canonFeatures < 1) throw new Error(`canon-point features: ${canonFeatures}`);
  });

  await gate.try("real-city native scale control present (not the fictional custom bar)", () => {
    const hasScaleCtrl = evalJs("!!document.querySelector('.maplibregl-ctrl-scale')");
    const fictionalBarHidden = evalJs(
      "document.querySelector('.campaign-map-scale-bar').style.display === 'none'"
    );
    if (hasScaleCtrl !== true) throw new Error("no .maplibregl-ctrl-scale");
    if (fictionalBarHidden !== true) throw new Error("fictional scale bar not hidden for real crs");
  });

  resetLeaves();
  obsidian("command id=campaign-map:open-map-ashfall");
  await new Promise((r) => setTimeout(r, 500));

  for (const [themeId, landColor] of Object.entries(HANDCRAFTED)) {
    await gate.try(`theme switch: ${themeId} background matches pinned token`, async () => {
      obsidianRaw([
        "property:set",
        "name=theme",
        `value=${themeId}`,
        "path=Campaigns/Ashfall/Ashfall.map.md",
      ]);
      await new Promise((r) => setTimeout(r, 400));
      const bg = evalJs(
        "(function(){var l=app.workspace.getLeavesOfType('campaign-map-view').find(l=>l.view.campaign&&l.view.campaign.id==='ashfall'); return l ? l.view.map.getPaintProperty('background','background-color') : null;})()"
      );
      if (typeof bg !== "string" || bg.toLowerCase() !== landColor.toLowerCase()) {
        throw new Error(`expected ${landColor}, got ${bg}`);
      }
    });
  }

  await gate.try("restore Ashfall to obsidian-native default", async () => {
    obsidianRaw([
      "property:set",
      "name=theme",
      "value=obsidian-native",
      "path=Campaigns/Ashfall/Ashfall.map.md",
    ]);
    await new Promise((r) => setTimeout(r, 400));
    const theme = evalJs("app.plugins.plugins['campaign-map'].getCampaign('ashfall').config.theme");
    if (theme !== "obsidian-native") throw new Error(`theme: ${theme}`);
  });

  await gate.try("fictional campaign still works (no basemap source required)", () => {
    clearErrors();
    resetLeaves();
    obsidian("command id=campaign-map:open-map-ashfall");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("survives full app reload with basemap present", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("screenshot: London real basemap + canon pin", async () => {
    resetLeaves();
    obsidian("command id=campaign-map:open-map-london");
    for (let i = 0; i < 25; i++) {
      const loaded = evalJs("!!(app.plugins.plugins['campaign-map'].map && app.plugins.plugins['campaign-map'].map.loaded())");
      if (loaded === true) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    evalJs("app.plugins.plugins['campaign-map'].map.flyTo({center:[-0.12,51.51], zoom:15, animate:false}); 'ok'");
    await new Promise((r) => setTimeout(r, 1200));
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase2-london.png");
    if (!existsSync("shots/gate-phase2-london.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Phase 2"));
}

main();

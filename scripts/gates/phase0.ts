#!/usr/bin/env tsx
// Phase 0 Tier A gate — plugin skeleton + the two spikes (docs/03 Phase 0, docs/06 §2).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { Gate, obsidian, obsidianRaw, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

async function main() {
  const gate = new Gate();

  console.log("== Phase 0 gate ==\n");

  // Reset workspace so repeated gate runs don't accumulate split tabs.
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");

  await gate.try("no Node API in bundle", () => {
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    const bad = bundle.match(/require\(["']fs["']\)|require\(["']node:[a-z/]+["']\)/g);
    if (bad) throw new Error(`found ${bad.join(", ")}`);
  });

  await gate.try("plugin enabled, no load errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("campaign config note parses (Ashfall)", () => {
    const names = evalJs(
      "JSON.stringify(app.plugins.plugins['campaign-map'].listCampaigns().map(c=>c.name))"
    );
    if (!Array.isArray(names) || !names.includes("Ashfall")) {
      throw new Error(`campaigns: ${JSON.stringify(names)}`);
    }
  });

  await gate.try("per-campaign open-map command opens a campaign-map-view", () => {
    clearErrors();
    // dev-vault has 3 test campaigns (fantasy/real-city/neon-sprawl), so the generic
    // campaign-map:open-map command shows a picker; use the deterministic per-campaign
    // command id for scripted testing.
    obsidian("command id=campaign-map:open-map-ashfall");
    const count = evalJs("app.workspace.getLeavesOfType('campaign-map-view').length");
    if (typeof count !== "number" || count < 1) throw new Error(`leaf count: ${count}`);
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("MapLibre canvas renders with nonzero size", () => {
    const size = evalJs(
      "(function(){var c=document.querySelector('.campaign-map-canvas canvas'); return c ? JSON.stringify({w:c.clientWidth,h:c.clientHeight}) : 'null';})()"
    );
    const parsed = typeof size === "string" ? JSON.parse(size) : size;
    if (!parsed || parsed.w < 10 || parsed.h < 10) throw new Error(`canvas size: ${JSON.stringify(parsed)}`);
  });

  await gate.try("scale bar reflects fictional CRS (Spike B)", () => {
    const label = evalJs("document.querySelector('.campaign-map-scale-bar')?.textContent || ''");
    if (typeof label !== "string" || !/\d/.test(label)) throw new Error(`scale bar text: ${label}`);
  });

  await gate.try("generic open-map command shows a picker with 3+ campaigns", () => {
    clearErrors();
    obsidian("command id=campaign-map:open-map");
    const hasModal = evalJs("!!document.querySelector('.prompt-input')");
    // dismiss it so it doesn't linger for the rest of the gate
    evalJs("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})); true");
    if (hasModal !== true) throw new Error(`expected a suggester modal, got: ${hasModal}`);
  });

  await gate.try("tab survives split", () => {
    obsidian("command id=workspace:split-vertical");
    const count = evalJs("app.workspace.getLeavesOfType('campaign-map-view').length");
    if (typeof count !== "number" || count < 2) throw new Error(`leaf count after split: ${count}`);
  });

  await gate.try("survives full app reload", async () => {
    obsidianRaw(["reload"]);
    await new Promise((r) => setTimeout(r, 4000));
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
    const count = evalJs("app.workspace.getLeavesOfType('campaign-map-view').length");
    if (typeof count !== "number" || count < 1) throw new Error(`leaf count after reload: ${count}`);
  });

  await gate.try("screenshot captured", () => {
    screenshot("/Users/athena/projects/campaign-map/shots/gate-phase0.png");
    if (!existsSync("shots/gate-phase0.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Phase 0"));
}

main();

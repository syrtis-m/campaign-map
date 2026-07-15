#!/usr/bin/env tsx
// Smoke: BOOT + STYLE — the plugin actually loads, opens a map, and every
// style-builder path produces a style MapLibre accepts. Absorbs the retired
// phase0 (skeleton/spikes), styleLoad (the blank-map class: an invalid style
// expression silently invalidates the WHOLE style — no console error, unit
// tests blind), and phase2's live style half (real basemap + handcrafted
// themes). The static counterpart is src/map/styleValidation.test.ts; this is
// the one that catches whatever only a live MapLibre rejects.
import { readFileSync, existsSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

// One campaign per style-builder path: runtime CSS-derived, real basemap,
// handcrafted dark. Fictional Ashfall also carries the scale bar + hillshade.
const CAMPAIGNS: Array<{ id: string; theme: string }> = [
  { id: "ashfall", theme: "obsidian-native" },
  { id: "london", theme: "modern-clean (+ real basemap)" },
  { id: "nightreach", theme: "neon-sprawl" },
];

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}
function viewExpr(campaign: string): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${campaign}'})`;
}
async function issueOpen(campaign: string): Promise<void> {
  resetLeaves();
  // Per-campaign open commands register async on plugin load; retry the open.
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${campaign}`);
    if (out.includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

interface StyleHealth {
  view: boolean;
  isStyleLoaded: unknown;
  hasStyle: unknown;
  layerCount: unknown;
  hasBackground: unknown;
}
function styleHealth(campaign: string): StyleHealth {
  const raw = evalJs(`(function(){
    var v = ${viewExpr(campaign)};
    if (!v || !v.map) return JSON.stringify({ view:false });
    var m = v.map;
    var s;
    try { s = m.getStyle(); } catch (e) { s = null; }
    return JSON.stringify({
      view: true,
      isStyleLoaded: m.isStyleLoaded(),
      hasStyle: !!s && typeof s === 'object',
      layerCount: (s && s.layers || []).length,
      hasBackground: !!m.getLayer('background'),
    });
  })()`);
  return typeof raw === "string" ? JSON.parse(raw) : (raw as StyleHealth);
}
function isHealthy(h: StyleHealth): boolean {
  return h.view === true && h.isStyleLoaded === true && h.hasStyle === true && h.hasBackground === true;
}
/** Poll until healthy: a VALID style settles within a second or two (the
 * obsidian-native theme rebuilds on css-change, so isStyleLoaded flickers —
 * polling rides it out); an invalidated style NEVER gets there. */
async function waitForStyle(campaign: string, timeoutMs = 15000): Promise<StyleHealth> {
  const deadline = Date.now() + timeoutMs;
  let last = styleHealth(campaign);
  while (Date.now() < deadline) {
    if (isHealthy(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
    last = styleHealth(campaign);
  }
  return last;
}

async function main() {
  const gate = new Gate();
  console.log("== Smoke: boot + style ==\n");

  await gate.try("no Node API in bundle", () => {
    const bundle = readFileSync("dev-vault/.obsidian/plugins/campaign-map/main.js", "utf8");
    const bad = bundle.match(/require\(["']fs["']\)|require\(["']node:[a-z/]+["']\)/g);
    if (bad) throw new Error(`found ${bad.join(", ")}`);
  });

  await gate.try("plugin loads (reloaded), no errors", () => {
    clearErrors();
    obsidian("plugin:reload id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("campaign config notes parse (Ashfall present)", () => {
    const names = evalJs(
      "JSON.stringify(app.plugins.plugins['campaign-map'].listCampaigns().map(c=>c.name))"
    );
    if (!Array.isArray(names) || !names.includes("Ashfall")) {
      throw new Error(`campaigns: ${JSON.stringify(names)}`);
    }
  });

  for (const { id, theme } of CAMPAIGNS) {
    await gate.try(`${id} (${theme}) opens and its style loads`, async () => {
      clearErrors();
      await issueOpen(id);
      const h = await waitForStyle(id);
      if (!h.view) throw new Error(`no MapView opened for ${id}`);
      if (!isHealthy(h)) {
        throw new Error(
          `style did not load (isStyleLoaded=${h.isStyleLoaded}, getStyle defined=${h.hasStyle}, layers=${h.layerCount}, background=${h.hasBackground}) — a bad style expression silently invalidates the whole style`
        );
      }
      const errs = devErrors();
      if (!errs.includes("No errors")) throw new Error(errs);
    });
  }

  await gate.try("fictional extras: canvas size, scale bar, hillshade layer (last-opened is nightreach — reopen ashfall)", async () => {
    await issueOpen("ashfall");
    await waitForStyle("ashfall");
    const size = evalJs(
      "(function(){var c=document.querySelector('.campaign-map-canvas canvas'); return c ? JSON.stringify({w:c.clientWidth,h:c.clientHeight}) : 'null';})()"
    );
    const parsed = typeof size === "string" ? JSON.parse(size) : size;
    if (!parsed || parsed.w < 10 || parsed.h < 10) throw new Error(`canvas size: ${JSON.stringify(parsed)}`);
    const label = evalJs("document.querySelector('.campaign-map-scale-bar')?.textContent || ''");
    if (typeof label !== "string" || !/\d/.test(label)) throw new Error(`scale bar text: ${label}`);
    const hillshade = evalJs(`(function(){var v=${viewExpr("ashfall")};return !!v.map.getLayer('hillshade');})()`);
    if (hillshade !== true) throw new Error("hillshade layer missing from fictional style");
  });

  await gate.try("screenshot captured", () => {
    screenshot("/Users/athena/projects/campaign-map/shots/gate-smoke-boot.png");
    if (!existsSync("shots/gate-smoke-boot.png")) throw new Error("screenshot missing");
  });

  process.exit(gate.summarize("Smoke boot+style"));
}

main();

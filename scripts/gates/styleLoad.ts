#!/usr/bin/env tsx
// Style-load gate — the live guard for the 013/014 blank-map class (commit 82cda5c).
//
// A MapLibre style with an invalid expression (a zoom `interpolate` nested
// inside `["*", …]` in a paint property) fails to load ENTIRELY: the map goes
// blank, `getStyle()` returns undefined, `isStyleLoaded()` stays false — and
// crucially NO console error fires, so `dev:errors` reports clean and unit
// tests (which never load a live style) stay green. That's exactly how the
// sketch merge shipped a blank map. This gate opens each campaign in a real
// Obsidian and asserts the style actually loaded, so a regression fails loudly.
//
// Coverage is deliberately cross-cutting: obsidian-native (runtime CSS-derived,
// via obsidianNativeStyle), modern-clean + real basemap, and neon-sprawl (both
// via buildThemeStyle) — every style-builder path the plugin has, fictional and
// real-city. The static counterpart (src/map/styleValidation.test.ts) runs the
// same built styles through validateStyleMin without a renderer; this is the
// one that catches whatever only a live MapLibre rejects.
//
// Same evalJs double-encoding + async command-registration rules as the phase
// gates (see scripts/gates/phase5.ts).
import { Gate, obsidian, evalJs, clearErrors, devErrors, screenshot } from "../lib/cli.js";

// campaign id -> theme it exercises (documentation only; asserted live below).
const CAMPAIGNS: Array<{ id: string; theme: string }> = [
  { id: "ashfall", theme: "obsidian-native" },
  { id: "london", theme: "modern-clean (+ real basemap)" },
  { id: "nightreach", theme: "neon-sprawl" },
];

function resetLeaves() {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}

/** JS expression evaluating to the live MapView for `campaign`, or undefined. */
function viewExpr(campaign: string): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${campaign}'})`;
}

async function issueOpen(campaign: string): Promise<void> {
  resetLeaves();
  // per-campaign open commands register async on plugin load; retry the open.
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

/** One instantaneous reading of the live map's style health. */
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

/**
 * Poll the load-time discriminator until healthy or timeout. A VALID style
 * settles to { isStyleLoaded:true, getStyle():<object>, background layer present }
 * within a second or two — and the obsidian-native theme rebuilds on css-change,
 * so isStyleLoaded flickers false transiently (see phase3.ts); polling rides
 * that out. A style invalidated by a bad expression NEVER gets there:
 * isStyleLoaded stays false, getStyle() undefined, zero layers — indefinitely
 * (empirically verified against the reintroduced nested-zoom paint bug, 82cda5c).
 * Returns the final reading either way so a failure names which signal went wrong.
 */
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
  console.log("== Style-load gate ==\n");

  await gate.try("plugin loads, no errors", () => {
    clearErrors();
    obsidian("plugin:enable id=campaign-map");
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  for (const { id, theme } of CAMPAIGNS) {
    await gate.try(`${id} (${theme}) style loads`, async () => {
      clearErrors();
      await issueOpen(id);
      const h = await waitForStyle(id);
      if (!h.view) throw new Error(`no MapView opened for ${id}`);
      // The core assertion: a style that never loaded fails HERE, loudly. A bad
      // style expression silently invalidates the WHOLE style — no console error.
      if (!isHealthy(h)) {
        throw new Error(
          `style did not load (isStyleLoaded=${h.isStyleLoaded}, getStyle defined=${h.hasStyle}, layers=${h.layerCount}, background=${h.hasBackground}) — a bad style expression silently invalidates the whole style`
        );
      }
      // dev:errors is NOT the discriminator (the failure fires no console
      // error), but a clean log is still part of a healthy open.
      const errs = devErrors();
      if (!errs.includes("No errors")) throw new Error(errs);
    });
  }

  await gate.try("screenshot", () => {
    screenshot("/Users/athena/projects/campaign-map/shots/gate-style-load.png");
  });

  process.exit(gate.summarize("Style-load"));
}

main();

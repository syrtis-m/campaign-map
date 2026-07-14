import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { obsidianNativeStyle, type ObsidianCssTokens } from "./theme";
import { buildThemeStyle, HANDCRAFTED_THEMES } from "./themes";

/**
 * Static style-spec guard (regression for the 013/014 merge, commit 82cda5c).
 *
 * The two sketch bugs — a zoom `interpolate` nested inside `["*", …]` in a
 * paint `line-width`, and a `["zoom"]` expression in a layer `filter` — made
 * the ENTIRE MapLibre style silently fail to load (blank map, no console
 * error) while `npm test` stayed green, because no unit test ever ran a built
 * style through MapLibre's own validator. This runs every theme's assembled
 * style (fabric / connection / session-path / generated / basemap layers and
 * all) through `validateStyleMin` and asserts zero errors.
 *
 * IMPORTANT — coverage boundary: `validateStyleMin` catches the *paint*-nesting
 * class (zoom nested under `["*", …]` — bug 2, empirically the one that
 * invalidates the style at load in maplibre-gl 4.7.1) and any other spec-level
 * violation in the built layers. It does NOT catch the zoom-in-filter class
 * (bug 1); the validator accepts it, and in maplibre-gl 4.7.1 so does the
 * runtime (it renders). The live `isStyleLoaded()`/`getStyle()` gate
 * (scripts/gates/styleLoad.ts) owns the load-time regression signal; this test
 * is the cheap, renderer-free first line for spec-invalid expressions.
 *
 * The style-spec version is pinned to the one maplibre-gl bundles (see
 * package.json devDependencies) so the validator's rules match the runtime's.
 */

// A glyphs URL is required for symbol layers to validate; a template that the
// validator never fetches (validateStyleMin is purely static) is enough.
const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const BASEMAP = { sourceId: "basemap", url: "pmtiles://basemap.pmtiles" };
// Fictional campaigns now carry the generated raster-DEM source + hillshade
// layer (plan 023 §4.2) — validate that shape too.
const DEM = { sourceId: "dem-test", url: "campaigndem://test/{z}/{x}/{y}" };

// Stand-in for readObsidianCssTokens() — obsidianNativeStyle only reads color
// strings off this, so concrete hex values exercise the same layer assembly the
// live default theme uses.
const OBSIDIAN_TOKENS: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};

function expectValid(label: string, style: StyleSpecification) {
  const errors = validateStyleMin(style as unknown as Parameters<typeof validateStyleMin>[0]);
  const messages = errors.map((e) => `${e.line ? `L${e.line} ` : ""}${e.message}`);
  expect(messages, `${label} produced MapLibre style-spec errors`).toEqual([]);
}

describe("built styles pass MapLibre validateStyleMin (013/014 regression)", () => {
  // Fictional campaigns build with no basemap source; real-city campaigns add a
  // vector basemap + basemapLayers. Validate both shapes for every theme.
  describe("obsidian-native (runtime CSS-derived default)", () => {
    it("fictional (no basemap)", () => {
      expectValid("obsidian-native", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS));
    });
    it("real-city (with basemap)", () => {
      expectValid("obsidian-native + basemap", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, BASEMAP));
    });
    it("fictional with DEM (hillshade, plan 023 §4.2)", () => {
      expectValid("obsidian-native + dem", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, undefined, DEM));
    });
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    describe(`handcrafted: ${id}`, () => {
      it("fictional (no basemap)", () => {
        expectValid(id, buildThemeStyle(tokens, GLYPHS));
      });
      it("real-city (with basemap)", () => {
        expectValid(`${id} + basemap`, buildThemeStyle(tokens, GLYPHS, BASEMAP));
      });
      it("fictional with DEM (hillshade, plan 023 §4.2)", () => {
        expectValid(`${id} + dem`, buildThemeStyle(tokens, GLYPHS, undefined, DEM));
      });
    });
  }
});

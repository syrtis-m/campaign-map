import { describe, it, expect } from "vitest";
import { terrainContourLayer, TERRAIN_CONTOUR_SOURCE_ID } from "./terrainContourLayer";
import { HANDCRAFTED_THEMES } from "./tokens";
import { buildThemeStyle } from "./index";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { layerGroupOf } from "./layerOrder";

/**
 * Global terrain-contour paint coverage (Jonah 2026-07-15): a single
 * theme-derived line layer over the campaign-wide terrain field, present in every
 * theme's built style when the campaign has a DEM, bound to its own source, with
 * NO zoom LOD gate (LOD is interval-per-zoom, upstream), sitting in the generated
 * z-group (below the GM's sketch, above hillshade).
 */

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const DEM = { sourceId: "dem-x", url: "campaigndem://x/{z}/{x}/{y}" };
const OBSIDIAN_TOKENS: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};

describe("terrainContourLayer across every theme", () => {
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: is a line layer on the terrain-contour source, theme-derived, no zoom LOD gate`, () => {
      const layer = terrainContourLayer(tokens) as unknown as {
        id: string;
        type: string;
        source: string;
        paint: Record<string, unknown>;
      };
      expect(layer.id).toBe("generated-terrain-contour");
      expect(layer.type).toBe("line");
      expect(layer.source).toBe(TERRAIN_CONTOUR_SOURCE_ID);
      // Color is a plain theme-derived hex (relief-derived), not a default.
      expect(String(layer.paint["line-color"])).toMatch(/^#[0-9a-f]{6}$/i);
      // Width interpolates by zoom for READ WEIGHT, but there is no minzoom gate
      // and no `["get","zoom"]` visibility filter — contours render at every zoom.
      expect(JSON.stringify(layer)).not.toContain("minzoom");
    });
  }

  it("classifies into the generated z-group (below sketch, above hillshade)", () => {
    expect(layerGroupOf("generated-terrain-contour")).toBe("generated");
  });
});

describe("buildThemeStyle / obsidianNativeStyle wire the contour source + layer", () => {
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: DEM present ⇒ terrain-contour source + generated-terrain-contour layer, above hillshade`, () => {
      const style = buildThemeStyle(tokens, GLYPHS, undefined, DEM) as unknown as {
        sources: Record<string, unknown>;
        layers: { id: string }[];
      };
      expect(style.sources[TERRAIN_CONTOUR_SOURCE_ID], `${id} contour source`).toBeDefined();
      const ids = style.layers.map((l) => l.id);
      const contour = ids.indexOf("generated-terrain-contour");
      const hillshade = ids.indexOf("hillshade");
      expect(contour, `${id} contour layer`).toBeGreaterThan(-1);
      expect(contour).toBeGreaterThan(hillshade); // relief context over the shaded ground
    });
  }

  it("no dem param ⇒ no contour source or layer (real-city shape unchanged)", () => {
    const style = buildThemeStyle(HANDCRAFTED_THEMES.parchment, GLYPHS) as unknown as {
      sources: Record<string, unknown>;
      layers: { id: string }[];
    };
    expect(style.sources[TERRAIN_CONTOUR_SOURCE_ID]).toBeUndefined();
    expect(style.layers.some((l) => l.id === "generated-terrain-contour")).toBe(false);
  });

  it("obsidian-native runtime style carries the same contour shape", () => {
    const style = obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, undefined, DEM) as unknown as {
      sources: Record<string, unknown>;
      layers: { id: string }[];
    };
    expect(style.sources[TERRAIN_CONTOUR_SOURCE_ID]).toBeDefined();
    expect(style.layers.some((l) => l.id === "generated-terrain-contour")).toBe(true);
  });
});

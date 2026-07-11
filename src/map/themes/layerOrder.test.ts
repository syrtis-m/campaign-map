import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { buildThemeStyle, HANDCRAFTED_THEMES } from "./index";
import { assertLayerOrder, layerGroupOf, LAYER_GROUP_ORDER } from "./layerOrder";

/**
 * Z-order invariant test (plan 019, Phase 4): every theme's emitted layer
 * array must keep Locations above fabric — a future theme edit that sinks
 * pins under a fill has to fail here, not surface as a screenshot regression.
 */

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const BASEMAP = { sourceId: "basemap", url: "pmtiles://basemap.pmtiles" };
const OBSIDIAN_TOKENS: ObsidianCssTokens = {
  backgroundPrimary: "#1e1e1e",
  backgroundSecondary: "#262626",
  backgroundModifierBorder: "#4d4d4d",
  textMuted: "#999999",
  textNormal: "#dcddde",
  interactiveAccent: "#7c3aed",
  fontText: "sans-serif",
};

function groups(style: StyleSpecification): string[] {
  return style.layers.map((l) => layerGroupOf(l.id));
}

function allStyles(): [string, StyleSpecification][] {
  const out: [string, StyleSpecification][] = [
    ["obsidian-native", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS)],
    ["obsidian-native+basemap", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, BASEMAP)],
  ];
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    out.push([id, buildThemeStyle(tokens, GLYPHS)]);
    out.push([`${id}+basemap`, buildThemeStyle(tokens, GLYPHS, BASEMAP)]);
  }
  return out;
}

describe("z-order invariant across every theme (plan 019)", () => {
  for (const [label, style] of allStyles()) {
    it(`${label}: groups are monotonically ordered and locations top the stack`, () => {
      expect(() => assertLayerOrder(style.layers)).not.toThrow();
      const g = groups(style);
      // Locations really are last…
      expect(g[g.length - 1]).toBe("location-label");
      expect(g).toContain("location-point");
      // …and every fabric layer (generated AND sketched) sits below every
      // location layer.
      const lastFabric = Math.max(g.lastIndexOf("generated"), g.lastIndexOf("fabric"));
      const firstLocation = g.indexOf("location-point");
      expect(lastFabric).toBeLessThan(firstLocation);
      // Sketched fabric above generated: the GM's hand wins where they overlap.
      expect(g.lastIndexOf("generated")).toBeLessThan(g.indexOf("fabric"));
    });
  }

  it("assertLayerOrder rejects a style with a pin sunk under fabric", () => {
    expect(() =>
      assertLayerOrder([{ id: "canon-point" }, { id: "fabric-water" }])
    ).toThrow(/locations must stay on top/);
  });

  it("layerGroupOf rejects unknown layer families so new layers must declare a slot", () => {
    expect(() => layerGroupOf("mystery-layer")).toThrow(/no known z-order group/);
  });

  it("group order constant itself keeps locations above all fabric", () => {
    expect(LAYER_GROUP_ORDER.indexOf("location-point")).toBeGreaterThan(LAYER_GROUP_ORDER.indexOf("fabric"));
    expect(LAYER_GROUP_ORDER.indexOf("fabric")).toBeGreaterThan(LAYER_GROUP_ORDER.indexOf("generated"));
  });
});

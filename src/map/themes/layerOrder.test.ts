import { describe, expect, it } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { buildThemeStyle, HANDCRAFTED_THEMES } from "./index";
import { assertLayerOrder, layerGroupOf, LAYER_GROUP_ORDER } from "./layerOrder";

/**
 * Z-order invariant test (the three-layer model — generated < sketch <
 * locations): every theme's emitted layer array must keep Locations above
 * fabric and the sketch layer above generated procgen — a future theme edit
 * that sinks pins under a fill, or generated over the GM's sketch, has to fail
 * here, not surface as a screenshot regression.
 */

const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";
const BASEMAP = { sourceId: "basemap", url: "pmtiles://basemap.pmtiles" };
const DEM = { sourceId: "dem-test", url: "campaigndem://test/{z}/{x}/{y}" };
const UNDERLAY = {
  url: "app://local/ref.png",
  sw: [0, 0] as [number, number],
  ne: [1, 1] as [number, number],
  opacity: 0.6,
  visible: true,
};
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
    ["obsidian-native+dem", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, undefined, DEM)],
    ["obsidian-native+underlay", obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, undefined, undefined, UNDERLAY)],
    [
      "obsidian-native+underlay+basemap+dem",
      obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, BASEMAP, DEM, UNDERLAY),
    ],
  ];
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    out.push([id, buildThemeStyle(tokens, GLYPHS)]);
    out.push([`${id}+basemap`, buildThemeStyle(tokens, GLYPHS, BASEMAP)]);
    out.push([`${id}+dem`, buildThemeStyle(tokens, GLYPHS, undefined, DEM)]);
    out.push([`${id}+underlay`, buildThemeStyle(tokens, GLYPHS, undefined, undefined, UNDERLAY)]);
  }
  return out;
}

describe("z-order invariant across every theme", () => {
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
    ).toThrow(/generated < sketch < locations/);
  });

  it("layerGroupOf rejects unknown layer families so new layers must declare a slot", () => {
    expect(() => layerGroupOf("mystery-layer")).toThrow(/no known z-order group/);
  });

  it("group order constant itself keeps locations above all fabric", () => {
    expect(LAYER_GROUP_ORDER.indexOf("location-point")).toBeGreaterThan(LAYER_GROUP_ORDER.indexOf("fabric"));
    expect(LAYER_GROUP_ORDER.indexOf("fabric")).toBeGreaterThan(LAYER_GROUP_ORDER.indexOf("generated"));
  });

  it("reference underlay sits just above background and below every content layer (plan 041)", () => {
    // The group constant: background < underlay < basemap < everything else.
    expect(LAYER_GROUP_ORDER.indexOf("underlay")).toBe(LAYER_GROUP_ORDER.indexOf("background") + 1);
    expect(LAYER_GROUP_ORDER.indexOf("underlay")).toBeLessThan(LAYER_GROUP_ORDER.indexOf("basemap"));
    expect(LAYER_GROUP_ORDER.indexOf("underlay")).toBeLessThan(LAYER_GROUP_ORDER.indexOf("generated"));
    expect(LAYER_GROUP_ORDER.indexOf("underlay")).toBeLessThan(LAYER_GROUP_ORDER.indexOf("fabric"));
    // And in an actual emitted style, the underlay layer follows the background
    // layer directly and precedes every fabric/location layer.
    const style = obsidianNativeStyle(OBSIDIAN_TOKENS, GLYPHS, BASEMAP, DEM, UNDERLAY);
    const ids = style.layers.map((l) => l.id);
    expect(ids[0]).toBe("background");
    expect(ids[1]).toBe("underlay");
    const g = groups(style);
    const underlayIdx = g.indexOf("underlay");
    expect(underlayIdx).toBeLessThan(g.indexOf("generated"));
    expect(underlayIdx).toBeLessThan(g.indexOf("fabric"));
    expect(underlayIdx).toBeLessThan(g.indexOf("location-point"));
  });

  it("classifies the underlay layer id and rejects it sunk over fabric", () => {
    expect(layerGroupOf("underlay")).toBe("underlay");
    // Underlay ABOVE fabric must fail the invariant.
    expect(() => assertLayerOrder([{ id: "fabric-water" }, { id: "underlay" }])).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { fabricLayers, FABRIC_LAYER_IDS, FABRIC_SOURCE_SPEC } from "./fabricLayers";
import { HANDCRAFTED_THEMES, PARCHMENT } from "./tokens";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { FABRIC_KINDS, defaultMinZoomFor, isPolygonKind, type FabricKind } from "../../model/fabric";

describe("fabricLayers (LOD discipline — plan 013 non-negotiable)", () => {
  const layers = fabricLayers(PARCHMENT);

  it("emits exactly one layer per fabric kind, on the fabric source", () => {
    expect(layers).toHaveLength(FABRIC_KINDS.length);
    const ids = layers.map((l) => l.id);
    for (const id of FABRIC_LAYER_IDS) expect(ids).toContain(id);
    for (const l of layers) expect((l as { source?: string }).source).toBe("fabric");
  });

  it("every layer carries its kind's minzoom", () => {
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`) as { minzoom?: number };
      expect(layer?.minzoom).toBe(defaultMinZoomFor(kind));
    }
  });

  it("line kinds are line layers, polygon kinds are fill layers", () => {
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`)!;
      expect(layer.type).toBe(isPolygonKind(kind as FabricKind) ? "fill" : "line");
    }
  });

  it("polygon fills render before (under) line kinds", () => {
    const ids = layers.map((l) => l.id);
    const lastFill = Math.max(...FABRIC_KINDS.filter(isPolygonKind).map((k) => ids.indexOf(`fabric-${k}`)));
    const firstLine = Math.min(...FABRIC_KINDS.filter((k) => !isPolygonKind(k)).map((k) => ids.indexOf(`fabric-${k}`)));
    expect(lastFill).toBeLessThan(firstLine);
  });

  it("filters are kind-only and never put zoom in a filter (invalidates the whole style)", () => {
    // MapLibre disallows a `["zoom"]` expression inside a layer `filter`; it
    // silently invalidates the entire style (map loads blank, no console
    // error). The per-kind LOD floor lives on the layer's `minzoom` property
    // instead (asserted below), never in the filter.
    for (const layer of layers) {
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).not.toContain('"zoom"');
      expect(filter).toContain('"kind"');
    }
  });

  it("each layer carries a per-kind minzoom (the LOD floor)", () => {
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`)! as { minzoom?: number };
      expect(typeof layer.minzoom).toBe("number");
    }
  });

  it("source spec carries simplification tolerance", () => {
    expect(FABRIC_SOURCE_SPEC.type).toBe("geojson");
    expect(FABRIC_SOURCE_SPEC.tolerance).toBeGreaterThan(0);
  });
});

describe("fabric kinds are visibly distinct per theme (plan 017)", () => {
  // The user's #1 complaint: road/wall/river/water/district/park shared
  // colors (river == water; park borrowed a road color), so nothing read as
  // itself. Guard: in every theme, each of the six kinds paints in its OWN
  // color — six kinds, six distinct values.
  function primaryColor(layer: LayerSpecification): string {
    const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
    const color = layer.type === "fill" ? paint["fill-color"] : paint["line-color"];
    expect(typeof color, `${layer.id} must paint a plain token color`).toBe("string");
    return (color as string).toLowerCase();
  }

  function expectSixDistinctColors(themeId: string, layers: LayerSpecification[]) {
    const colors = FABRIC_KINDS.map((kind) => {
      const layer = layers.find((l) => l.id === `fabric-${kind}`)!;
      return primaryColor(layer);
    });
    expect(new Set(colors).size, `${themeId} fabric colors collide: ${colors.join(", ")}`).toBe(
      FABRIC_KINDS.length
    );
  }

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: six kinds, six distinct colors`, () => {
      expectSixDistinctColors(id, fabricLayers(tokens));
    });
  }

  // obsidian-native derives at runtime from CSS variables — assert both the
  // stock dark and stock light themes still differentiate all six kinds.
  const OBSIDIAN_DARK: ObsidianCssTokens = {
    backgroundPrimary: "#1e1e1e",
    backgroundSecondary: "#262626",
    backgroundModifierBorder: "#4d4d4d",
    textMuted: "#999999",
    textNormal: "#dcddde",
    interactiveAccent: "#7c3aed",
    fontText: "sans-serif",
  };
  const OBSIDIAN_LIGHT: ObsidianCssTokens = {
    ...OBSIDIAN_DARK,
    backgroundPrimary: "#ffffff",
    backgroundSecondary: "#f2f3f5",
    backgroundModifierBorder: "#bbbbbb",
    textMuted: "#888888",
    textNormal: "#222222",
  };
  const GLYPHS = "http://localhost/glyphs/{fontstack}/{range}.pbf";

  for (const [label, cssTokens] of [
    ["obsidian-native (dark)", OBSIDIAN_DARK],
    ["obsidian-native (light)", OBSIDIAN_LIGHT],
  ] as const) {
    it(`${label}: six kinds, six distinct colors`, () => {
      const style = obsidianNativeStyle(cssTokens, GLYPHS);
      const fabric = style.layers.filter((l) => l.id.startsWith("fabric-"));
      expectSixDistinctColors(label, fabric as LayerSpecification[]);
    });
  }
});

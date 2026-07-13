import { describe, it, expect } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { generatedLayers } from "./generatedLayers";
import { HANDCRAFTED_THEMES, PARCHMENT } from "./tokens";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { assertLayerOrder } from "./layerOrder";

/** Every generated feature `type` must be painted in EVERY theme — a missing
 * entry means invisible output that passes every non-visual gate (plan 022 §4
 * new-feature-type checklist). This is the coverage guard for the river types
 * added in plan 022-B. */
const RIVER_LAYER_IDS = ["generated-river-channel", "generated-river-island"] as const;
const FOREST_LAYER_IDS = ["generated-forest-canopy", "generated-forest-clearing", "generated-forest-tree"] as const;

function fillColor(layer: LayerSpecification): string {
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
  const c = paint["fill-color"];
  expect(typeof c, `${layer.id} must paint a plain token color`).toBe("string");
  return (c as string).toLowerCase();
}

describe("generatedLayers — river channel/island paint coverage (plan 022 §4)", () => {
  it("both river layers exist, are fills on the generated source, filter on generatorId", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of RIVER_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect(layer!.type).toBe("fill");
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD
    }
  });

  it("island paints ABOVE the channel water (later in the array)", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    expect(ids.indexOf("generated-river-island")).toBeGreaterThan(ids.indexOf("generated-river-channel"));
  });

  it("river layers keep the generated- prefix so the z-order stack holds", () => {
    // assertLayerOrder throws if any id belongs to no group; the generated-
    // prefix keeps rivers in layer 1 (below sketch + locations).
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: channel and island both paint a color`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of RIVER_LAYER_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        expect(fillColor(layer).length).toBeGreaterThan(0);
      }
      // Channel water and island land must read differently.
      const channel = fillColor(layers.find((l) => l.id === "generated-river-channel")!);
      const island = fillColor(layers.find((l) => l.id === "generated-river-island")!);
      expect(channel, `${id}: channel and island share a color`).not.toBe(island);
    });
  }

  it("obsidian-native runtime style paints both river layers", () => {
    const css: ObsidianCssTokens = {
      backgroundPrimary: "#1e1e1e",
      backgroundSecondary: "#262626",
      backgroundModifierBorder: "#4d4d4d",
      textMuted: "#999999",
      textNormal: "#dcddde",
      interactiveAccent: "#7c3aed",
      fontText: "sans-serif",
    };
    const style = obsidianNativeStyle(css, "http://localhost/glyphs/{fontstack}/{range}.pbf");
    const ids = style.layers.map((l) => l.id);
    for (const id of RIVER_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

/** A generated color from either a fill or a circle layer. */
function anyColor(layer: LayerSpecification): string {
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
  const c = paint["fill-color"] ?? paint["circle-color"];
  expect(typeof c, `${layer.id} must paint a plain token color`).toBe("string");
  return (c as string).toLowerCase();
}

describe("generatedLayers — forest canopy/clearing/tree paint coverage (plan 022 §4)", () => {
  it("all three forest layers exist and filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FOREST_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"');
    }
  });

  it("clearing paints ABOVE the canopy, trees ABOVE both (later in the array)", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const canopy = ids.indexOf("generated-forest-canopy");
    const clearing = ids.indexOf("generated-forest-clearing");
    const tree = ids.indexOf("generated-forest-tree");
    expect(clearing).toBeGreaterThan(canopy);
    expect(tree).toBeGreaterThan(clearing);
  });

  it("forest layers keep the generated- prefix so the z-order stack holds", () => {
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: canopy, clearing and tree all paint a color`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of FOREST_LAYER_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        expect(anyColor(layer).length).toBeGreaterThan(0);
      }
      // Canopy woodland and a clearing (open ground) must read differently.
      const canopy = anyColor(layers.find((l) => l.id === "generated-forest-canopy")!);
      const clearing = anyColor(layers.find((l) => l.id === "generated-forest-clearing")!);
      expect(canopy, `${id}: canopy and clearing share a color`).not.toBe(clearing);
    });
  }

  it("obsidian-native runtime style paints all three forest layers", () => {
    const css: ObsidianCssTokens = {
      backgroundPrimary: "#1e1e1e",
      backgroundSecondary: "#262626",
      backgroundModifierBorder: "#4d4d4d",
      textMuted: "#999999",
      textNormal: "#dcddde",
      interactiveAccent: "#7c3aed",
      fontText: "sans-serif",
    };
    const style = obsidianNativeStyle(css, "http://localhost/glyphs/{fontstack}/{range}.pbf");
    const ids = style.layers.map((l) => l.id);
    for (const id of FOREST_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

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
/** Every emitted park feature type (plan 022 §3.3) needs paint in every theme —
 * ground (lawn/bed), path web, water (pond/island/bridge), gravel court, and the
 * rock + tree stipples. Coverage guard for the park types added in plan 022-D. */
const PARK_LAYER_IDS = [
  "generated-park-lawn",
  "generated-park-bed",
  "generated-park-court",
  "generated-park-path",
  "generated-park-pond",
  "generated-park-island",
  "generated-park-bridge",
  "generated-park-rock",
  "generated-park-tree",
] as const;

/** Every emitted wall feature type (plan 022 §3.4) needs paint in every theme:
 * the outboard moat, the masonry band, the tower/bastion footprints and the
 * gate markers. Coverage guard for the wall types added in plan 022-E. */
const WALL_LAYER_IDS = [
  "generated-wall-moat",
  "generated-wall-quad",
  "generated-wall-tower",
  "generated-wall-gate",
] as const;

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

describe("generatedLayers — park paint coverage (plan 022 §3.3)", () => {
  it("all nine park layers exist on the generated source and filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of PARK_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD (Jonah 2026-07-12)
    }
  });

  it("layers the composition top-down: lawn under everything, water/rocks above the ground", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const lawn = ids.indexOf("generated-park-lawn");
    const path = ids.indexOf("generated-park-path");
    const pond = ids.indexOf("generated-park-pond");
    const island = ids.indexOf("generated-park-island");
    const bridge = ids.indexOf("generated-park-bridge");
    const court = ids.indexOf("generated-park-court");
    const rock = ids.indexOf("generated-park-rock");
    // Ground first; path above ground; pond above path; island above pond water;
    // bridge above the island; a rock reads on top of its gravel court.
    expect(path).toBeGreaterThan(lawn);
    expect(pond).toBeGreaterThan(path);
    expect(island).toBeGreaterThan(pond);
    expect(bridge).toBeGreaterThan(island);
    expect(rock).toBeGreaterThan(court);
  });

  it("park layers keep the generated- prefix so the z-order stack holds", () => {
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: every park layer paints a color`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of PARK_LAYER_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        expect(anyColor(layer).length, `${id}: ${layerId} paints no color`).toBeGreaterThan(0);
      }
      // Lawn (open greensward) and pond (water) must read as different things.
      const lawn = anyColor(layers.find((l) => l.id === "generated-park-lawn")!);
      const pond = anyColor(layers.find((l) => l.id === "generated-park-pond")!);
      expect(lawn, `${id}: lawn and pond share a color`).not.toBe(pond);
    });
  }

  it("obsidian-native runtime style paints all nine park layers", () => {
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
    for (const id of PARK_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

describe("generatedLayers — wall moat/band/tower/gate paint coverage (plan 022 §3.4)", () => {
  it("all four wall layers exist on the generated source and filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of WALL_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD (Jonah 2026-07-12)
    }
  });

  it("layers the wall bottom-up: moat under the band, band under the towers", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const moat = ids.indexOf("generated-wall-moat");
    const quad = ids.indexOf("generated-wall-quad");
    const tower = ids.indexOf("generated-wall-tower");
    expect(quad).toBeGreaterThan(moat);
    expect(tower).toBeGreaterThan(quad);
  });

  it("wall layers keep the generated- prefix so the z-order stack holds", () => {
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: every wall layer paints a color`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of WALL_LAYER_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        expect(anyColor(layer).length, `${id}: ${layerId} paints no color`).toBeGreaterThan(0);
      }
      // The masonry band (stone) and the moat (water) must read as different things.
      const band = anyColor(layers.find((l) => l.id === "generated-wall-quad")!);
      const moat = anyColor(layers.find((l) => l.id === "generated-wall-moat")!);
      expect(band, `${id}: band and moat share a color`).not.toBe(moat);
    });
  }

  it("obsidian-native runtime style paints all four wall layers", () => {
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
    for (const id of WALL_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

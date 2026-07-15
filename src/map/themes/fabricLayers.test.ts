import { describe, it, expect } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { fabricLayers, FABRIC_LAYER_IDS, FABRIC_SOURCE_SPEC } from "./fabricLayers";
import { HANDCRAFTED_THEMES, PARCHMENT } from "./tokens";
import { obsidianNativeStyle, type ObsidianCssTokens } from "../theme";
import { FABRIC_KINDS, isPolygonKind, type FabricKind } from "../../model/fabric";

describe("fabricLayers — always visible, no zoom LOD", () => {
  const layers = fabricLayers(PARCHMENT);

  it("emits exactly one layer per fabric kind, on the fabric source", () => {
    expect(layers).toHaveLength(FABRIC_KINDS.length);
    const ids = layers.map((l) => l.id);
    for (const id of FABRIC_LAYER_IDS) expect(ids).toContain(id);
    for (const l of layers) expect((l as { source?: string }).source).toBe("fabric");
  });

  it("NO layer carries a minzoom — fabric renders at every zoom", () => {
    // LOD may only hide location NAMES, never fabric. A per-kind minzoom here is
    // exactly the regression we removed (parks/walls vanishing when zoomed out).
    for (const kind of FABRIC_KINDS) {
      const layer = layers.find((l) => l.id === `fabric-${kind}`) as { minzoom?: number };
      expect(layer?.minzoom).toBeUndefined();
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
    // error). Fabric has no zoom gating at all, so filters are purely kind.
    for (const layer of layers) {
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).not.toContain('"zoom"');
      expect(filter).toContain('"kind"');
    }
  });

  it("source spec carries simplification tolerance", () => {
    expect(FABRIC_SOURCE_SPEC.type).toBe("geojson");
    expect(FABRIC_SOURCE_SPEC.tolerance).toBeGreaterThan(0);
  });
});

describe("sea-mode landform paints theme water (shortlist 5)", () => {
  // The fabric mirror lifts the procgen `mode` to a `landformMode` property; the
  // landform layer paints a SEA as theme water while plateau/basin keep the
  // relief wash. Guard the case expressions resolve to the right tokens.
  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: sea → water fill (nonzero opacity); plateau/basin → mountain wash`, () => {
      const landform = fabricLayers(tokens).find((l) => l.id === "fabric-landform")!;
      const paint = (landform as { paint: Record<string, unknown> }).paint;
      const evalCase = (expr: unknown, mode: string | null, hasProcgen: boolean): unknown => {
        // Minimal evaluator for the ["case", cond, out, ...default] shapes used.
        const a = expr as unknown[];
        if (!Array.isArray(a) || a[0] !== "case") return expr;
        for (let i = 1; i + 1 < a.length; i += 2) {
          const cond = a[i] as unknown[];
          const op = cond[0];
          const hit =
            op === "==" ? mode === (cond[2] as string) : op === "has" ? hasProcgen : false;
          if (hit) return a[i + 1];
        }
        return a[a.length - 1];
      };
      // Sea: water fill, water opacity 0.7, river-hued shore.
      expect(evalCase(paint["fill-color"], "sea", true)).toBe(tokens.fabricWater);
      expect(evalCase(paint["fill-opacity"], "sea", true)).toBe(0.7);
      expect(evalCase(paint["fill-outline-color"], "sea", true)).toBe(tokens.fabricRiver);
      // Plateau with a procgen block: inert (opacity 0), mountain hue.
      expect(evalCase(paint["fill-color"], "plateau", true)).toBe(tokens.fabricMountain);
      expect(evalCase(paint["fill-opacity"], "plateau", true)).toBe(0);
      // Bare landform (no procgen, no mode): the subtle mountain wash.
      expect(evalCase(paint["fill-opacity"], null, false)).toBe(0.2);
    });
  }
});

describe("fabric kinds are visibly distinct per theme", () => {
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

  // The terrain-stamp kinds (plan 036: relief, landform) DELIBERATELY share the
  // mountain relief hue — their visible form is the composed-field contours
  // (036-C), not a distinct fill, so a dedicated token would add nothing
  // readable. They are excluded from the distinct-color guard, which still
  // covers every kind the GM draws as its own coloured shape.
  const DISTINCT_KINDS = FABRIC_KINDS.filter((k) => k !== "relief" && k !== "landform");

  function expectSixDistinctColors(themeId: string, layers: LayerSpecification[]) {
    const colors = DISTINCT_KINDS.map((kind) => {
      const layer = layers.find((l) => l.id === `fabric-${kind}`)!;
      return primaryColor(layer);
    });
    expect(new Set(colors).size, `${themeId} fabric colors collide: ${colors.join(", ")}`).toBe(
      DISTINCT_KINDS.length
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

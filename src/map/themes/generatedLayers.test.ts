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
const RIVER_LAYER_IDS = ["generated-river-bank", "generated-river-channel", "generated-river-island"] as const;
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

/** The bank casing's line-color (plan 028 §1.1) — river-block-local helper. */
function bankLineColor(layer: LayerSpecification): string {
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
  const c = paint["line-color"];
  expect(typeof c, `${layer.id} must paint a plain line color`).toBe("string");
  return (c as string).toLowerCase();
}

describe("generatedLayers — river bank/channel/island paint coverage (plan 022 §4 + plan 028 §1.1)", () => {
  it("all three river layers exist on the generated source, filter on generatorId, no zoom LOD", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of RIVER_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      // Bank casing is a LINE layer; channel + island stay fills.
      expect(layer!.type).toBe(id === "generated-river-bank" ? "line" : "fill");
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD
    }
  });

  it("depth idiom order: bank casing UNDER channel, island ABOVE channel (plan 028 §1.1)", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    expect(ids.indexOf("generated-river-bank")).toBeLessThan(ids.indexOf("generated-river-channel"));
    expect(ids.indexOf("generated-river-island")).toBeGreaterThan(ids.indexOf("generated-river-channel"));
  });

  it("river layers keep the generated- prefix so the z-order stack holds", () => {
    // assertLayerOrder throws if any id belongs to no group; the generated-
    // prefix keeps rivers in layer 1 (below sketch + locations).
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: bank, channel and island all paint (existing tokens only)`, () => {
      const layers = generatedLayers(tokens);
      // Channel water and island land must read differently.
      const channel = fillColor(layers.find((l) => l.id === "generated-river-channel")!);
      const island = fillColor(layers.find((l) => l.id === "generated-river-island")!);
      expect(channel, `${id}: channel and island share a color`).not.toBe(island);
      // Bank casing: a deliberate DARKER stroke of the channel hue (the
      // dark-edge/light-core depth idiom) — never the channel color itself.
      const bank = bankLineColor(layers.find((l) => l.id === "generated-river-bank")!);
      expect(bank.length).toBeGreaterThan(0);
      expect(bank, `${id}: bank casing must differ from the channel fill`).not.toBe(channel);
      // Channel fill must stay EXACTLY the theme's river token (hue
      // discipline, plan 028 §1.1: water-hued paint never drifts, so
      // fill/line overlaps never artifact).
      expect(channel).toBe(tokens.fabricRiver.toLowerCase());
    });
  }

  it("obsidian-native runtime style paints all three river layers", () => {
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

describe("generatedLayers — forest canopy/clearing/glyph-tree paint coverage (plan 026-C §1.3)", () => {
  // Local id lists: plan 026-C replaced the 026-A shadow/base/highlight CIRCLE
  // stack with TWO SYMBOL layers drawing per-variety SDF tree glyphs — a dark
  // `icon-translate` shadow below, and the variety-tinted base with an
  // `icon-halo` rim above (highlight folds into the halo).
  const FOREST_FILL_IDS = ["generated-forest-canopy", "generated-forest-clearing"] as const;
  const FOREST_TREE_IDS = ["generated-forest-tree-shadow", "generated-forest-tree"] as const;
  const FOREST_RIM_ID = "generated-forest-rim"; // plan 026-B: canopy outline line
  const FOREST_ALL_IDS = [...FOREST_FILL_IDS, FOREST_RIM_ID, ...FOREST_TREE_IDS];

  /** Read a variety's colour out of a `["match", ["get","forestType"], …]`. */
  function matchColor(expr: unknown, variety: string): string | undefined {
    if (!Array.isArray(expr) || expr[0] !== "match") return undefined;
    for (let i = 2; i + 1 < expr.length; i += 2) {
      if (expr[i] === variety) return String(expr[i + 1]).toLowerCase();
    }
    return undefined;
  }

  it("all five forest layers exist, on the generated source, filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FOREST_ALL_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"');
    }
  });

  it("the two tree layers are symbols; the two ground layers are fills; the rim is a line", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FOREST_TREE_IDS) expect(layers.find((l) => l.id === id)!.type).toBe("symbol");
    for (const id of FOREST_FILL_IDS) expect(layers.find((l) => l.id === id)!.type).toBe("fill");
    expect(layers.find((l) => l.id === FOREST_RIM_ID)!.type).toBe("line");
  });

  it("tree glyph symbol layers skip collision detection and y-sort (allow-overlap/ignore-placement/viewport-y), no minzoom", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FOREST_TREE_IDS) {
      const layout = (layers.find((l) => l.id === id)! as { layout?: Record<string, unknown> }).layout!;
      expect(layout["icon-allow-overlap"], `${id} must allow overlap`).toBe(true);
      expect(layout["icon-ignore-placement"], `${id} must ignore placement`).toBe(true);
      expect(layout["symbol-z-order"], `${id} must y-sort`).toBe("viewport-y");
      // icon-image is the data-driven tree-<forestType>-<variant> expression.
      expect(Array.isArray(layout["icon-image"]), `${id} icon-image must be an expression`).toBe(true);
    }
  });

  it("tree opacity fades by rank via a step (no minzoom gate; density is paint)", () => {
    const base = generatedLayers(PARCHMENT).find((l) => l.id === "generated-forest-tree")!;
    const opacity = JSON.stringify((base as { paint?: Record<string, unknown> }).paint!["icon-opacity"]);
    expect(opacity).toContain('"step"');
    expect(opacity).toContain('"rank"');
    expect(opacity).not.toContain('"minzoom"');
  });

  it("z-stack order: canopy < rim < clearing < tree shadow < base", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const order = [
      "generated-forest-canopy",
      "generated-forest-rim",
      "generated-forest-clearing",
      "generated-forest-tree-shadow",
      "generated-forest-tree",
    ];
    for (let i = 1; i < order.length; i++) {
      expect(ids.indexOf(order[i]), `${order[i]} must paint above ${order[i - 1]}`).toBeGreaterThan(
        ids.indexOf(order[i - 1])
      );
    }
  });

  it("forest layers sit after river and before park, keeping the generated- prefix z-stack", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    expect(ids.indexOf("generated-forest-canopy")).toBeGreaterThan(ids.indexOf("generated-river-channel"));
    expect(ids.indexOf("generated-forest-tree")).toBeLessThan(ids.indexOf("generated-park-lawn"));
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  it("no forest layer carries a minzoom/maxzoom gate (density is paint, never zoom)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FOREST_ALL_IDS) {
      const layer = layers.find((l) => l.id === id)! as { minzoom?: number; maxzoom?: number };
      expect(layer.minzoom, `${id} must not gate on minzoom`).toBeUndefined();
      expect(layer.maxzoom, `${id} must not gate on maxzoom`).toBeUndefined();
    }
  });

  it("canopy disables fill-antialias (kills the per-cell hairline lattice)", () => {
    const canopy = generatedLayers(PARCHMENT).find((l) => l.id === "generated-forest-canopy")!;
    expect((canopy as { paint?: Record<string, unknown> }).paint!["fill-antialias"]).toBe(false);
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: canopy/clearing read differently; trees tint per variety`, () => {
      const layers = generatedLayers(tokens);
      // Ground fills: plain token colours, canopy ≠ clearing.
      const canopy = fillColor(layers.find((l) => l.id === "generated-forest-canopy")!);
      const clearing = fillColor(layers.find((l) => l.id === "generated-forest-clearing")!);
      expect(canopy, `${id}: canopy and clearing share a colour`).not.toBe(clearing);

      // Every tree glyph layer tints via a data-driven per-variety `icon-color`
      // match on forestType (SDF glyphs are tinted at draw time, plan 026-C).
      for (const treeId of FOREST_TREE_IDS) {
        const color = (layers.find((l) => l.id === treeId)! as { paint?: Record<string, unknown> }).paint![
          "icon-color"
        ];
        expect(Array.isArray(color), `${id}:${treeId} icon-color must be a match expression`).toBe(true);
        expect((color as unknown[])[0]).toBe("match");
      }

      // The base tint must be visibly distinct across the varieties (hue carries
      // the read before glyphs do). Derived by relative moves from fabricForest,
      // so this must hold in the dark themes too, not just parchment.
      const baseColor = (layers.find((l) => l.id === "generated-forest-tree")! as {
        paint?: Record<string, unknown>;
      }).paint!["icon-color"];
      const variants = ["broadleaf", "conifer", "swamp", "dead-wood"].map((v) => matchColor(baseColor, v));
      for (const c of variants) expect(c, `${id}: a variety tint failed to resolve`).toBeDefined();
      expect(new Set(variants).size, `${id}: variety tints collapsed to the same colour`).toBe(variants.length);
    });
  }

  it("obsidian-native runtime style paints all forest layers", () => {
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
    for (const id of FOREST_ALL_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

describe("generatedLayers — park paint coverage (plan 022 §3.3 + 027-A)", () => {
  // Plan 027-A adds the second-green CANOPY and splits the old park-path fill
  // into a CASED path (casing line under fill line) + a pond SHORE casing. The
  // top-of-file PARK_LAYER_IDS const is shared file surface (sits by the
  // forest/river consts 26-A/28-A may touch) — spread it here so all park edits
  // stay inside this describe block.
  const PARK_IDS = [
    ...PARK_LAYER_IDS,
    "generated-park-canopy",
    "generated-park-canopy-rim", // plan 027-C: seam-safe organic-canopy outline
    "generated-park-court-rake", // plan 027-C: karesansui raked-gravel furrows
    "generated-park-path-casing",
    "generated-park-pond-shore",
    "generated-park-point", // plan 027-B point dressing (fountain/bandstand/monument/lantern/teahouse)
  ] as const;
  // Plan 027-C: rocks / trees / landmark points are now SDF-glyph SYMBOL layers
  // (icon-image + icon-color), not circles — they colour via `icon-color`, so the
  // fill/line/circle `hasColor` probe doesn't apply. Split them out.
  const PARK_SYMBOL_IDS = ["generated-park-tree", "generated-park-rock", "generated-park-point"] as const;
  const hasIconImage = (layer: LayerSpecification): boolean => {
    const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {};
    const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
    return layer.type === "symbol" && layout["icon-image"] != null && paint["icon-color"] != null;
  };

  it("all park layers exist on the generated source and filter on generatorId (no zoom LOD in filter)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of PARK_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD in the FILTER (Jonah 2026-07-12)
    }
  });

  it("the merged lawn is ONE fill (no per-cell lattice) and the path is a cased LINE pair", () => {
    const layers = generatedLayers(PARCHMENT);
    // Ground: a single fill filtered on park-lawn (the 027-A merged polygon).
    expect(layers.find((l) => l.id === "generated-park-lawn")!.type).toBe("fill");
    // Path: BOTH the casing and the fill are line layers filtered on park-path.
    const casing = layers.find((l) => l.id === "generated-park-path-casing")!;
    const fill = layers.find((l) => l.id === "generated-park-path")!;
    expect(casing.type).toBe("line");
    expect(fill.type).toBe("line");
    for (const l of [casing, fill]) {
      expect(JSON.stringify((l as { filter?: unknown }).filter)).toContain("park-path");
    }
  });

  it("layers the composition top-down: lawn under canopy; path casing UNDER path fill; shore ABOVE pond", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const lawn = ids.indexOf("generated-park-lawn");
    const canopy = ids.indexOf("generated-park-canopy");
    const casing = ids.indexOf("generated-park-path-casing");
    const path = ids.indexOf("generated-park-path");
    const pond = ids.indexOf("generated-park-pond");
    const shore = ids.indexOf("generated-park-pond-shore");
    const island = ids.indexOf("generated-park-island");
    const bridge = ids.indexOf("generated-park-bridge");
    const court = ids.indexOf("generated-park-court");
    const rock = ids.indexOf("generated-park-rock");
    const tree = ids.indexOf("generated-park-tree");
    const point = ids.indexOf("generated-park-point");
    // Ground first; canopy (second green) above the lawn.
    expect(canopy).toBeGreaterThan(lawn);
    // Cased path: the darker casing paints UNDER the lighter fill line.
    expect(casing).toBeGreaterThan(lawn);
    expect(path).toBeGreaterThan(casing);
    // Pond above the path; shore casing ABOVE the pond fill (a rim, not an
    // under-casing); island above the pond water; bridge above the island.
    expect(pond).toBeGreaterThan(path);
    expect(shore).toBeGreaterThan(pond);
    expect(island).toBeGreaterThan(shore);
    expect(bridge).toBeGreaterThan(island);
    // A rock reads on top of its gravel court.
    expect(rock).toBeGreaterThan(court);
    // Point dressing (landmarks) reads on top of the greenery stipple.
    expect(point).toBeGreaterThan(tree);
    // Plan 027-C: canopy rim above the canopy fill; the rake above the court wash.
    expect(ids.indexOf("generated-park-canopy-rim")).toBeGreaterThan(canopy);
    expect(ids.indexOf("generated-park-court-rake")).toBeGreaterThan(court);
  });

  it("park layers keep the generated- prefix so the z-order stack holds", () => {
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: every park layer paints a color (fills, cased lines, glyph symbols)`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of PARK_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        if ((PARK_SYMBOL_IDS as readonly string[]).includes(layerId)) {
          // Glyph symbol layers tint via icon-color, not fill/circle/line color.
          expect(hasIconImage(layer), `${id}: ${layerId} is not a tinted glyph symbol`).toBe(true);
        } else {
          expect(hasColor(layer), `${id}: ${layerId} paints no color`).toBe(true);
        }
      }
      // Lawn (open greensward) and pond (water) must read as different things,
      // and the second-green canopy must read distinct from the lawn.
      const lawn = anyColor(layers.find((l) => l.id === "generated-park-lawn")!);
      const pond = anyColor(layers.find((l) => l.id === "generated-park-pond")!);
      const canopy = anyColor(layers.find((l) => l.id === "generated-park-canopy")!);
      expect(lawn, `${id}: lawn and pond share a color`).not.toBe(pond);
      expect(canopy, `${id}: lawn and canopy share a color (no figure-ground)`).not.toBe(lawn);
    });
  }

  it("obsidian-native runtime style paints all park layers (incl. canopy + casings)", () => {
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
    for (const id of PARK_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
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

/** Every emitted farmland feature type (plan 022 §3.5) needs paint in every
 * theme: the tilled fields, the lane web, the field-edge hedges/fences, the
 * farmstead footprints and the orchard tree stipple. Coverage guard for the
 * farmland types added in plan 022-F. Two of these are LINE layers and
 * `generated-farm-hedge` paints `line-color` as a `["match", …]` expression —
 * the loose helper below reads fill/circle/line color and validates the match
 * outputs, unlike the fill-only `anyColor`. */
const FARM_LAYER_IDS = [
  "generated-farm-field",
  "generated-farm-bank", // paddy terrace bunds (box 23-E)
  "generated-farm-lane",
  "generated-farm-hedge",
  "generated-farm-building",
  "generated-orchard-tree",
] as const;

/** A non-empty color from a fill, circle, or line layer — accepts a plain token
 * string OR a `["match", …]` expression (validating every non-keyword string
 * output is non-empty). */
function hasColor(layer: LayerSpecification): boolean {
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {};
  const c = paint["fill-color"] ?? paint["circle-color"] ?? paint["line-color"];
  if (typeof c === "string") return c.length > 0;
  if (Array.isArray(c)) {
    // match expr: ["match", input, label1, out1, …, fallback] — every string
    // that isn't the "match"/"get" keyword head must be a non-empty color.
    const strings = c.filter((x, i) => typeof x === "string" && i > 0) as string[];
    return strings.length > 0 && strings.every((s) => s.length > 0);
  }
  return false;
}

describe("generatedLayers — farmland field/lane/hedge/building/tree paint coverage (plan 022 §3.5)", () => {
  it("all six farmland layers exist on the generated source and filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of FARM_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD (Jonah 2026-07-12)
    }
  });

  it("farm stack sits BELOW the district/street layers (farmland is stage 2, city stage 3)", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const field = ids.indexOf("generated-farm-field");
    const district = ids.indexOf("generated-district");
    // Lanes/hedges/buildings/trees paint above the field fill, below the city.
    expect(ids.indexOf("generated-farm-lane")).toBeGreaterThan(field);
    expect(ids.indexOf("generated-farm-building")).toBeGreaterThan(field);
    expect(ids.indexOf("generated-orchard-tree")).toBeGreaterThan(field);
    if (district >= 0) expect(field).toBeLessThan(district);
  });

  it("farmland layers keep the generated- prefix so the z-order stack holds", () => {
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: every farmland layer paints a color`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of FARM_LAYER_IDS) {
        const layer = layers.find((l) => l.id === layerId)!;
        expect(hasColor(layer), `${id}: ${layerId} paints no color`).toBe(true);
      }
      // Tilled field (cultivated tan) and orchard tree (woodland green) must read
      // as different things — distinct token families in every theme.
      const field = fillColor(layers.find((l) => l.id === "generated-farm-field")!);
      const tree = (
        (layers.find((l) => l.id === "generated-orchard-tree")!.paint as Record<string, unknown>)[
          "circle-color"
        ] as string
      ).toLowerCase();
      expect(field, `${id}: field and orchard tree share a color`).not.toBe(tree);
    });
  }

  it("obsidian-native runtime style paints all six farmland layers", () => {
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
    for (const id of FARM_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

/** Every emitted mountain feature type (plan 023 §3 + §4.1) needs paint in
 * every theme: the rocky massif fill, the topographic contour iso-lines (LINE),
 * the downslope hachure ticks (LINE) and the summit peak markers (CIRCLE).
 * Coverage guard for the mountain types added in plan 023-B/23-C. */
const MOUNTAIN_LAYER_IDS = [
  "generated-mountain-massif",
  "generated-mountain-contour",
  "generated-mountain-hachure",
  "generated-mountain-peak",
] as const;

describe("generatedLayers — mountain massif/contour/hachure/peak paint coverage (plan 023 §3 + §4.1)", () => {
  it("all mountain layers exist on the generated source and filter on generatorId (no zoom LOD)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of MOUNTAIN_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id);
      expect(layer, `${id} missing from generatedLayers`).toBeDefined();
      expect((layer as { source?: string }).source).toBe("generated");
      const filter = JSON.stringify((layer as { filter?: unknown }).filter);
      expect(filter).toContain('"generatorId"');
      expect(filter).not.toContain('"zoom"'); // NO zoom LOD (Jonah 2026-07-12)
    }
  });

  it("massif is a fill, contour + hachure are lines, peak a circle", () => {
    const layers = generatedLayers(PARCHMENT);
    expect(layers.find((l) => l.id === "generated-mountain-massif")!.type).toBe("fill");
    expect(layers.find((l) => l.id === "generated-mountain-contour")!.type).toBe("line");
    expect(layers.find((l) => l.id === "generated-mountain-hachure")!.type).toBe("line");
    expect(layers.find((l) => l.id === "generated-mountain-peak")!.type).toBe("circle");
  });

  it("layers relief bottom-up: massif under contour under hachure under peak", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    expect(ids.indexOf("generated-mountain-contour")).toBeGreaterThan(ids.indexOf("generated-mountain-massif"));
    expect(ids.indexOf("generated-mountain-hachure")).toBeGreaterThan(ids.indexOf("generated-mountain-contour"));
    expect(ids.indexOf("generated-mountain-peak")).toBeGreaterThan(ids.indexOf("generated-mountain-hachure"));
  });

  it("mountain block is BASE TERRAIN: sits before the farm/city stack, keeps the generated- prefix", () => {
    const ids = generatedLayers(PARCHMENT).map((l) => l.id);
    const massif = ids.indexOf("generated-mountain-massif");
    const farm = ids.indexOf("generated-farm-field");
    const district = ids.indexOf("generated-district");
    if (farm >= 0) expect(massif).toBeLessThan(farm);
    if (district >= 0) expect(massif).toBeLessThan(district);
    expect(() => assertLayerOrder(generatedLayers(PARCHMENT))).not.toThrow();
  });

  it("no mountain layer carries a minzoom/maxzoom gate (density is paint, never zoom)", () => {
    const layers = generatedLayers(PARCHMENT);
    for (const id of MOUNTAIN_LAYER_IDS) {
      const layer = layers.find((l) => l.id === id)! as { minzoom?: number; maxzoom?: number };
      expect(layer.minzoom, `${id} must not gate on minzoom`).toBeUndefined();
      expect(layer.maxzoom, `${id} must not gate on maxzoom`).toBeUndefined();
    }
  });

  for (const [id, tokens] of Object.entries(HANDCRAFTED_THEMES)) {
    it(`${id}: every mountain layer paints a color; massif ≠ hachure (dark-line relief)`, () => {
      const layers = generatedLayers(tokens);
      for (const layerId of MOUNTAIN_LAYER_IDS) {
        expect(hasColor(layers.find((l) => l.id === layerId)!), `${id}: ${layerId} paints no color`).toBe(true);
      }
      const massif = fillColor(layers.find((l) => l.id === "generated-mountain-massif")!);
      // Massif fill must stay EXACTLY the theme's mountain token (hue discipline).
      expect(massif).toBe(tokens.fabricMountain.toLowerCase());
      // Hachures are a DARKER stroke of the massif hue — never the massif color.
      const hachure = bankLineColor(layers.find((l) => l.id === "generated-mountain-hachure")!);
      expect(hachure, `${id}: hachure must differ from the massif fill`).not.toBe(massif);
    });
  }

  it("obsidian-native runtime style paints all mountain layers", () => {
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
    for (const id of MOUNTAIN_LAYER_IDS) expect(ids, `obsidian-native missing ${id}`).toContain(id);
  });
});

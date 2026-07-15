import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { roleColorsForTheme, type RoleColors } from "./roleColors";
import { ALL_STYLE_CONTRACTS, type BucketStyle } from "../../gen/procgen/styleContract";
import { riverIconImageExpr } from "../riverGlyphs";
import { treeIconImageExpr } from "../treeGlyphs";
import { parkPointIconExpr, parkRockIconExpr, parkTreeIconExpr } from "../parkGlyphs";

/**
 * The one generic paint builder: the style contract × the per-theme role→color
 * map → the `generated` layer stack. It replaces the eight per-algorithm layer
 * files — every bucket's layers now come from a single recipe table keyed by
 * generator-id, and every color flows through a semantic role, so a theme has no
 * per-algorithm say and a new algorithm needs zero theme edits.
 *
 * Buckets emit in contract `z` order (globally unique across all contracts); a
 * multi-layer bucket (a cased path, a shadowed tree, a landmark/canal/gate
 * triple) emits its layers contiguously at its slot. A bucket the recipe table
 * doesn't name falls back to a generic mark→layer at full opacity — the property
 * that lets a new bucket paint in every theme with a one-line contract addition.
 *
 * Structure is per-gid (the recipes below carry each bucket's bespoke geometry —
 * width ramps, glyphs, relief shading); only COLOR is centralized into roles.
 * None of it branches on theme id — the heterogeneity is uniform across all five
 * themes, so there are no per-theme overrides.
 */

// ── Color helpers (shared, pure hex math — reused verbatim so derived colors are
// byte-stable) ───────────────────────────────────────────────────────────────

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function clampCh(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => clampCh(v).toString(16).padStart(2, "0")).join("");
}
function mul([r, g, b]: Rgb, [mr, mg, mb]: Rgb): Rgb {
  return [r * mr, g * mg, b * mb];
}
function scale(c: Rgb, f: number): Rgb {
  return mul(c, [f, f, f]);
}
function towardWhite([r, g, b]: Rgb, t: number): Rgb {
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
}
function desat([r, g, b]: Rgb, t: number): Rgb {
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  return [r + (l - r) * t, g + (l - g) * t, b + (l - b) * t];
}

/** River idiom: darken a hex toward black by `amount` (fraction), channel-wise. */
function riverDarken(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * (1 - amount))))
      .toString(16)
      .padStart(2, "0");
  return `#${ch((n >> 16) & 0xff)}${ch((n >> 8) & 0xff)}${ch(n & 0xff)}`;
}

/** Linear channel-wise hex blend `a*(1−t) + b*t` — the point-bar silt tone. */
function mix(a: string, b: string, t: number): string {
  const ma = /^#([0-9a-f]{6})$/i.exec(a);
  const mb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!ma || !mb) return a;
  const na = parseInt(ma[1], 16);
  const nb = parseInt(mb[1], 16);
  const ch = (sa: number, sb: number): string =>
    Math.max(0, Math.min(255, Math.round(sa * (1 - t) + sb * t)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch((na >> 16) & 0xff, (nb >> 16) & 0xff)}${ch((na >> 8) & 0xff, (nb >> 8) & 0xff)}${ch(na & 0xff, nb & 0xff)}`;
}

/** Relief idiom: scale toward black (`reliefDarken`) / mix toward white
 * (`reliefLighten`); `luma` is Rec. 601 luminance for the dark-map test. */
function reliefDarken(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * f, g * f, b * f]);
}
function reliefLighten(hex: string, tw: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r + (255 - r) * tw, g + (255 - g) * tw, b + (255 - b) * tw]);
}
function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

// ── Forest tree glyph machinery (per-variety tint + zoom ramps) ───────────────
const FOREST_VARIETIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;

function varietyColor(base: Rgb, variety: string): Rgb {
  switch (variety) {
    case "broadleaf":
      return mul(base, [1.14, 1.06, 0.8]);
    case "conifer":
      return scale(mul(base, [0.78, 0.92, 1.06]), 0.9);
    case "swamp":
      return scale(mul(desat(base, 0.35), [0.86, 1.0, 1.12]), 0.92);
    case "dead-wood":
      return mul(desat(base, 0.6), [1.18, 1.0, 0.72]);
    default:
      return base;
  }
}
function matchByVariety(base: Rgb, shade: (c: Rgb) => Rgb): unknown {
  const expr: unknown[] = ["match", ["get", "forestType"]];
  for (const v of FOREST_VARIETIES) {
    expr.push(v, rgbToHex(shade(varietyColor(base, v))));
  }
  expr.push(rgbToHex(shade(base)));
  return expr;
}

/** Per-feature street-width → px multiplier, kept OUTSIDE the zoom interpolate
 * (a pure data expression — MapLibre invalidates a style with `zoom` nested under
 * `["*", …]`). Floored 0.7, capped 6, normalised to the 12 m ordinary street. */
const W_MULT: unknown = [
  "max",
  0.7,
  [
    "min",
    6,
    [
      "/",
      [
        "coalesce",
        ["get", "width"],
        ["match", ["get", "roadClass"], ["major", "arterial"], 18, "ring", 16, ["alley", "court"], 5, 12],
      ],
      12,
    ],
  ],
];

// ── Layer assembly ───────────────────────────────────────────────────────────
interface LayerParts {
  id: string;
  type: string;
  filter: unknown;
  layout?: Record<string, unknown>;
  paint: Record<string, unknown>;
}
/** Assemble one layer in the canonical key order (id, type, source, filter,
 * [layout], paint). */
function L(def: LayerParts): LayerSpecification {
  const out: Record<string, unknown> = { id: def.id, type: def.type, source: "generated", filter: def.filter };
  if (def.layout) out.layout = def.layout;
  out.paint = def.paint;
  return out as unknown as LayerSpecification;
}
/** The `["==", ["get","generatorId"], gid]` filter every bucket keys on. */
function gidFilter(gid: string): unknown {
  return ["==", ["get", "generatorId"], gid];
}

type Recipe = (roles: RoleColors) => LayerSpecification[];

// Park glyph layout + halo (shared across the three park glyph layers).
function parkGlyphLayout(iconImage: unknown, anchor: "bottom" | "center", sizeStops: [number, number][]): Record<string, unknown> {
  return {
    "icon-image": iconImage,
    "icon-size": ["interpolate", ["linear"], ["zoom"], ...sizeStops.flatMap(([z, s]) => [z, s])],
    "icon-anchor": anchor,
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "icon-padding": 0,
    "symbol-z-order": "viewport-y",
  };
}
const PARK_HALO_WIDTH: unknown = ["interpolate", ["linear"], ["zoom"], 5.5, 0, 9, 1.6];

// ── Per-gid recipes ──────────────────────────────────────────────────────────
const RECIPES: Record<string, Recipe> = {
  // World tier ────────────────────────────────────────────────────────────────
  "world-region": (roles) => [
    L({
      id: "generated-region",
      type: "fill",
      filter: gidFilter("world-region"),
      paint: {
        "fill-color": [
          "match",
          ["get", "biome"],
          "ocean", roles["water-body"],
          "coast", roles["water-body"],
          roles.ground,
        ],
        "fill-opacity": 0.9,
      },
    }),
  ],
  "world-route": (roles) => [
    L({
      id: "generated-route",
      type: "line",
      filter: gidFilter("world-route"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": roles.route, "line-width": 1.5, "line-dasharray": [2, 2] },
    }),
  ],

  // Mountain ────────────────────────────────────────────────────────────────
  "mountain-massif": (roles) => [
    L({
      id: "generated-mountain-massif",
      type: "fill",
      filter: gidFilter("mountain-massif"),
      paint: { "fill-color": roles.relief, "fill-opacity": 0.45, "fill-antialias": false },
    }),
  ],
  "mountain-hachure": (roles) => {
    const darkMap = luma(roles.ground) < 128;
    const hachure = darkMap ? reliefLighten(roles.relief, 0.4) : reliefDarken(roles.relief, 0.5);
    return [
      L({
        id: "generated-mountain-hachure",
        type: "line",
        filter: gidFilter("mountain-hachure"),
        layout: { "line-cap": "round" },
        paint: {
          "line-color": hachure,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 14, 2.6],
          "line-opacity": 0.85,
        },
      }),
    ];
  },
  "mountain-peak": (roles) => {
    const darkMap = luma(roles.ground) < 128;
    const peak = darkMap ? reliefLighten(roles.relief, 0.55) : reliefDarken(roles.relief, 0.45);
    const peakRing = darkMap ? reliefDarken(roles.relief, 0.4) : reliefLighten(roles.relief, 0.7);
    return [
      L({
        id: "generated-mountain-peak",
        type: "circle",
        filter: gidFilter("mountain-peak"),
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "sizeN"], 0, 1.8, 1, 4.2],
          "circle-color": peak,
          "circle-opacity": 0.95,
          "circle-stroke-color": peakRing,
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.9,
        },
      }),
    ];
  },

  // Farmland ────────────────────────────────────────────────────────────────
  "farm-field": (roles) => [
    L({
      id: "generated-farm-field",
      type: "fill",
      filter: gidFilter("farm-field"),
      paint: { "fill-color": roles.cultivated, "fill-opacity": 0.7 },
    }),
  ],
  "farm-bank": (roles) => [
    L({
      id: "generated-farm-bank",
      type: "line",
      filter: gidFilter("farm-bank"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles.boundary,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 16, 1.4],
        "line-opacity": 0.75,
      },
    }),
  ],
  "farm-lane": (roles) => [
    L({
      id: "generated-farm-lane",
      type: "line",
      filter: gidFilter("farm-lane"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles.route,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 16, 2.5],
        "line-opacity": 0.85,
      },
    }),
  ],
  "farm-hedge": (roles) => [
    L({
      id: "generated-farm-hedge",
      type: "line",
      filter: gidFilter("farm-hedge"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "hedging"], "fences", roles.boundary, roles["vegetation-deep"]],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 16, 1.8],
        "line-opacity": 0.8,
      },
    }),
  ],
  "farm-building": (roles) => [
    L({
      id: "generated-farm-building",
      type: "fill",
      filter: gidFilter("farm-building"),
      paint: { "fill-color": roles.built, "fill-opacity": 0.7 },
    }),
  ],
  "orchard-tree": (roles) => [
    L({
      id: "generated-orchard-tree",
      type: "circle",
      filter: gidFilter("orchard-tree"),
      paint: { "circle-radius": 1.5, "circle-color": roles["vegetation-deep"], "circle-opacity": 0.95 },
    }),
  ],

  // City ──────────────────────────────────────────────────────────────────────
  // Settlement-ground MASK: the block faces (which tile the built area between
  // streets) painted as an opaque `ground` fill at the bottom of the generated
  // group (contract z −1). This knocks out the hillshade/contour relief that
  // otherwise smears across the street fabric, while the parcels/footprints/
  // district washes/streets paint on top and keep the warm settlement tone.
  // `fill-antialias:false` avoids hairline seams between adjacent block fills.
  "city-block": (roles) => [
    L({
      id: "generated-block",
      type: "fill",
      filter: gidFilter("city-block"),
      paint: { "fill-color": roles.ground, "fill-opacity": 1, "fill-antialias": false },
    }),
  ],
  "city-district": (roles) => [
    L({
      id: "generated-district",
      type: "fill",
      filter: gidFilter("city-district"),
      paint: { "fill-color": roles["built-accent"], "fill-opacity": 0.09 },
    }),
  ],
  "city-footprint": (roles) => [
    L({
      id: "generated-footprint",
      type: "fill",
      filter: gidFilter("city-footprint"),
      paint: { "fill-color": roles.built, "fill-opacity": 0.3 },
    }),
  ],
  "city-parcel": (roles) => [
    L({
      id: "generated-parcel",
      type: "line",
      filter: gidFilter("city-parcel"),
      paint: { "line-color": roles.built, "line-width": 0.5, "line-opacity": 0.35 },
    }),
  ],
  "city-landmark": (roles) => [
    L({
      id: "generated-landmark",
      type: "fill",
      filter: ["all", ["==", ["get", "generatorId"], "city-landmark"], ["==", ["geometry-type"], "Polygon"]],
      paint: {
        "fill-color": [
          "match",
          ["get", "type"],
          "plaza", roles.route,
          "wall", roles.boundary,
          "field", roles.vegetation,
          "court", roles.route,
          roles.built,
        ],
        "fill-opacity": ["match", ["get", "type"], "plaza", 0.25, "wall", 0.85, "field", 0.12, "court", 0.3, 0.5],
      },
    }),
    L({
      id: "generated-canal",
      type: "line",
      filter: [
        "all",
        ["==", ["get", "generatorId"], "city-landmark"],
        ["==", ["get", "type"], "canal"],
        ["==", ["geometry-type"], "LineString"],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles.water,
        "line-opacity": 0.85,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 12, 7, 18, 16],
      },
    }),
    L({
      id: "generated-gate",
      type: "circle",
      filter: [
        "all",
        ["==", ["get", "generatorId"], "city-landmark"],
        ["==", ["get", "type"], "gate"],
        ["==", ["geometry-type"], "Point"],
      ],
      paint: { "circle-radius": 3, "circle-color": roles.boundary, "circle-opacity": 0.9 },
    }),
  ],
  "city-street": (roles) => [
    L({
      id: "generated-street",
      type: "line",
      filter: ["match", ["get", "generatorId"], ["city-street", "sketch-corridor"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles.route,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["*", 1, W_MULT],
          12, ["*", 1.6, W_MULT],
          18, ["*", 3.5, W_MULT],
        ],
      },
    }),
  ],

  // River ─────────────────────────────────────────────────────────────────────
  "river-bank": (roles) => [
    L({
      id: "generated-river-bank",
      type: "line",
      filter: gidFilter("river-bank"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": riverDarken(roles.water, 0.3), "line-width": 1.6 },
    }),
  ],
  "river-channel": (roles) => [waterFill("generated-river-channel", "river-channel", roles)],
  "river-confluence": (roles) => [waterFill("generated-river-confluence", "river-confluence", roles)],
  "river-distributary": (roles) => [waterFill("generated-river-distributary", "river-distributary", roles)],
  "river-estuary": (roles) => [waterFill("generated-river-estuary", "river-estuary", roles)],
  "river-oxbow": (roles) => [waterFill("generated-river-oxbow", "river-oxbow", roles)],
  "river-island": (roles) => [
    L({
      id: "generated-river-island",
      type: "fill",
      filter: gidFilter("river-island"),
      paint: { "fill-color": roles.ground, "fill-opacity": 0.95 },
    }),
  ],
  "river-point-bar": (roles) => [
    L({
      id: "generated-river-point-bar",
      type: "fill",
      filter: gidFilter("river-point-bar"),
      paint: { "fill-color": mix(roles.ground, roles.cultivated, 0.6), "fill-opacity": 0.95 },
    }),
  ],
  "river-glyph": (roles) => [
    L({
      id: "generated-river-glyph",
      type: "symbol",
      filter: gidFilter("river-glyph"),
      layout: {
        "icon-image": riverIconImageExpr(),
        "icon-size": 0.55,
        "icon-rotate": ["get", "rotation"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": riverDarken(roles.water, 0.45) },
    }),
  ],

  // Forest ──────────────────────────────────────────────────────────────────
  "forest-canopy": (roles) => [
    L({
      id: "generated-forest-canopy",
      type: "fill",
      filter: gidFilter("forest-canopy"),
      paint: { "fill-color": roles["vegetation-deep"], "fill-opacity": 0.8, "fill-antialias": false },
    }),
  ],
  "forest-canopy-rim": (roles) => {
    const base = hexToRgb(roles["vegetation-deep"]);
    return [
      L({
        id: "generated-forest-rim",
        type: "line",
        filter: gidFilter("forest-canopy-rim"),
        paint: {
          "line-color": rgbToHex(scale(base, 0.62)),
          "line-width": 0.8,
          "line-opacity": 0.65,
        },
      }),
    ];
  },
  "forest-clearing": (roles) => [
    L({
      id: "generated-forest-clearing",
      type: "fill",
      filter: gidFilter("forest-clearing"),
      paint: { "fill-color": roles.ground, "fill-opacity": 0.85 },
    }),
  ],
  "forest-tree": (roles) => {
    const base = hexToRgb(roles["vegetation-deep"]);
    const sizeFactor: unknown = ["interpolate", ["linear"], ["get", "sizeN"], 0, 0.55, 1, 1.15];
    const iconSize: unknown = [
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["*", 0.18, sizeFactor],
      8,
      ["*", 0.58, sizeFactor],
      12,
      ["*", 1.0, sizeFactor],
    ];
    const iconRotate: unknown = [
      "match",
      ["get", "forestType"],
      "conifer",
      0,
      ["+", -12, ["*", ["to-number", ["get", "variant"]], 8]],
    ];
    const treeLayout = {
      "icon-image": treeIconImageExpr(),
      "icon-size": iconSize,
      "icon-rotate": iconRotate,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-padding": 0,
      "symbol-z-order": "viewport-y",
    };
    const rankStep: unknown = ["step", ["get", "rank"], 1, 1, 0.85, 2, 0.6];
    const iconOpacity: unknown = [
      "interpolate",
      ["linear"],
      ["zoom"],
      4,
      ["*", 0.85, rankStep],
      8,
      ["*", 1, rankStep],
    ];
    const haloWidth: unknown = ["interpolate", ["linear"], ["zoom"], 5.5, 0, 8, 1.7];
    const shadowOpacity: unknown = [
      "interpolate",
      ["linear"],
      ["zoom"],
      5.5,
      ["*", 0.05, rankStep],
      8,
      ["*", 0.3, rankStep],
    ];
    return [
      L({
        id: "generated-forest-tree-shadow",
        type: "symbol",
        filter: gidFilter("forest-tree"),
        layout: treeLayout,
        paint: {
          "icon-color": matchByVariety(base, (c) => scale(c, 0.35)),
          "icon-translate": [0.9, 1.1],
          "icon-opacity": shadowOpacity,
        },
      }),
      L({
        id: "generated-forest-tree",
        type: "symbol",
        filter: gidFilter("forest-tree"),
        layout: treeLayout,
        paint: {
          "icon-color": matchByVariety(base, (c) => towardWhite(c, 0.18)),
          "icon-halo-color": matchByVariety(base, (c) => towardWhite(c, 0.62)),
          "icon-halo-width": haloWidth,
          "icon-opacity": iconOpacity,
        },
      }),
    ];
  },

  // Park ──────────────────────────────────────────────────────────────────────
  "park-lawn": (roles) => [
    L({
      id: "generated-park-lawn",
      type: "fill",
      filter: gidFilter("park-lawn"),
      paint: { "fill-color": roles.vegetation, "fill-opacity": 0.6 },
    }),
  ],
  "park-canopy": (roles) => [
    L({
      id: "generated-park-canopy",
      type: "fill",
      filter: gidFilter("park-canopy"),
      paint: { "fill-color": roles["vegetation-deep"], "fill-opacity": 0.85, "fill-antialias": false },
    }),
  ],
  "park-canopy-rim": (roles) => [
    L({
      id: "generated-park-canopy-rim",
      type: "line",
      filter: gidFilter("park-canopy-rim"),
      paint: { "line-color": roles["path-casing"], "line-width": 0.8, "line-opacity": 0.55 },
    }),
  ],
  "park-bed": (roles) => [
    L({
      id: "generated-park-bed",
      type: "fill",
      filter: gidFilter("park-bed"),
      paint: { "fill-color": roles["vegetation-deep"], "fill-opacity": 0.7 },
    }),
  ],
  "park-court": (roles) => [
    L({
      id: "generated-park-court",
      type: "fill",
      filter: gidFilter("park-court"),
      paint: { "fill-color": roles.boundary, "fill-opacity": 0.4 },
    }),
  ],
  "park-court-rake": (roles) => [
    L({
      id: "generated-park-court-rake",
      type: "line",
      filter: gidFilter("park-court-rake"),
      layout: { "line-cap": "round" },
      paint: {
        "line-color": roles["path-casing"],
        "line-opacity": 0.5,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 15, 1.2],
      },
    }),
  ],
  "park-path": (roles) => [
    L({
      id: "generated-park-path-casing",
      type: "line",
      filter: gidFilter("park-path"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles["path-casing"],
        "line-opacity": 0.85,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 4, "loop", 3, "circuit", 2.6, "walk", 2.2, "roji", 1.8, 3],
          15, ["match", ["get", "class"], "axis", 9, "loop", 7, "circuit", 6, "walk", 5, "roji", 4, 6],
        ],
      },
    }),
    L({
      id: "generated-park-path",
      type: "line",
      filter: gidFilter("park-path"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": roles.route,
        "line-opacity": 0.95,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 2.4, "loop", 1.6, "circuit", 1.3, "walk", 1, "roji", 0.8, 1.6],
          15, ["match", ["get", "class"], "axis", 6, "loop", 4.5, "circuit", 3.6, "walk", 3, "roji", 2.4, 4],
        ],
      },
    }),
  ],
  "park-pond": (roles) => [
    L({
      id: "generated-park-pond",
      type: "fill",
      filter: gidFilter("park-pond"),
      paint: { "fill-color": roles["water-body"], "fill-opacity": 0.9 },
    }),
  ],
  "park-pond-shore": (roles) => [
    L({
      id: "generated-park-pond-shore",
      type: "line",
      filter: gidFilter("park-pond-shore"),
      layout: { "line-join": "round" },
      paint: {
        "line-color": roles["water-edge"],
        "line-opacity": 0.9,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 15, 2],
      },
    }),
  ],
  "park-island": (roles) => [
    L({
      id: "generated-park-island",
      type: "fill",
      filter: gidFilter("park-island"),
      paint: { "fill-color": roles.ground, "fill-opacity": 0.95 },
    }),
  ],
  "park-bridge": (roles) => [
    L({
      id: "generated-park-bridge",
      type: "fill",
      filter: gidFilter("park-bridge"),
      paint: { "fill-color": roles.boundary, "fill-opacity": 0.95 },
    }),
  ],
  "park-tree": (roles) => [
    L({
      id: "generated-park-tree",
      type: "symbol",
      filter: gidFilter("park-tree"),
      layout: parkGlyphLayout(parkTreeIconExpr(), "bottom", [
        [4, 0.16],
        [8, 0.5],
        [12, 0.85],
      ]),
      paint: {
        "icon-color": roles["vegetation-deep"],
        "icon-halo-color": roles.vegetation,
        "icon-halo-width": PARK_HALO_WIDTH,
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.85, 8, 1],
      },
    }),
  ],
  "park-rock": (roles) => [
    L({
      id: "generated-park-rock",
      type: "symbol",
      filter: gidFilter("park-rock"),
      layout: parkGlyphLayout(parkRockIconExpr(), "center", [
        [6, 0.2],
        [14, 0.6],
      ]),
      paint: {
        "icon-color": roles.boundary,
        "icon-halo-color": roles["path-casing"],
        "icon-halo-width": PARK_HALO_WIDTH,
        "icon-opacity": 1,
      },
    }),
  ],
  "park-point": (roles) => [
    L({
      id: "generated-park-point",
      type: "symbol",
      filter: gidFilter("park-point"),
      layout: parkGlyphLayout(parkPointIconExpr(), "bottom", [
        [5, 0.35],
        [14, 1],
      ]),
      paint: {
        "icon-color": [
          "match",
          ["get", "pointKind"],
          "fountain",
          roles["water-body"],
          "bandstand",
          roles.accent,
          "monument",
          roles.boundary,
          "lantern",
          roles.boundary,
          "teahouse",
          roles.boundary,
          roles.accent,
        ],
        "icon-halo-color": roles.ground,
        "icon-halo-width": PARK_HALO_WIDTH,
        "icon-opacity": 1,
      },
    }),
  ],

  // Wall ────────────────────────────────────────────────────────────────────
  // Give the 037/038 wall data MASS (shortlist 4). The band gets a darker casing
  // edge (double-line masonry read), the moat a fuller water ribbon with a shore
  // rim, the towers a cased edge, and the gate markers three distinct reads:
  // a water-hued sluice at water-gate crossings, a heavier stone gatehouse at
  // road gates (bearing present), a plain marker otherwise.
  // Glacis: a subtle outboard earthwork apron. Painted in the terrain/earth
  // (relief) hue at low opacity so it reads as a graded bank beyond the moat —
  // present but never competing with the masonry band or the moat ribbon.
  "wall-glacis": (roles) => [
    L({
      id: "generated-wall-glacis",
      type: "fill",
      filter: gidFilter("wall-glacis"),
      paint: { "fill-color": roles.relief, "fill-opacity": 0.22 },
    }),
  ],
  "wall-moat": (roles) => [
    L({
      id: "generated-wall-moat",
      type: "fill",
      filter: gidFilter("wall-moat"),
      // A crisp water ribbon: fuller fill + a shore rim (water-edge) so the moat
      // channel reads as a defined band hugging the wall, not a faint wash.
      paint: {
        "fill-color": roles["water-body"],
        "fill-opacity": 0.92,
        "fill-outline-color": roles["water-edge"],
      },
    }),
  ],
  "wall-quad": (roles) => {
    const casing = rgbToHex(scale(hexToRgb(roles.boundary), 0.55));
    return [
      L({
        id: "generated-wall-quad",
        type: "fill",
        // Masonry band with a darker casing edge — the fill + outline reads as a
        // parapet double-line, giving the thin band visual mass.
        filter: gidFilter("wall-quad"),
        paint: { "fill-color": roles.boundary, "fill-opacity": 0.95, "fill-outline-color": casing },
      }),
    ];
  },
  "wall-tower": (roles) => {
    const casing = rgbToHex(scale(hexToRgb(roles.boundary), 0.5));
    return [
      L({
        id: "generated-wall-tower",
        type: "fill",
        filter: gidFilter("wall-tower"),
        paint: { "fill-color": roles.boundary, "fill-opacity": 1, "fill-outline-color": casing },
      }),
    ];
  },
  "wall-gate": (roles) => {
    const stone = hexToRgb(roles.boundary);
    const gatehouseFill = rgbToHex(towardWhite(stone, 0.28)); // a lighter gatehouse mass
    const darkStone = rgbToHex(scale(stone, 0.5));
    return [
      L({
        id: "generated-wall-gate",
        type: "circle",
        filter: gidFilter("wall-gate"),
        paint: {
          // waterGate (river/canal pierces the wall) → a water-hued sluice;
          // bearing present (a road gate w/ gatehouse) → a heavier lighter stone
          // gatehouse; otherwise a plain gate marker.
          "circle-radius": ["case", ["has", "waterGate"], 3.4, ["has", "bearing"], 4.6, 3],
          "circle-color": ["case", ["has", "waterGate"], roles.water, ["has", "bearing"], gatehouseFill, roles.boundary],
          "circle-stroke-width": ["case", ["has", "bearing"], 1.6, 1.1],
          "circle-stroke-color": ["case", ["has", "waterGate"], roles["water-edge"], darkStone],
          "circle-opacity": 0.95,
        },
      }),
    ];
  },
};

/** Water-hued channel fills (channel/confluence/distributary/estuary/oxbow) —
 * all EXACTLY the river hue at full opacity (hue discipline: overlaps never
 * artifact). */
function waterFill(id: string, gid: string, roles: RoleColors): LayerSpecification {
  return L({ id, type: "fill", filter: gidFilter(gid), paint: { "fill-color": roles.water, "fill-opacity": 1 } });
}

/** A bucket the recipe table doesn't name: paint it generically from its mark +
 * role at full opacity. The property that lets a new contract bucket paint in
 * every theme with no recipe. */
function defaultLayers(b: BucketStyle, roles: RoleColors): LayerSpecification[] {
  const id = `generated-${b.gid}`;
  const color = roles[b.role];
  switch (b.mark) {
    case "line":
      return [
        L({
          id,
          type: "line",
          filter: gidFilter(b.gid),
          paint: { "line-color": color, "line-width": 1, ...(b.dashed ? { "line-dasharray": [2, 2] } : {}) },
        }),
      ];
    case "point":
      return [L({ id, type: "circle", filter: gidFilter(b.gid), paint: { "circle-radius": 3, "circle-color": color } })];
    case "fill+outline":
      return [
        L({ id, type: "fill", filter: gidFilter(b.gid), paint: { "fill-color": color, "fill-opacity": 1 } }),
        L({ id: `${id}-outline`, type: "line", filter: gidFilter(b.gid), paint: { "line-color": color, "line-width": 1 } }),
      ];
    default:
      return [L({ id, type: "fill", filter: gidFilter(b.gid), paint: { "fill-color": color, "fill-opacity": 1 } })];
  }
}

/**
 * Build the whole `generated` layer stack for a theme. Buckets from every
 * contract, painted in ascending `z` (a multi-layer bucket contiguous at its
 * slot); unpainted buckets contribute nothing. A bucket with no named recipe
 * paints generically from its mark + role, so a contract-only addition still
 * paints. `contracts` is overridable so a test can add a bucket without
 * touching the real contract.
 */
export function buildGeneratedLayers(
  t: ThemeTokens,
  contracts: readonly (readonly BucketStyle[])[] = ALL_STYLE_CONTRACTS
): LayerSpecification[] {
  const roles = roleColorsForTheme(t);
  const buckets = contracts.flat().filter((b) => !b.unpainted);
  buckets.sort((a, b) => a.z - b.z);
  const out: LayerSpecification[] = [];
  for (const b of buckets) {
    const recipe = RECIPES[b.gid];
    out.push(...(recipe ? recipe(roles) : defaultLayers(b, roles)));
  }
  return out;
}

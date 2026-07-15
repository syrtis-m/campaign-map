import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";
import { treeIconImageExpr } from "../../treeGlyphs";

/**
 * Forest fabric paint. Canopy first, then clearings, then a stacked shadow/base
 * tree glyph above. Forest is stage 2 (below city, stage 3): this block sorts
 * before the district/street/footprint layers in the emitted array, so a town
 * in the woods reads as a clearing without the forest ever seeing the city (the
 * one-direction rule). No zoom LOD — fabric renders at every zoom.
 *
 * All differentiation is theme-side (generators emit typed features only):
 *  - `fill-antialias: false` on the canopy kills MapLibre's per-polygon
 *    hairline, so the cell lattice stops showing through (mapbox-gl-js #4880).
 *  - Per-variety hues derived by RELATIVE channel moves from the theme's own
 *    `fabricForest` (broadleaf warm, conifer deep blue-green, swamp teal-muddy,
 *    dead-wood grey-brown; mixed = the base green) — Azgaar's biome-color
 *    principle: hue carries the read before glyphs do (`match` on `forestType`,
 *    no new tokens).
 *  - Trees are TWO SYMBOL layers drawing per-variety SDF tree glyphs
 *    (`src/map/treeGlyphs.ts`). `icon-image` is a data expression
 *    (`tree-<forestType>-<variant>`) so one layer draws every variety and its
 *    four hashed variants; `icon-color` tints the SDF per variety (same relative
 *    `fabricForest` moves), `icon-halo-color` (a lighter tint) is the rim
 *    highlight. A duplicated dark `icon-translate` layer below is the shared
 *    drop shadow (Here Dragons Abound's blob + offset shadow).
 *    `icon-allow-overlap` + `icon-ignore-placement` skip collision detection
 *    (the symbol perf cliff, maplibre #6192); `symbol-z-order: "viewport-y"` +
 *    `icon-anchor: "bottom"` paint southern trees over northern ones (painter's
 *    order) for free.
 *  - `icon-size` = `sizeN` factor × a gentle ZOOM ramp so trees shrink toward
 *    the fictional overview (~z4.5) instead of clotting into a mess, and
 *    `icon-opacity` = zoom ramp × a `rank` step (0 core / 1 fringe / 2 loner —
 *    loners fade first). Paint on `["zoom"]`, NOT a minzoom gate, so fabric
 *    still renders at every zoom.
 *  - `icon-rotate` jitters broadleaf/mixed/swamp/dead-wood a few degrees off
 *    the variant index; conifers stay upright (they read wrong tilted).
 */

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
/** Mix each channel toward the perceptual grey (Rec. 601 luma) by `t`. */
function desat([r, g, b]: Rgb, t: number): Rgb {
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  return [r + (l - r) * t, g + (l - g) * t, b + (l - b) * t];
}

const VARIETIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;

/** Per-variety base tint from the theme's woodland green — relative moves so
 * hue tracks the theme (Azgaar's biome-color principle: hue carries the read). */
function varietyColor(base: Rgb, variety: string): Rgb {
  switch (variety) {
    case "broadleaf":
      return mul(base, [1.14, 1.06, 0.8]); // warm, yellow-green
    case "conifer":
      return scale(mul(base, [0.78, 0.92, 1.06]), 0.9); // deep blue-green
    case "swamp":
      return scale(mul(desat(base, 0.35), [0.86, 1.0, 1.12]), 0.92); // teal-muddy
    case "dead-wood":
      return mul(desat(base, 0.6), [1.18, 1.0, 0.72]); // grey-brown, bare
    default:
      return base; // mixed — the plain canopy green
  }
}

/** A `["match", ["get","forestType"], …]` expression over the five varieties,
 * each variety's base tint passed through `shade` (identity for the base layer,
 * a darken for the shadow, a lighten for the highlight). */
function matchByVariety(base: Rgb, shade: (c: Rgb) => Rgb): unknown {
  const expr: unknown[] = ["match", ["get", "forestType"]];
  for (const v of VARIETIES) {
    expr.push(v, rgbToHex(shade(varietyColor(base, v))));
  }
  expr.push(rgbToHex(shade(base))); // fallback = the mixed/base shade
  return expr;
}

export function forestLayers(t: ThemeTokens): LayerSpecification[] {
  const base = hexToRgb(t.fabricForest);

  // ── Tree glyph symbol layout/paint ──────────────────────────────────────────
  // Shared layout for the shadow + base symbol layers (same glyph, same
  // placement — only the paint differs). icon-image is data-driven so ONE layer
  // draws every variety/variant; allow-overlap + ignore-placement skip collision
  // detection; viewport-y + bottom anchor y-sort the overlap.
  const iconImage = treeIconImageExpr();
  // sizeN → footprint factor (trees vary ≥2× in size).
  const sizeFactor: unknown = ["interpolate", ["linear"], ["get", "sizeN"], 0, 0.55, 1, 1.15];
  // icon-size = a gentle ZOOM ramp × sizeFactor (trees shrink toward the
  // fictional overview so a dense wood doesn't clot). MapLibre only allows the
  // `["zoom"]` expression as the DIRECT input to a top-level interpolate/step —
  // never nested in an arithmetic op — so the zoom interpolate is the outer
  // shell and the per-feature sizeFactor rides in each stop OUTPUT (a legal
  // zoom-and-property composite). NOT a minzoom gate: every tree renders at
  // every zoom, only the pixel footprint ramps.
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
  // Conifers upright; everything else jittered a few degrees off the variant.
  const iconRotate: unknown = [
    "match",
    ["get", "forestType"],
    "conifer",
    0,
    ["+", -12, ["*", ["to-number", ["get", "variant"]], 8]],
  ];
  const treeLayout = {
    "icon-image": iconImage,
    "icon-size": iconSize,
    "icon-rotate": iconRotate,
    "icon-anchor": "bottom",
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "icon-padding": 0,
    "symbol-z-order": "viewport-y",
  };
  // Opacity: a rank step (loner/fringe fade first) scaled by a gentle
  // zoom ramp. Same zoom-outer / property-inner composite as icon-size.
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
  // The halo rim + the drop shadow are the crisp-tree detailing — they only READ
  // when the glyph is near native size. At low zoom the glyph is downscaled and
  // MapLibre's SDF AA smears the halo/shadow into the buffer SQUARE (a pale/dark
  // box around each tree). So ramp both to ~0 toward the overview: the forest
  // then reads as a soft textured canopy far out (no boxes), and each tree gains
  // its lit rim + shadow as you zoom in. Pure `["zoom"]` interpolate = paint, not
  // a minzoom gate (the glyph itself still renders at every zoom).
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
    {
      // Woodland canopy fill (deeper `fabricForest` green — F2: a generated and
      // a sketched forest read as one class). `fill-antialias: false` removes
      // the per-polygon hairline so the cell lattice no longer shows through.
      // Canopy paints FIRST so clearings + trees layer above.
      id: "generated-forest-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.8, "fill-antialias": false },
    } as unknown as LayerSpecification,
    {
      // Canopy RIM: a slightly darker line tracing the canopy
      // outline — outer edge AND clearing-hole edges — so the organic silhouette
      // + glades read as drawn masses, not flat washes. Filters the SEPARATE
      // `forest-canopy-rim` LineString features (not the fill), so the tile clip
      // never strokes seam edges. NO zoom LOD.
      id: "generated-forest-rim",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-canopy-rim"],
      paint: {
        "line-color": rgbToHex(scale(base, 0.62)),
        "line-width": 0.8,
        "line-opacity": 0.65,
      },
    } as unknown as LayerSpecification,
    {
      // Forest clearings: open ground punched into the canopy — land hue,
      // painted ABOVE the canopy so the glade reads as a hole of ground.
      id: "generated-forest-clearing",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-clearing"],
      paint: { "fill-color": t.land, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Tree SHADOW: the same glyph, tinted dark and pushed
      // down-right by `icon-translate` — the shared drop shadow at the bottom of
      // the painter's stack (Here Dragons Abound's blob + offset shadow). No
      // halo. Emitted BEFORE the base so it paints underneath.
      id: "generated-forest-tree-shadow",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      layout: treeLayout,
      paint: {
        "icon-color": matchByVariety(base, (c) => scale(c, 0.35)),
        "icon-translate": [0.9, 1.1],
        // Soft, low opacity, and faded out toward the overview (shadowOpacity):
        // a depth cue when zoomed in, invisible far out where its downscaled AA
        // band would read as a dark box.
        "icon-opacity": shadowOpacity,
      },
    } as unknown as LayerSpecification,
    {
      // Tree BASE: the variety-tinted SDF glyph. `icon-color` is the
      // per-variety hue; `icon-halo-color` (a lighter tint) is the rim highlight
      // the old third circle layer gave. `icon-size` scales with sizeN × zoom;
      // `icon-opacity` fades loners/fringe first via the rank step (all trees
      // still render at every zoom — paint, not a minzoom gate).
      id: "generated-forest-tree",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      layout: treeLayout,
      paint: {
        // Lift the crown a touch brighter than the raw variety green so an
        // individual tree READS on top of the same-family canopy fill it sits on
        // (they derive from the same fabricForest — without the lift they blend).
        "icon-color": matchByVariety(base, (c) => towardWhite(c, 0.18)),
        "icon-halo-color": matchByVariety(base, (c) => towardWhite(c, 0.62)),
        // The bright rim = the sunlit-crown highlight the old third circle gave,
        // and it's the theme-robust contrast handle: a light rim + the dark
        // shadow below bracket the crown so each tree reads as a 3D object on the
        // same-family canopy whether the theme's canopy is dark or light. Ramped
        // to 0 toward the overview (haloWidth) so it doesn't smear into a box.
        "icon-halo-width": haloWidth,
        "icon-opacity": iconOpacity,
      },
    } as unknown as LayerSpecification,
  ];
}

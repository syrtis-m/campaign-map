import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Forest fabric paint (plan 022 §3.2, tree layers overhauled in plan 026-A).
 * Canopy first, clearings, then a stacked shadow/base/highlight tree glyph
 * above. Forest is stage 2 (below city, stage 3): this block sorts before the
 * district/street/footprint layers in the emitted array, so a town in the
 * woods reads as a clearing without the forest ever seeing the city (plan 022
 * §3.2 one-direction rule). NO zoom LOD (Jonah 2026-07-12).
 *
 * Plan 026-A changes (all theme-side — generators emit typed features only):
 *  - `fill-antialias: false` on the canopy kills MapLibre's per-polygon
 *    hairline, so the cell lattice stops showing through (mapbox-gl-js #4880).
 *  - The single flat `circle-radius: 1.6` tree layer becomes THREE data-driven
 *    circle layers — a dark offset+blurred SHADOW, the variety-tinted BASE, and
 *    a small light HIGHLIGHT — with `circle-radius` interpolated on the
 *    generator's `sizeN` (trees vary in size) and `circle-color` a per-variety
 *    `["match", ["get","forestType"], …]` (plan 026-A Q1 default: match
 *    expressions, no new tokens — 27-A owns tokens.ts). Per-variety hues are
 *    derived by RELATIVE channel moves from the theme's own `fabricForest`, so
 *    every theme's green is respected (broadleaf warm, conifer deep blue-green,
 *    swamp teal-muddy, dead-wood grey-brown; mixed = the base green).
 *  - `rank` (0 core / 1 fringe / 2 loner) fades loners a touch via a CONSTANT
 *    `step` on base opacity — no zoom coupling. (§1.3 proposes a zoom-ramped
 *    fade too; that composition is research-flagged and can only be validated
 *    on the live z4.5 screenshot, so it is deferred — the `rank` property is
 *    already emitted, so a zoom-interpolate whose stop outputs are these steps
 *    is a drop-in if the screenshot wants it.)
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
  const sizeRadius = (r0: number, r1: number): unknown => [
    "interpolate",
    ["linear"],
    ["get", "sizeN"],
    0,
    r0,
    1,
    r1,
  ];
  return [
    {
      // Woodland canopy fill (deeper `fabricForest` green — F2: a generated and
      // a sketched forest read as one class). `fill-antialias: false` removes
      // the per-polygon hairline so the cell lattice no longer shows through
      // (plan 026-A §1.3). Canopy paints FIRST so clearings + trees layer above.
      id: "generated-forest-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.8, "fill-antialias": false },
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
      // Tree SHADOW: a dark, offset, blurred disc under each tree — the bottom
      // of the painter's stack (plan 026-A §1.3, Here Dragons Abound's blob +
      // offset shadow). Slightly larger than the base and pushed down-right.
      id: "generated-forest-tree-shadow",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      paint: {
        "circle-radius": sizeRadius(1.3, 4.0),
        "circle-color": matchByVariety(base, (c) => scale(c, 0.55)),
        "circle-opacity": 0.28,
        "circle-blur": 0.6,
        "circle-translate": [0.8, 0.8],
      },
    } as unknown as LayerSpecification,
    {
      // Tree BASE: the variety-tinted disc, radius ∝ sizeN so trees vary in
      // size; a CONSTANT rank step fades fringe (1) and loner (2) trees a touch
      // below core (0) — no zoom coupling (see module JSDoc).
      id: "generated-forest-tree-base",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      paint: {
        // Radius spans ≥2× across the generator's sizeN range (plan 026-A §5).
        "circle-radius": sizeRadius(1.1, 3.5),
        "circle-color": matchByVariety(base, (c) => c),
        "circle-opacity": ["step", ["get", "rank"], 0.95, 1, 0.9, 2, 0.78],
      },
    } as unknown as LayerSpecification,
    {
      // Tree HIGHLIGHT: a small light glint offset up-left — the sunlit top of
      // each crown, the top of the stack.
      id: "generated-forest-tree-highlight",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      paint: {
        "circle-radius": sizeRadius(0.55, 1.5),
        "circle-color": matchByVariety(base, (c) => towardWhite(c, 0.42)),
        "circle-opacity": 0.6,
        "circle-translate": [-0.5, -0.5],
      },
    } as unknown as LayerSpecification,
  ];
}

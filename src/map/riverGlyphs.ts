/**
 * River water-symbol glyphs — the runtime SDF glyph set for the river dressing
 * (ford / rapids / falls), the water twin of the tree glyphs. It REUSES the
 * generic host-side machinery from `treeGlyphs.ts` (`rasterizeSdf` /
 * `ensureSdfImages` / `installSdfImageProvider`) WITHOUT touching that module —
 * only the river-specific glyph SPECS live here. SDF so one image set tints to
 * any theme's river hue at draw time via `icon-color` and never regenerates on
 * css-change (only re-registers after setStyle drops it).
 *
 * The three USGS-style water symbols:
 *  - `ford`   — a dashed crossing line (stepping stones): a row of dots.
 *  - `rapids` — stacked chevrons/wavelets: the turbulent-water tick idiom.
 *  - `falls`  — a bar with short drop ticks below (a cartographic waterfall).
 *
 * Determinism: the bytes are a pure function of the shape specs (no theme, no
 * campaign, no rng), so `riverGlyphImages()` is memoized + pixel-hash testable.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { rasterizeSdf, ensureSdfImages, installSdfImageProvider, type GlyphImage, type InsidePredicate } from "./treeGlyphs";

// The three water-symbol glyph kinds the river generator emits as the `glyph`
// property on `river-glyph` point features.
export const RIVER_GLYPHS = ["ford", "rapids", "falls"] as const;
export type RiverGlyph = (typeof RIVER_GLYPHS)[number];

// Native glyph size kept small so the base zoom renders near 1:1 — a downscaled
// SDF goes soft and its shadow AA smears. All shape extents below are CONTENT
// fractions, so the silhouettes are resolution-independent if this changes.
const GLYPH_DIM = 40;
const GLYPH_BUFFER = 5;
const CONTENT = GLYPH_DIM - 2 * GLYPH_BUFFER;

type Pt = [number, number];

function distToSeg(px: number, py: number, [ax, ay]: Pt, [bx, by]: Pt): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

type Prim = { k: "disk"; cx: number; cy: number; r: number } | { k: "capsule"; a: Pt; b: Pt; hw: number };

function primsToInside(prims: Prim[]): InsidePredicate {
  return (x, y) => {
    for (const p of prims) {
      if (p.k === "disk") {
        const dx = x - p.cx;
        const dy = y - p.cy;
        if (dx * dx + dy * dy <= p.r * p.r) return true;
      } else if (distToSeg(x, y, p.a, p.b) <= p.hw) {
        return true;
      }
    }
    return false;
  };
}

/** Primitive list for one river glyph (pixel-space, origin top-left). Drawn
 * around the glyph center so `icon-anchor: "center"` sits it ON the channel;
 * the generator's `rotation` prop orients the across-stream symbols. */
function glyphPrims(glyph: RiverGlyph): Prim[] {
  const U = CONTENT;
  const cx = GLYPH_DIM / 2;
  const cy = GLYPH_DIM / 2;
  const prims: Prim[] = [];
  if (glyph === "ford") {
    // Dashed crossing: a horizontal row of stepping-stone dots.
    const dots = 5;
    const r = U * 0.07;
    for (let i = 0; i < dots; i++) {
      const t = (i / (dots - 1) - 0.5) * U * 0.9;
      prims.push({ k: "disk", cx: cx + t, cy, r });
    }
    return prims;
  }
  if (glyph === "rapids") {
    // Three stacked chevrons — the turbulent-wavelet tick idiom.
    const rows = 3;
    const hw = U * 0.055;
    for (let i = 0; i < rows; i++) {
      const yy = cy + (i - (rows - 1) / 2) * U * 0.26;
      const half = U * 0.32;
      const dip = U * 0.12;
      prims.push({ k: "capsule", a: [cx - half, yy - dip], b: [cx, yy + dip], hw });
      prims.push({ k: "capsule", a: [cx, yy + dip], b: [cx + half, yy - dip], hw });
    }
    return prims;
  }
  // falls: a horizontal bar with short drop ticks below (a cartographic cascade).
  const barHw = U * 0.07;
  const half = U * 0.42;
  const barY = cy - U * 0.18;
  prims.push({ k: "capsule", a: [cx - half, barY], b: [cx + half, barY], hw: barHw });
  const ticks = 4;
  for (let i = 0; i < ticks; i++) {
    const t = (i / (ticks - 1) - 0.5) * U * 0.7;
    prims.push({ k: "capsule", a: [cx + t, barY], b: [cx + t, barY + U * 0.42], hw: U * 0.045 });
  }
  return prims;
}

/** Image id for a river glyph (`river-<glyph>`) — the id `riverIconImageExpr`
 * resolves the `glyph` feature property to. */
export function riverGlyphId(glyph: string): string {
  return `river-${glyph}`;
}

let CACHE: Map<string, GlyphImage> | null = null;

/** The full river glyph image set (3 SDF images), memoized + pure. Registered
 * once, tinted per theme via `icon-color`; exported for the MapView lifecycle
 * and pixel-hash tests. */
export function riverGlyphImages(): Map<string, GlyphImage> {
  if (CACHE) return CACHE;
  const out = new Map<string, GlyphImage>();
  for (const glyph of RIVER_GLYPHS) out.set(riverGlyphId(glyph), rasterizeSdf(primsToInside(glyphPrims(glyph)), GLYPH_DIM));
  CACHE = out;
  return out;
}

/** MapLibre `icon-image` expression: `river-<glyph>`. A data expression so one
 * symbol layer draws every water symbol. */
export function riverIconImageExpr(): unknown {
  return ["concat", "river-", ["get", "glyph"]];
}

/** Register the river glyphs on `map` (proactive; idempotent). */
export function registerRiverGlyphs(map: MapLibreMap): void {
  ensureSdfImages(map, riverGlyphImages());
}

/** Install the lazy `styleimagemissing` provider for river glyphs (once). */
export function installRiverGlyphProvider(map: MapLibreMap): void {
  installSdfImageProvider(map, riverGlyphImages());
}

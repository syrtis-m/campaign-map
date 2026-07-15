/**
 * Park glyph synthesis + registration — the park half of the SDF glyph
 * dressing, built on the GENERIC host machinery in `treeGlyphs.ts`
 * (`rasterizeSdf` / `ensureSdfImages` / `installSdfImageProvider`). This module
 * owns only the PARK-specific shape specs and their icon-image expressions; it
 * never edits `treeGlyphs.ts` (the shared module is imported, not forked).
 *
 * Two glyph families here:
 *  1. `park-point-<kind>` — the landmark point dressing (fountain / bandstand /
 *     monument / lantern / teahouse), legible little silhouettes (a tiered stone
 *     lantern reads as a lantern, an obelisk as a monument). Anchored at the
 *     BOTTOM so the icon stands on its point.
 *  2. `park-rock-<variant>` — low, horizontal-dominant boulders for the japanese
 *     rock groups (Sakuteiki: wider than tall), anchored CENTER (a stone lies
 *     flat, it doesn't stand up). Three hashed variants so a 3/5-stone cluster
 *     doesn't read as stamped copies.
 *
 * Park TREES reuse the forest tree glyphs (`tree-<family>-<variant>`, registered
 * by `registerTreeGlyphs`): a shade tree is a shade tree, so park trees route
 * onto the shared glyph layers. `parkTreeIconExpr` builds that id from the
 * park-tree feature's own `treeFamily` + `variant` props, so no new tree image
 * bytes are synthesized here.
 *
 * Everything is pure + deterministic (SDF bytes are a function of the shape spec
 * alone, THEME-INDEPENDENT — one image set tints to any theme via `icon-color`),
 * so the images register once and survive every `setStyle` via the shared
 * `styleimagemissing` provider (same lifecycle template as the tree glyphs).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { hashSeed, mulberry32 } from "../gen/rng";
import {
  rasterizeSdf,
  ensureSdfImages,
  installSdfImageProvider,
  type GlyphImage,
  type InsidePredicate,
} from "./treeGlyphs";

// ── Shape primitives (park-local — treeGlyphs' `Prim`/`primsToInside` are not
//    exported; a tiny re-implementation keeps this module self-contained) ──────

type Pt = [number, number];
type Prim =
  | { k: "disk"; cx: number; cy: number; r: number }
  | { k: "capsule"; a: Pt; b: Pt; hw: number }
  | { k: "tri"; a: Pt; b: Pt; c: Pt };

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

function inTri(px: number, py: number, [ax, ay]: Pt, [bx, by]: Pt, [cx, cy]: Pt): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function primsToInside(prims: Prim[]): InsidePredicate {
  return (x, y) => {
    for (const p of prims) {
      if (p.k === "disk") {
        const dx = x - p.cx;
        const dy = y - p.cy;
        if (dx * dx + dy * dy <= p.r * p.r) return true;
      } else if (p.k === "capsule") {
        if (distToSeg(x, y, p.a, p.b) <= p.hw) return true;
      } else if (inTri(x, y, p.a, p.b, p.c)) {
        return true;
      }
    }
    return false;
  };
}

// Native glyph size kept small so the base zoom renders it near 1:1 (icon-size
// ≈ 1) — a downscaled SDF goes soft and its shadow AA smears. All
// widths below are CONTENT fractions, so the silhouettes are res-independent.
const GLYPH_DIM = 52;
const GLYPH_BUFFER = 6;
const U = GLYPH_DIM - 2 * GLYPH_BUFFER; // drawable box side (40)
const MIDX = GLYPH_DIM / 2;
const GROUND = GLYPH_DIM - GLYPH_BUFFER; // bottom-anchored base line
const TOP = GLYPH_BUFFER; // crown ceiling

// ── Park point-dressing glyph specs ──────────────────────────────────────────

export const PARK_POINT_KINDS = ["fountain", "bandstand", "monument", "lantern", "teahouse"] as const;
export type ParkPointKind = (typeof PARK_POINT_KINDS)[number];
export const PARK_ROCK_VARIANTS = 3; // hashed boulder silhouettes (park-rock emits variant 0–2)

/** Primitive list for a point-dressing glyph (pixel space, origin top-left, y
 * down; base at GROUND so `icon-anchor: "bottom"` stands it on its point). Pure
 * in `kind`. */
function pointPrims(kind: ParkPointKind): Prim[] {
  const p: Prim[] = [];
  if (kind === "fountain") {
    // Two-tier fountain: a wide lower basin, a pedestal, an upper bowl, a jet.
    p.push({ k: "capsule", a: [MIDX - U * 0.32, GROUND - U * 0.06], b: [MIDX + U * 0.32, GROUND - U * 0.06], hw: U * 0.09 });
    p.push({ k: "capsule", a: [MIDX, GROUND - U * 0.1], b: [MIDX, GROUND - U * 0.32], hw: U * 0.05 });
    p.push({ k: "capsule", a: [MIDX - U * 0.18, GROUND - U * 0.34], b: [MIDX + U * 0.18, GROUND - U * 0.34], hw: U * 0.06 });
    p.push({ k: "capsule", a: [MIDX, GROUND - U * 0.4], b: [MIDX, TOP + U * 0.08], hw: U * 0.032 });
    p.push({ k: "disk", cx: MIDX, cy: TOP + U * 0.05, r: U * 0.07 });
    return p;
  }
  if (kind === "bandstand") {
    // Gazebo: a broad conical roof + finial on four posts + a floor line.
    p.push({ k: "tri", a: [MIDX - U * 0.4, TOP + U * 0.3], b: [MIDX + U * 0.4, TOP + U * 0.3], c: [MIDX, TOP] });
    p.push({ k: "disk", cx: MIDX, cy: TOP, r: U * 0.05 });
    for (const dx of [-U * 0.3, -U * 0.1, U * 0.1, U * 0.3]) {
      p.push({ k: "capsule", a: [MIDX + dx, TOP + U * 0.3], b: [MIDX + dx, GROUND - U * 0.04], hw: U * 0.028 });
    }
    p.push({ k: "capsule", a: [MIDX - U * 0.36, GROUND], b: [MIDX + U * 0.36, GROUND], hw: U * 0.04 });
    return p;
  }
  if (kind === "monument") {
    // Obelisk: a wide base, a tapering shaft, a pyramidion tip.
    p.push({ k: "capsule", a: [MIDX - U * 0.16, GROUND - U * 0.04], b: [MIDX + U * 0.16, GROUND - U * 0.04], hw: U * 0.06 });
    p.push({ k: "capsule", a: [MIDX, GROUND - U * 0.12], b: [MIDX, TOP + U * 0.16], hw: U * 0.08 });
    p.push({ k: "tri", a: [MIDX - U * 0.09, TOP + U * 0.16], b: [MIDX + U * 0.09, TOP + U * 0.16], c: [MIDX, TOP] });
    return p;
  }
  if (kind === "lantern") {
    // Stone lantern (tōrō): stacked base / post / platform / fire-box / roof /
    // finial — the tiered stack is the instant read.
    p.push({ k: "disk", cx: MIDX, cy: GROUND - U * 0.07, r: U * 0.13 });
    p.push({ k: "capsule", a: [MIDX, GROUND - U * 0.12], b: [MIDX, GROUND - U * 0.34], hw: U * 0.045 });
    p.push({ k: "capsule", a: [MIDX - U * 0.17, GROUND - U * 0.36], b: [MIDX + U * 0.17, GROUND - U * 0.36], hw: U * 0.045 });
    p.push({ k: "disk", cx: MIDX, cy: GROUND - U * 0.5, r: U * 0.13 });
    p.push({ k: "tri", a: [MIDX - U * 0.22, GROUND - U * 0.56], b: [MIDX + U * 0.22, GROUND - U * 0.56], c: [MIDX, GROUND - U * 0.74] });
    p.push({ k: "disk", cx: MIDX, cy: GROUND - U * 0.76, r: U * 0.05 });
    return p;
  }
  // teahouse: a rounded hut body under a broad gable roof.
  p.push({ k: "capsule", a: [MIDX - U * 0.02, GROUND - U * 0.06], b: [MIDX + U * 0.02, GROUND - U * 0.06], hw: U * 0.24 });
  p.push({ k: "tri", a: [MIDX - U * 0.38, GROUND - U * 0.24], b: [MIDX + U * 0.38, GROUND - U * 0.24], c: [MIDX, GROUND - U * 0.54] });
  return p;
}

/** Primitive list for a boulder glyph (pixel space, centred at GLYPH_DIM/2;
 * horizontal-dominant per Sakuteiki). Deterministic in `variant`. */
function rockPrims(variant: number): Prim[] {
  const rng = mulberry32(hashSeed("parkglyph-rock-v1", variant));
  const cy = GLYPH_DIM / 2;
  const jit = (frac: number) => (rng() * 2 - 1) * frac * U;
  const p: Prim[] = [];
  // A broad, low mound: a wide capsule is the boulder body.
  const halfW = U * (0.24 + 0.05 * rng());
  p.push({ k: "capsule", a: [MIDX - halfW, cy + U * 0.04], b: [MIDX + halfW, cy + U * 0.04], hw: U * (0.12 + 0.03 * rng()) });
  // A hashed shoulder bump — asymmetric so a cluster doesn't read as stamps.
  p.push({ k: "disk", cx: MIDX + jit(0.12), cy: cy - U * (0.05 + 0.04 * rng()), r: U * (0.1 + 0.03 * rng()) });
  return p;
}

// ── Image ids + icon-image expressions ───────────────────────────────────────

/** Image id for a park point glyph — `park-point-<kind>` (the id the
 * `icon-image` expression in generated/park.ts resolves to). */
export function parkPointGlyphId(kind: string): string {
  return `park-point-${kind}`;
}

/** Image id for a park boulder glyph — `park-rock-<variant>`. */
export function parkRockGlyphId(variant: number): string {
  return `park-rock-${variant}`;
}

/** `icon-image` for the park-point symbol layer: `park-point-<pointKind>`. A
 * data expression so one layer draws every landmark kind. */
export function parkPointIconExpr(): unknown {
  return ["concat", "park-point-", ["get", "pointKind"]];
}

/** `icon-image` for the park-rock symbol layer: `park-rock-<variant>`. */
export function parkRockIconExpr(): unknown {
  return ["concat", "park-rock-", ["to-string", ["get", "variant"]]];
}

/** `icon-image` for the park-tree symbol layer — REUSES the forest tree glyphs
 * (`tree-<treeFamily>-<variant>`, registered by `registerTreeGlyphs`), keyed on
 * the park-tree feature's own `treeFamily`/`variant` props. */
export function parkTreeIconExpr(): unknown {
  return ["concat", "tree-", ["get", "treeFamily"], "-", ["to-string", ["get", "variant"]]];
}

let CACHE: Map<string, GlyphImage> | null = null;

/**
 * The full park glyph image set (5 point kinds + 3 rock variants = 8 SDF
 * images), memoized. Pure + deterministic (bytes depend only on the shape specs)
 * so they register once and tint per theme via `icon-color`. Park TREES are NOT
 * here — they reuse the forest tree glyph set.
 */
export function parkGlyphImages(): Map<string, GlyphImage> {
  if (CACHE) return CACHE;
  const out = new Map<string, GlyphImage>();
  for (const kind of PARK_POINT_KINDS) {
    out.set(parkPointGlyphId(kind), rasterizeSdf(primsToInside(pointPrims(kind)), GLYPH_DIM));
  }
  for (let v = 0; v < PARK_ROCK_VARIANTS; v++) {
    out.set(parkRockGlyphId(v), rasterizeSdf(primsToInside(rockPrims(v)), GLYPH_DIM));
  }
  CACHE = out;
  return out;
}

/** Register the park glyphs on `map` (proactive; idempotent). */
export function registerParkGlyphs(map: MapLibreMap): void {
  ensureSdfImages(map, parkGlyphImages());
}

/** Install the lazy `styleimagemissing` provider for park glyphs (once). */
export function installParkGlyphProvider(map: MapLibreMap): void {
  installSdfImageProvider(map, parkGlyphImages());
}

/**
 * Tree glyph synthesis + registration — the runtime SDF glyph module that draws
 * per-variety tree symbols. Two parts, and BOTH are meant to be reused by the
 * park and river glyph modules, so the generic host-side machinery is exported
 * separately from the forest-specific specs:
 *
 *  1. GENERIC SDF host machinery (reusable):
 *     - `rasterizeSdf(inside, dim)` turns a pure inside/outside predicate into an
 *       8-bit signed-distance-field RGBA image (the mapbox/tiny-sdf encoding:
 *       RGB = white, alpha = distance so MapLibre's SDF shader tints it with
 *       `icon-color` and rims it with `icon-halo-*`). NO canvas — the coverage is
 *       supersampled and the distance transform is the Felzenszwalb EDT, so the
 *       whole thing is pure arithmetic and unit-testable headless by pixel-hash.
 *     - `ensureSdfImages(map, images)` / `installSdfImageProvider(map, images)`
 *       are the addImage lifecycle: proactive registration + a `styleimagemissing`
 *       safety net so images survive every `setStyle` (theme switch, css-change)
 *       and campaign switch without per-callsite bookkeeping.
 *
 *  2. FOREST glyph specs: five varieties × four hashed variants,
 *     drawn as tree silhouettes (broadleaf/mixed lumpy blob, conifer scalloped
 *     tiers, swamp frond tuft, dead-wood bare fork). Deterministic from
 *     `(family, variant)` so `treeGlyphImages()` is a pure function.
 *
 * Why SDF and not per-theme canvas rasters:
 * SDF glyphs are THEME-INDEPENDENT — one image set tints to any theme's woodland
 * green at draw time via `icon-color`, so the bytes never depend on theme tokens
 * and never need regenerating on css-change (only re-registering after setStyle
 * drops them). The multi-tone shadow/highlight is produced with symbol LAYERS: a
 * duplicated dark `icon-translate` shadow layer below, and the base layer's
 * lighter `icon-halo` as the rim highlight (forest.ts).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { hashSeed, mulberry32 } from "../gen/rng";

// ── Generic SDF host machinery (reusable) ────────────────────────────────────

export interface GlyphImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const INF = 1e20;

/** Felzenszwalb & Huttenlocher 1D squared-distance transform along one axis of
 * `grid` (mapbox/tiny-sdf's `edt1d`). `offset`/`stride` select the row/column;
 * `f`/`v`/`z` are reused scratch buffers sized ≥ `length`. */
function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Int32Array,
  z: Float64Array
): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    let s: number;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

/** 2D squared-distance transform: columns then rows (in place). */
function edt2d(grid: Float64Array, width: number, height: number): void {
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/** Coverage predicate for a glyph: true when pixel-space point `(x,y)` is inside
 * the shape. Supersampled by `rasterizeSdf`, so it may be a hard boolean. */
export type InsidePredicate = (x: number, y: number) => boolean;

export interface SdfOptions {
  /** Distance normalization (px). Larger ⇒ softer, more halo headroom. */
  radius?: number;
  /** Edge offset in [0,1]; the shape boundary lands at alpha = 255·(1−cutoff). */
  cutoff?: number;
  /** Subpixel samples per axis for coverage anti-aliasing (default 3 ⇒ 9/px). */
  supersample?: number;
}

/**
 * Rasterize an inside/outside predicate to an SDF RGBA image (tiny-sdf
 * encoding). Pure — no DOM/canvas — so it runs identically in the Electron
 * renderer and in headless vitest, and its bytes are a deterministic function of
 * the predicate. `dim` is the square image side in px.
 */
export function rasterizeSdf(inside: InsidePredicate, dim: number, opts?: SdfOptions): GlyphImage {
  // radius = the distance ramp (px). Moderately tight: tree glyphs render
  // downscaled (icon-size < 1), and MapLibre's SDF antialiasing widens with the
  // downscale — a wide field (large radius) smears the buffer band into a visible
  // box on the no-halo shadow layer. radius 6 keeps the silhouette crisp with a
  // readable halo rim while narrowing that smear (the shadow is also softened in
  // forest.ts). Verified on screenshot.
  const radius = opts?.radius ?? 6;
  const cutoff = opts?.cutoff ?? 0.25;
  const ss = opts?.supersample ?? 3;
  const n = dim * dim;
  const gridOuter = new Float64Array(n);
  const gridInner = new Float64Array(n);
  const inv = 1 / ss;
  const per = 1 / (ss * ss);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (inside(x + (sx + 0.5) * inv, y + (sy + 0.5) * inv)) hits++;
        }
      }
      const a = hits * per; // coverage in [0,1]
      const i = y * dim + x;
      if (a <= 0) {
        gridOuter[i] = INF;
        gridInner[i] = 0;
      } else if (a >= 1) {
        gridOuter[i] = 0;
        gridInner[i] = INF;
      } else {
        const d = 0.5 - a;
        gridOuter[i] = d > 0 ? d * d : 0;
        gridInner[i] = d < 0 ? d * d : 0;
      }
    }
  }
  edt2d(gridOuter, dim, dim);
  edt2d(gridInner, dim, dim);
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const dist = Math.sqrt(gridOuter[i]) - Math.sqrt(gridInner[i]);
    const alpha = Math.round(255 - 255 * (dist / radius + cutoff));
    const a = alpha < 0 ? 0 : alpha > 255 ? 255 : alpha;
    const j = i * 4;
    data[j] = 255;
    data[j + 1] = 255;
    data[j + 2] = 255;
    data[j + 3] = a;
  }
  return { width: dim, height: dim, data };
}

/** addImage every glyph the map does not already carry (idempotent — safe to
 * call on load and after every setStyle). SDF so themes tint at draw time. */
export function ensureSdfImages(map: MapLibreMap, images: Map<string, GlyphImage>): void {
  for (const [id, img] of images) {
    if (map.hasImage(id)) continue;
    map.addImage(id, img, { sdf: true });
  }
}

/** Install a `styleimagemissing` handler that lazily supplies any glyph the
 * style asks for — the belt to `ensureSdfImages`'s braces. Survives setStyle
 * (the handler lives on the map, not the style), so a theme switch that drops
 * every image self-heals on the next render with no missing-image errors. */
export function installSdfImageProvider(map: MapLibreMap, images: Map<string, GlyphImage>): void {
  map.on("styleimagemissing", (e: { id: string }) => {
    const img = images.get(e.id);
    if (img && !map.hasImage(e.id)) map.addImage(e.id, img, { sdf: true });
  });
}

// ── Forest tree glyph specs ──────────────────────────────────────────────────

/** Glyph families keyed by the generator's `forestType`. `mixed` reuses the
 * broadleaf silhouette (a broadleaf-dominant stand — the generator already
 * splits its populations by placement; the glyph carries the
 * canopy read, hue carries the rest). */
const TREE_FAMILIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;
export type TreeFamily = (typeof TREE_FAMILIES)[number];
export const TREE_VARIANTS = 4; // hashed glyph picks per family (generator emits variant 0–3)

// Native glyph size is kept SMALL so the base zoom renders it near 1:1
// (icon-size ≈ 1) rather than downscaling a big raster — downscaled SDF icons go
// soft and the shadow's AA band smears into a box. Shape widths below are all
// CONTENT fractions, so the silhouettes are resolution-independent if this
// changes.
const GLYPH_DIM = 52; // square SDF side (px)
const GLYPH_BUFFER = 6; // border for the SDF + halo headroom
const CONTENT = GLYPH_DIM - 2 * GLYPH_BUFFER; // drawable box side (40)

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

/** Build the primitive list for one tree glyph. Deterministic in
 * `(family, variant)` (mulberry32 over a fnv hash) so the image bytes are pure.
 * Coordinates are pixel-space, origin top-left, y down; the trunk base sits near
 * the bottom edge so `icon-anchor: "bottom"` stands the tree on its point. */
function treePrims(family: TreeFamily, variant: number): Prim[] {
  const rng = mulberry32(hashSeed("treeglyph-v1", family, variant));
  const U = CONTENT; // all widths are fractions of the content box → res-independent
  const jit = (frac: number) => (rng() * 2 - 1) * frac * U;
  const cx = GLYPH_DIM / 2;
  const ground = GLYPH_DIM - GLYPH_BUFFER; // trunk base
  const top = GLYPH_BUFFER; // crown apex ceiling
  const prims: Prim[] = [];

  if (family === "conifer") {
    // Scalloped conifer: a slim trunk + 3–4 stacked triangle tiers narrowing
    // upward (upright — no icon-rotate on conifers, forest.ts).
    const tiers = 3 + (variant % 2);
    prims.push({ k: "capsule", a: [cx, ground], b: [cx, ground - U * 0.15], hw: U * 0.075 });
    const span = ground - U * 0.1 - top;
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      const baseY = ground - U * 0.1 - t * span;
      const apexY = baseY - span / tiers - U * 0.08;
      const hw = (U / 2) * (0.92 - 0.6 * t) + jit(0.03);
      prims.push({ k: "tri", a: [cx - hw, baseY], b: [cx + hw, baseY], c: [cx, apexY] });
    }
    return prims;
  }

  if (family === "dead-wood") {
    // Bare fork: a trunk + 2–3 leafless branch capsules, NO foliage mass (the
    // instant "dead" read). Branch angles hashed per variant.
    const trunkTop = top + U * 0.15 + jit(0.05);
    prims.push({ k: "capsule", a: [cx, ground], b: [cx, trunkTop], hw: U * 0.09 });
    const branches = 2 + (variant % 2);
    for (let i = 0; i < branches; i++) {
      const along = 0.35 + 0.5 * (i / Math.max(1, branches - 1));
      const rootY = ground + (trunkTop - ground) * along;
      const dir = i % 2 === 0 ? -1 : 1;
      const ang = (0.7 + 0.5 * rng()) * dir; // outward-up
      const len = U * (0.32 + 0.16 * rng());
      const ex = cx + Math.sin(ang) * len;
      const ey = rootY - Math.cos(ang) * len;
      prims.push({ k: "capsule", a: [cx, rootY], b: [ex, ey], hw: U * 0.06 });
    }
    return prims;
  }

  if (family === "swamp") {
    // Frond tuft: a thin trunk + a small central node + fronds fanning from the
    // crown node (a marsh palm/reed read). Sparser, wispier than a blob.
    const nodeY = top + U * 0.3 + jit(0.05);
    prims.push({ k: "capsule", a: [cx, ground], b: [cx, nodeY], hw: U * 0.07 });
    prims.push({ k: "disk", cx, cy: nodeY, r: U * 0.1 });
    const fronds = 5 + (variant % 3);
    for (let i = 0; i < fronds; i++) {
      const spread = ((i / (fronds - 1)) * 2 - 1) * (Math.PI * 0.42);
      const ang = spread + jit(0.005);
      const len = U * (0.34 + 0.12 * rng());
      const ex = cx + Math.sin(ang) * len;
      const ey = nodeY - Math.cos(ang) * len * 0.7 - U * 0.05;
      prims.push({ k: "capsule", a: [cx, nodeY], b: [ex, ey], hw: U * 0.06 });
    }
    return prims;
  }

  // broadleaf / mixed: a lumpy rounded crown (main disk + hashed satellites) on
  // a short trunk — the classic deciduous blob (Watabou / Here Dragons Abound).
  const crownCy = top + U * 0.42 + jit(0.05);
  const mainR = U * 0.32;
  prims.push({ k: "capsule", a: [cx, ground], b: [cx, crownCy + mainR * 0.4], hw: U * 0.095 });
  prims.push({ k: "disk", cx, cy: crownCy, r: mainR });
  const lobes = 5 + (variant % 3); // 5–7 satellite lumps
  const ringR = mainR * 0.85;
  for (let i = 0; i < lobes; i++) {
    const ang = (i / lobes) * Math.PI * 2 + jit(0.01);
    const rr = ringR * (0.85 + 0.3 * rng());
    prims.push({
      k: "disk",
      cx: cx + Math.cos(ang) * rr,
      cy: crownCy + Math.sin(ang) * rr * 0.85,
      r: mainR * (0.48 + 0.22 * rng()),
    });
  }
  return prims;
}

/** Image id for a tree glyph (`tree-<forestType>-<variant>`) — the ids the
 * `icon-image` expression in forest.ts resolves to. */
export function treeGlyphId(family: string, variant: number): string {
  return `tree-${family}-${variant}`;
}

let CACHE: Map<string, GlyphImage> | null = null;

/**
 * The full tree glyph image set (5 families × 4 variants = 20 SDF images),
 * memoized. Pure + deterministic: the bytes depend only on the shape specs, not
 * on theme or campaign, so they register once and tint per theme via
 * `icon-color`. Exported for the MapView lifecycle and for pixel-hash tests.
 */
export function treeGlyphImages(): Map<string, GlyphImage> {
  if (CACHE) return CACHE;
  const out = new Map<string, GlyphImage>();
  for (const family of TREE_FAMILIES) {
    for (let variant = 0; variant < TREE_VARIANTS; variant++) {
      const img = rasterizeSdf(primsToInside(treePrims(family, variant)), GLYPH_DIM);
      out.set(treeGlyphId(family, variant), img);
    }
  }
  CACHE = out;
  return out;
}

/** MapLibre `icon-image` expression: `tree-<forestType>-<variant>`. A data
 * expression so one symbol layer draws every variety/variant. */
export function treeIconImageExpr(): unknown {
  return ["concat", "tree-", ["get", "forestType"], "-", ["to-string", ["get", "variant"]]];
}

/** Register the tree glyphs on `map` (proactive; idempotent). */
export function registerTreeGlyphs(map: MapLibreMap): void {
  ensureSdfImages(map, treeGlyphImages());
}

/** Install the lazy `styleimagemissing` provider for tree glyphs (once). */
export function installTreeGlyphProvider(map: MapLibreMap): void {
  installSdfImageProvider(map, treeGlyphImages());
}

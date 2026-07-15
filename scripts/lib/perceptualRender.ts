/**
 * The perceptual runner's headless painter: a per-gid RGBA paint table modeled
 * on the playground's PAINT shim, plus the pure feature→framebuffer render both
 * the CLI and its unit tests share. Flat colors — visual distinctness between
 * buckets matters, not fidelity to any theme. Unknown gids get a deterministic
 * hash-hue fallback, exactly as the playground does, so a newly added bucket
 * still paints (in a stable color) before it earns a table entry.
 *
 * Pure and IO-free: file reads/writes live in scripts/perceptual.ts.
 */
import { Framebuffer, fitTransform, type Rgba, type Pt } from "./raster";
import type { RgbaImage } from "./png";
import type { ProcgenRegion } from "../../src/gen/region";

export type { RgbaImage } from "./png";

export const CANVAS = 512;
/** Fixed inset so fitted geometry never touches the frame edge. */
export const MARGIN = 16;
export const BACKGROUND: Rgba = [244, 239, 228, 255];

export interface Paint {
  z: number;
  fill?: Rgba;
  stroke?: Rgba;
  strokeWidth?: number;
  /** LINE fabric painted at a width derived from `properties.width` (meters). */
  widthFromProp?: boolean;
  /** Point markers: square side in px. */
  pointSize?: number;
  pointColor?: Rgba;
}

/** Sorted painting order is `z` ascending, then feature order (stable sort). */
export const PAINT_TABLE: Record<string, Paint> = {
  // ground fills
  "city-district": { z: 10, fill: [160, 148, 120, 31] },
  "mountain-massif": { z: 10, fill: [217, 207, 192, 255] },
  "farm-field": { z: 12, fill: [230, 220, 180, 255], stroke: [207, 194, 150, 255], strokeWidth: 1 },
  "forest-canopy": { z: 14, fill: [156, 186, 142, 255] },
  "forest-clearing": { z: 16, fill: [233, 228, 210, 255] },
  "park-lawn": { z: 14, fill: [183, 208, 160, 255] },
  "park-canopy": { z: 16, fill: [147, 181, 126, 255] },
  "park-bed": { z: 18, fill: [201, 166, 184, 255] },
  "park-court": { z: 18, fill: [222, 211, 180, 255] },
  // water
  "river-channel": { z: 20, fill: [143, 184, 216, 255] },
  "river-estuary": { z: 20, fill: [143, 184, 216, 255] },
  "river-distributary": { z: 20, fill: [143, 184, 216, 255] },
  "river-confluence": { z: 20, fill: [143, 184, 216, 255] },
  "river-oxbow": { z: 19, fill: [165, 196, 220, 255] },
  "park-pond": { z: 20, fill: [163, 198, 223, 255] },
  "wall-moat": { z: 20, fill: [163, 198, 223, 255] },
  "river-island": { z: 22, fill: [221, 212, 184, 255], stroke: [196, 184, 148, 255], strokeWidth: 1 },
  "river-point-bar": { z: 22, fill: [227, 217, 186, 255] },
  "park-island": { z: 22, fill: [211, 202, 172, 255] },
  // blocks / parcels / buildings
  "city-block": { z: 24, fill: [90, 80, 60, 18] },
  "city-parcel": { z: 26, stroke: [90, 80, 60, 64], strokeWidth: 1 },
  "city-footprint": { z: 28, fill: [111, 101, 88, 255] },
  "city-landmark": { z: 30, fill: [138, 74, 61, 255] },
  "farm-building": { z: 28, fill: [125, 106, 82, 255] },
  "wall-quad": { z: 32, fill: [122, 114, 101, 255] },
  "wall-tower": { z: 34, fill: [95, 87, 76, 255] },
  // lines
  "mountain-hachure": { z: 36, stroke: [168, 152, 127, 255], strokeWidth: 1 },
  "forest-canopy-rim": { z: 36, stroke: [125, 156, 110, 255], strokeWidth: 1 },
  "park-canopy-rim": { z: 36, stroke: [125, 156, 110, 255], strokeWidth: 1 },
  "park-pond-shore": { z: 36, stroke: [123, 163, 194, 255], strokeWidth: 1 },
  "park-court-rake": { z: 36, stroke: [201, 188, 152, 255], strokeWidth: 1 },
  "river-bank": { z: 37, stroke: [111, 150, 181, 255], strokeWidth: 1 },
  "river-glyph": { z: 37, stroke: [123, 163, 194, 255], strokeWidth: 1 },
  "farm-lane": { z: 38, stroke: [176, 154, 106, 255], strokeWidth: 2 },
  "farm-hedge": { z: 38, stroke: [122, 148, 85, 255], strokeWidth: 1 },
  "farm-bank": { z: 38, stroke: [176, 161, 132, 255], strokeWidth: 1 },
  "park-path": { z: 38, stroke: [194, 178, 138, 255], strokeWidth: 2 },
  "city-street": { z: 40, stroke: [74, 68, 56, 255], widthFromProp: true },
  // points
  "forest-tree": { z: 50, pointSize: 3, pointColor: [95, 125, 81, 255] },
  "park-tree": { z: 50, pointSize: 3, pointColor: [95, 125, 81, 255] },
  "orchard-tree": { z: 50, pointSize: 3, pointColor: [109, 138, 86, 255] },
  "park-rock": { z: 50, pointSize: 3, pointColor: [141, 133, 120, 255] },
  "park-point": { z: 50, pointSize: 3, pointColor: [138, 122, 99, 255] },
  "park-bridge": { z: 42, stroke: [138, 122, 99, 255], strokeWidth: 2 },
  "mountain-peak": { z: 50, pointSize: 4, pointColor: [92, 83, 71, 255] },
  "wall-gate": { z: 50, pointSize: 5, pointColor: [61, 55, 47, 255] },
};

/** FNV-1a hue → RGBA, the playground's deterministic fallback for an unknown
 * gid (fixed 45% saturation / 55% lightness, moderate alpha). */
export function hashHueRgba(gid: string): Rgba {
  let h = 2166136261;
  for (let i = 0; i < gid.length; i++) {
    h ^= gid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const [r, g, b] = hslToRgb(hue, 0.45, 0.55);
  return [r, g, b, 102];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export type PaintResolver = (gid: string) => Paint;

export function paintFor(gid: string, table: Record<string, Paint> = PAINT_TABLE): Paint {
  return table[gid] ?? { z: 25, fill: hashHueRgba(gid) };
}

function gidOf(f: GeoJSON.Feature): string {
  return String(f.properties?.generatorId ?? "");
}

/**
 * Render a feature list contained by `region` into a framebuffer. Features are
 * painted in (z, feature-order) order; `resolve` maps a gid to its paint so a
 * test can inject a mutated palette. IO-free.
 */
export function renderFeatures(
  features: GeoJSON.Feature[],
  region: ProcgenRegion,
  resolve: PaintResolver = paintFor
): Framebuffer {
  const fb = new Framebuffer(CANVAS, CANVAS, BACKGROUND);
  const t = fitTransform(region.bbox, CANVAS, CANVAS, MARGIN);
  const sorted = [...features]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => resolve(gidOf(a.f)).z - resolve(gidOf(b.f)).z || a.i - b.i);

  const proj = (c: GeoJSON.Position): Pt => t.project([c[0], c[1]]);
  for (const { f } of sorted) {
    const p = resolve(gidOf(f));
    const g = f.geometry;
    if (g.type === "Point") {
      const size = p.pointSize ?? 3;
      fb.fillSquare(proj(g.coordinates), size, p.pointColor ?? p.stroke ?? [68, 68, 68, 255]);
      continue;
    }
    if (g.type === "LineString") {
      if (!p.stroke) continue;
      const w = p.widthFromProp ? streetWidthPx(f, t.scale) : p.strokeWidth ?? 1;
      fb.strokePolyline(g.coordinates.map(proj), w, p.stroke);
      continue;
    }
    const groups: GeoJSON.Position[][][] =
      g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const group of groups) {
      const projected = group.map((ring) => ring.map(proj));
      if (p.fill) fb.fillPolygonGroup(projected, p.fill);
      if (p.stroke) for (const ring of projected) fb.strokePolyline(ring, p.strokeWidth ?? 1, p.stroke);
    }
  }
  return fb;
}

/** City-street width in px: meters × scale × 0.5, floored at 1 (matches the
 * playground's per-street width, rounded to an integer band). */
function streetWidthPx(f: GeoJSON.Feature, scale: number): number {
  const meters = Number(f.properties?.width) || 8;
  return Math.max(1, Math.round(meters * scale * 0.5));
}

export function toImage(fb: Framebuffer): RgbaImage {
  return { width: fb.width, height: fb.height, data: fb.data };
}

export interface DiffResult {
  differing: number;
  total: number;
  fraction: number;
}

/** Per-pixel diff: a pixel differs when ANY channel differs by more than 8. */
export function diffBuffers(a: RgbaImage, b: RgbaImage): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    return { differing: a.width * a.height, total: a.width * a.height, fraction: 1 };
  }
  const total = a.width * a.height;
  let differing = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (
      Math.abs(a.data[o] - b.data[o]) > 8 ||
      Math.abs(a.data[o + 1] - b.data[o + 1]) > 8 ||
      Math.abs(a.data[o + 2] - b.data[o + 2]) > 8 ||
      Math.abs(a.data[o + 3] - b.data[o + 3]) > 8
    ) {
      differing++;
    }
  }
  return { differing, total, fraction: differing / total };
}

/** FAIL threshold: more than this fraction of pixels differing. */
export const DIFF_FAIL_FRACTION = 0.005;

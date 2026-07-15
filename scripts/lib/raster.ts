/**
 * Pure software rasterizer for the perceptual-golden runner (dev tooling only —
 * never bundled into the plugin, no dependency on a native canvas). Renders into
 * an opaque RGBA framebuffer with NO anti-aliasing: hard edges keep the output a
 * deterministic function of the geometry, so pixel diffs never wobble on
 * float-rounding order.
 *
 * Primitives: even-odd scanline polygon fill (per polygon group, so a hole in
 * one MultiPolygon member never punches through another), integer-width line
 * stroke, and square point markers. Fills composite source-over so the low-alpha
 * overlay colors from the paint table read as tints, matching the playground.
 */
export type Rgba = readonly [number, number, number, number];
export type Pt = readonly [number, number];

export class Framebuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // row-major RGBA, alpha always 255

  constructor(width: number, height: number, background: Rgba) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = background[0];
      this.data[i * 4 + 1] = background[1];
      this.data[i * 4 + 2] = background[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /** Source-over composite of one opaque-background pixel. `a` in 0..255. */
  private blend(px: number, py: number, color: Rgba): void {
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const a = color[3];
    if (a <= 0) return;
    const idx = (py * this.width + px) * 4;
    if (a >= 255) {
      this.data[idx] = color[0];
      this.data[idx + 1] = color[1];
      this.data[idx + 2] = color[2];
      return;
    }
    const inv = 255 - a;
    this.data[idx] = Math.round((color[0] * a + this.data[idx] * inv) / 255);
    this.data[idx + 1] = Math.round((color[1] * a + this.data[idx + 1] * inv) / 255);
    this.data[idx + 2] = Math.round((color[2] * a + this.data[idx + 2] * inv) / 255);
  }

  /**
   * Even-odd fill of one polygon GROUP — `rings[0]` is the outer contour and any
   * further rings are holes, evaluated together under one even-odd parity so
   * holes subtract only within their own member. Rings may be open or closed
   * (the wrap segment is always considered). Half-open scanline convention
   * (`ymin ≤ yc < ymax`) so a shared vertex is counted exactly once.
   */
  fillPolygonGroup(rings: Pt[][], color: Rgba): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.ceil(maxY));
    for (let py = y0; py <= y1; py++) {
      const yc = py + 0.5;
      const xs: number[] = [];
      for (const ring of rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          const ay = a[1];
          const by = b[1];
          const lo = Math.min(ay, by);
          const hi = Math.max(ay, by);
          if (yc >= lo && yc < hi) {
            xs.push(a[0] + ((yc - ay) / (by - ay)) * (b[0] - a[0]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        // Pixel centers in [xL, xR): half-open horizontal span.
        const startPx = Math.max(0, Math.ceil(xs[k] - 0.5));
        const endPx = Math.min(this.width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let px = startPx; px <= endPx; px++) this.blend(px, py, color);
      }
    }
  }

  /** Filled square marker of side `size` (rounded up to ≥1) centered on `p`. */
  fillSquare(p: Pt, size: number, color: Rgba): void {
    const s = Math.max(1, Math.round(size));
    const half = (s - 1) / 2;
    const cx = Math.round(p[0]);
    const cy = Math.round(p[1]);
    const x0 = Math.round(cx - half);
    const y0 = Math.round(cy - half);
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) this.blend(x0 + dx, y0 + dy, color);
    }
  }

  /**
   * Stroke a polyline with integer pixel `width`. Each segment is walked with a
   * DDA step of ≤1px and a `width×width` square is stamped at every sample —
   * crude but deterministic, giving a solid band of the requested thickness.
   */
  strokePolyline(points: Pt[], width: number, color: Rgba): void {
    const w = Math.max(1, Math.round(width));
    for (let i = 0; i + 1 < points.length; i++) {
      this.strokeSegment(points[i], points[i + 1], w, color);
    }
  }

  private strokeSegment(a: Pt, b: Pt, w: number, color: Rgba): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    const half = (w - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = Math.round(a[0] + dx * t - half);
      const y = Math.round(a[1] + dy * t - half);
      for (let oy = 0; oy < w; oy++) {
        for (let ox = 0; ox < w; ox++) this.blend(x + ox, y + oy, color);
      }
    }
  }
}

/**
 * A world→screen transform that fits `bbox` into a `width×height` canvas with a
 * fixed pixel `margin`, preserving aspect ratio and flipping Y (world +y is up,
 * screen +y is down) — the same fit the playground uses.
 */
export interface FitTransform {
  project(p: Pt): Pt;
  scale: number;
}

export function fitTransform(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  margin: number
): FitTransform {
  const dx = bbox.maxX - bbox.minX || 1;
  const dy = bbox.maxY - bbox.minY || 1;
  const scale = Math.min((width - margin * 2) / dx, (height - margin * 2) / dy);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  const tx = width / 2 - cx * scale;
  const ty = height / 2 + cy * scale;
  return {
    scale,
    project: (p: Pt): Pt => [p[0] * scale + tx, -p[1] * scale + ty],
  };
}

import { describe, it, expect } from "vitest";
import { marchingSquares, type Contour } from "./marchingSquares";
import { terrace } from "../mountain";
import type { BBox } from "../spatialHash";
import type { Field } from "./sdf";

const BOX = (minX: number, minY: number, maxX: number, maxY: number): BBox => ({ minX, minY, maxX, maxY });

/** Mean x / y of a contour's vertices (a vertical line has constant x). */
function meanX(c: Contour): number {
  return c.points.reduce((a, p) => a + p[0], 0) / c.points.length;
}

describe("marchingSquares — known scalar fields", () => {
  it("a linear ramp f(x,y)=x traces straight iso-lines at the exact crossing x", () => {
    const field: Field = (x) => x;
    const contours = marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 10, levels: [25, 55] });
    expect(contours.length).toBe(2);
    // Each level is a single vertical line at x === level, spanning the box.
    for (const c of contours) {
      for (const [x] of c.points) expect(x).toBeCloseTo(c.level, 6);
      const ys = c.points.map((p) => p[1]);
      expect(Math.min(...ys)).toBeLessThanOrEqual(0);
      expect(Math.max(...ys)).toBeGreaterThanOrEqual(100);
      // Runs off the top and bottom edges → an OPEN line, not a loop.
      expect(c.closed).toBe(false);
    }
  });

  it("a radial cone traces a concentric CLOSED loop at the expected radius", () => {
    const cx = 50;
    const cy = 50;
    // High at the center, falling off radially: value === level ⇒ radius = 40-level.
    const field: Field = (x, y) => 40 - Math.hypot(x - cx, y - cy);
    const contours = marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 5, levels: [20] });
    expect(contours.length).toBe(1);
    const ring = contours[0];
    expect(ring.closed).toBe(true);
    expect(ring.points[0]).toEqual(ring.points[ring.points.length - 1]); // first === last
    for (const [x, y] of ring.points) {
      expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(20, 0); // on the r=20 circle
    }
  });

  it("is byte-identical across two runs (closed-loop start/winding canonicalized)", () => {
    const field: Field = (x, y) => 40 - Math.hypot(x - 50, y - 50);
    const a = marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 5, levels: [10, 20, 30] });
    const b = marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 5, levels: [10, 20, 30] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("world-aligned lattice: overlapping bboxes agree on a shared iso-line (seam rule)", () => {
    const field: Field = (x) => x;
    // Level 45 lies in BOTH bboxes' x-range; the world-aligned lattice samples
    // the same nodes, so the traced line is bit-identical over the shared span.
    const left = marchingSquares(field, { bbox: BOX(0, 0, 60, 100), step: 10, levels: [45] });
    const right = marchingSquares(field, { bbox: BOX(40, 0, 100, 100), step: 10, levels: [45] });
    expect(left.length).toBe(1);
    expect(right.length).toBe(1);
    expect(JSON.stringify(left[0].points)).toBe(JSON.stringify(right[0].points));
  });

  it("saddle cells (two diagonal highs) trace without crossing segments or throwing", () => {
    // A checkerboard-ish field whose 0-level cuts through a saddle.
    const field: Field = (x, y) => Math.sin(x / 15) * Math.sin(y / 15);
    let contours: Contour[] = [];
    expect(() => {
      contours = marchingSquares(field, { bbox: BOX(0, 0, 120, 120), step: 6, levels: [0] });
    }).not.toThrow();
    expect(contours.length).toBeGreaterThan(0);
    for (const c of contours) expect(c.points.length).toBeGreaterThanOrEqual(2);
  });

  it("degenerate inputs (zero-size bbox, no levels, non-positive step) yield [], never throw", () => {
    const field: Field = (x) => x;
    // Zero-size bbox anchored on a lattice node ⇒ a single node ⇒ no cells.
    expect(marchingSquares(field, { bbox: BOX(100, 100, 100, 100), step: 100, levels: [1] })).toEqual([]);
    expect(marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 10, levels: [] })).toEqual([]);
    expect(marchingSquares(field, { bbox: BOX(0, 0, 100, 100), step: 0, levels: [1] })).toEqual([]);
  });
});

describe("marchingSquares — terrace banding (the mesa signature)", () => {
  // The terrace transform flattens plateaus and steepens risers, so contours
  // must BUNCH in the riser zone (the top of each step, where the cubic frac
  // climbs fast) and vanish on the plateaus. A linear ramp spreads them evenly.
  const W = 1000;
  const A = 1000;
  const STEPS = 4;
  const bbox = BOX(0, 0, W, 200);
  const levels: number[] = [];
  for (let lv = 40; lv < A; lv += 40) levels.push(lv);

  /** Fraction of contour lines whose x sits in the top 40% of its terrace step
   * (frac ≥ 0.6) — the riser zone. */
  function riserFraction(field: Field): number {
    const contours = marchingSquares(field, { bbox, step: 10, levels });
    if (contours.length === 0) return 0;
    let inRiser = 0;
    for (const c of contours) {
      const x = meanX(c);
      const frac = ((x / W) * STEPS) % 1;
      if (frac >= 0.6) inRiser++;
    }
    return inRiser / contours.length;
  }

  it("terraced field concentrates contours at risers; linear ramp spreads them evenly", () => {
    const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
    const terraced: Field = (x) => A * terrace(clamp01(x / W), STEPS);
    const linear: Field = (x) => A * clamp01(x / W);
    const terracedRiser = riserFraction(terraced);
    const linearRiser = riserFraction(linear);
    // Terracing pushes the vast majority of lines into the riser zone; a linear
    // ramp holds near the geometric ~40% baseline.
    expect(terracedRiser).toBeGreaterThan(0.7);
    expect(terracedRiser).toBeGreaterThan(linearRiser + 0.25);
  });
});

import { describe, it, expect } from "vitest";
import { SegmentHash } from "./segmentHash";
import { distanceToPolyline } from "./fields/sdf";

type Pt = [number, number];

/** Naive nearest distance — the ground truth the hash must reproduce to the
 * float (the hash only prunes WHICH segments are tested, never the arithmetic). */
function naive(line: Pt[], x: number, y: number): number {
  return distanceToPolyline(line, x, y);
}

const SPINE: Pt[] = [
  [-600, 0],
  [-300, 80],
  [0, -40],
  [300, 60],
  [600, 0],
];

describe("SegmentHash — nearest matches a naive scan to the float", () => {
  it("agrees with distanceToPolyline across a grid of queries", () => {
    const hash = new SegmentHash(SPINE, { cellSize: 128 });
    for (let x = -900; x <= 900; x += 37) {
      for (let y = -400; y <= 400; y += 41) {
        const got = hash.nearest(x, y).dist;
        const want = naive(SPINE, x, y);
        expect(got).toBe(want);
      }
    }
  });

  it("gradient is the unit away-from-line direction (finite-difference of distance)", () => {
    const hash = new SegmentHash(SPINE, { cellSize: 128 });
    const h = 0.01;
    for (const [x, y] of [
      [-150, 200],
      [120, 200],
      [400, -180],
      [-500, -150],
    ] as Pt[]) {
      const r = hash.nearest(x, y);
      const gx = (naive(SPINE, x + h, y) - naive(SPINE, x - h, y)) / (2 * h);
      const gy = (naive(SPINE, x, y + h) - naive(SPINE, x, y - h)) / (2 * h);
      expect(r.gradX).toBeCloseTo(gx, 3);
      expect(r.gradY).toBeCloseTo(gy, 3);
      expect(Math.hypot(r.gradX, r.gradY)).toBeCloseTo(1, 6);
    }
  });

  it("prunes: a far query tests far fewer segments than the naive scan on a long spine", () => {
    // A 200-segment spine; a query hugging one end must not test all 200.
    const long: Pt[] = [];
    for (let i = 0; i <= 200; i++) long.push([i * 50, Math.sin(i / 3) * 40]);
    const hash = new SegmentHash(long, { cellSize: 128 });
    hash.nearest(20, 30); // near the start
    expect(hash.segmentTests).toBeLessThan(30);
    expect(hash.nearest(20, 30).dist).toBe(naive(long, 20, 30));
  });

  it("cell size does not change the answer (only the pruning)", () => {
    const a = new SegmentHash(SPINE, { cellSize: 40 });
    const b = new SegmentHash(SPINE, { cellSize: 500 });
    for (const [x, y] of [
      [0, 300],
      [250, -120],
      [-400, 90],
    ] as Pt[]) {
      expect(a.nearest(x, y).dist).toBe(b.nearest(x, y).dist);
    }
  });

  it("empty / degenerate lines are safe", () => {
    expect(new SegmentHash([], {}).nearest(0, 0).dist).toBe(Infinity);
    expect(new SegmentHash([[0, 0]], {}).nearest(0, 0).dist).toBe(Infinity);
  });
});

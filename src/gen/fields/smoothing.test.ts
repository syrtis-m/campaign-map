import { describe, it, expect } from "vitest";
import { chaikinClosed } from "./smoothing";
import type { Pt } from "./sdf";

const SQUARE: Pt[] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
  [0, 0],
];

describe("chaikinClosed — corner-cutting smoothing", () => {
  it("returns a closed ring (first === last) and grows the vertex count per pass", () => {
    const one = chaikinClosed(SQUARE, 1);
    expect(one[0]).toEqual(one[one.length - 1]);
    // 4 edges → 8 points per pass.
    expect(one.length - 1).toBe(8);
    const two = chaikinClosed(SQUARE, 2);
    expect(two.length - 1).toBe(16);
  });

  it("is deterministic (byte-identical across two runs)", () => {
    const a = chaikinClosed(SQUARE, 2);
    const b = chaikinClosed(SQUARE, 2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("only ever pulls a convex ring INWARD (smoothed stays within the source bounds — containment survives)", () => {
    const smoothed = chaikinClosed(SQUARE, 3);
    for (const [x, y] of smoothed) {
      // Chaikin vertices are convex combinations of the source corners, so they
      // never escape the source square (with mm slack) — a pre-smoothing inset
      // margin is preserved.
      expect(x).toBeGreaterThanOrEqual(-0.001);
      expect(x).toBeLessThanOrEqual(100.001);
      expect(y).toBeGreaterThanOrEqual(-0.001);
      expect(y).toBeLessThanOrEqual(100.001);
    }
  });

  it("mm-quantizes output (D5)", () => {
    const tri: Pt[] = [
      [0, 0],
      [10, 0],
      [5, 9],
      [0, 0],
    ];
    for (const [x, y] of chaikinClosed(tri, 2)) {
      expect(x).toBe(Math.round(x * 1000) / 1000);
      expect(y).toBe(Math.round(y * 1000) / 1000);
    }
  });

  it("degenerate rings (< 3 vertices) pass through closed + quantized, never throw", () => {
    expect(() => chaikinClosed([[1.2345678, 2]], 2)).not.toThrow();
    const two = chaikinClosed(
      [
        [0, 0],
        [1, 1],
      ],
      2
    );
    expect(two[0]).toEqual(two[two.length - 1]);
  });
});

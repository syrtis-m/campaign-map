import { describe, it, expect } from "vitest";
import { metaballField } from "./metaball";
import type { Pt } from "./sdf";

describe("metaballField — smooth compactly-supported bumps", () => {
  const anchors: Pt[] = [
    [0, 0],
    [100, 0],
  ];

  it("peaks at an anchor and is zero beyond the radius", () => {
    const f = metaballField(anchors, 40, 1);
    expect(f(0, 0)).toBeCloseTo(1, 6); // at anchor: t=1 → strength·1
    expect(f(41, 0)).toBe(0); // beyond radius of both anchors
    expect(f(200, 200)).toBe(0);
  });

  it("falls off monotonically with distance from a lone anchor", () => {
    const f = metaballField([[0, 0]], 50, 1);
    const d0 = f(0, 0);
    const d1 = f(10, 0);
    const d2 = f(30, 0);
    expect(d0).toBeGreaterThan(d1);
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(0);
  });

  it("sums overlapping anchors (blends between two)", () => {
    const f = metaballField(anchors, 80, 1);
    // Midpoint is within 80 m of both → gets a contribution from each.
    const mid = f(50, 0);
    const single = metaballField([[0, 0]], 80, 1)(50, 0);
    expect(mid).toBeCloseTo(single * 2, 6);
  });

  it("empty anchors ⇒ constant 0", () => {
    const f = metaballField([], 40, 1);
    expect(f(0, 0)).toBe(0);
    expect(f(10, 10)).toBe(0);
  });

  it("is a pure function (byte-identical repeated evaluation)", () => {
    const f = metaballField(anchors, 60, 0.3);
    expect(f(25, 12)).toBe(f(25, 12));
  });
});

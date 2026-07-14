import { describe, it, expect } from "vitest";
import { contoursToMultiPolygon } from "./polygons";
import { marchingSquares } from "./marchingSquares";
import type { Field, Pt } from "./sdf";

/** A closed axis-aligned square ring, CCW, centered at (cx,cy), half-size h. */
function square(cx: number, cy: number, h: number): Pt[] {
  return [
    [cx - h, cy - h],
    [cx + h, cy - h],
    [cx + h, cy + h],
    [cx - h, cy + h],
    [cx - h, cy - h],
  ];
}

function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

describe("contoursToMultiPolygon — even/odd hole nesting", () => {
  it("two disjoint rings → two hole-less polygons", () => {
    const mp = contoursToMultiPolygon([square(0, 0, 10), square(100, 0, 10)]);
    expect(mp.length).toBe(2);
    for (const poly of mp) expect(poly.length).toBe(1); // exterior only
  });

  it("a ring inside a ring → one polygon [exterior, hole]", () => {
    const mp = contoursToMultiPolygon([square(0, 0, 100), square(0, 0, 30)]);
    expect(mp.length).toBe(1);
    expect(mp[0].length).toBe(2); // exterior + 1 hole
    // Exterior is the big ring, hole the small one.
    const [ext, hole] = mp[0];
    expect(Math.abs(signedArea(ext))).toBeCloseTo(200 * 200, 0);
    expect(Math.abs(signedArea(hole))).toBeCloseTo(60 * 60, 0);
  });

  it("exteriors wind CCW, holes wind CW (RFC 7946 + MapLibre hole detection)", () => {
    const mp = contoursToMultiPolygon([square(0, 0, 100), square(0, 0, 30)]);
    const [ext, hole] = mp[0];
    expect(signedArea(ext)).toBeGreaterThan(0); // CCW
    expect(signedArea(hole)).toBeLessThan(0); // CW
  });

  it("three levels of nesting → outer polygon with a hole, and the island as its own polygon", () => {
    // outer (depth 0, exterior) ⊃ hole (depth 1) ⊃ island (depth 2, exterior).
    const mp = contoursToMultiPolygon([square(0, 0, 100), square(0, 0, 60), square(0, 0, 20)]);
    expect(mp.length).toBe(2); // outer + island
    const withHole = mp.find((p) => p.length === 2)!;
    const solo = mp.find((p) => p.length === 1)!;
    expect(withHole).toBeDefined();
    expect(solo).toBeDefined();
    // The island exterior is the smallest ring.
    expect(Math.abs(signedArea(solo[0]))).toBeCloseTo(40 * 40, 0);
  });

  it("is deterministic and canonically ordered (byte-identical across runs, order-independent input)", () => {
    const rings = [square(100, 0, 10), square(0, 0, 100), square(0, 0, 30)];
    const a = contoursToMultiPolygon(rings);
    const b = contoursToMultiPolygon([...rings].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("drops degenerate rings (< 4 points) and returns [] for no usable rings", () => {
    expect(contoursToMultiPolygon([])).toEqual([]);
    expect(contoursToMultiPolygon([[[0, 0], [1, 1], [0, 0]]])).toEqual([]);
  });
});

describe("contoursToMultiPolygon — end-to-end with marchingSquares (a masked field with a hole)", () => {
  it("a plateau with a central pit traces to one exterior + one hole", () => {
    // High everywhere inside r=40, but with a pit (below level) inside r=15.
    const cx = 50;
    const cy = 50;
    const field: Field = (x, y) => {
      const r = Math.hypot(x - cx, y - cy);
      if (r < 15) return -1; // the pit (below 0)
      if (r < 40) return 1; // the plateau (above 0)
      return -1; // outside (below 0)
    };
    const contours = marchingSquares(field, { bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, step: 2, levels: [0] });
    const rings = contours.filter((c) => c.closed).map((c) => c.points);
    expect(rings.length).toBe(2); // outer boundary + pit boundary
    const mp = contoursToMultiPolygon(rings);
    expect(mp.length).toBe(1);
    expect(mp[0].length).toBe(2); // exterior + hole
  });
});

/**
 * Unit tests for the `src/gen/fields/` module: SDF builders,
 * combinators, transforms — value correctness, determinism, seam behavior, and
 * the bit-exact equivalence to the `region.ts` twins of these primitives.
 */
import { describe, expect, it } from "vitest";
import {
  type Field,
  type Pt,
  sdfPolygon,
  sdfPolyline,
  signedDistancePolygon,
  signedDistancePolyline,
  distanceToPolyline,
  distanceToRingBoundary,
  ringContainsEvenOdd,
  pointInRingClosed,
  fUnion,
  fIntersect,
  fSubtract,
  fSmoothUnion,
  fMask,
  fOffset,
  fScale,
  fClamp,
  fSum,
} from "./index";
import { makeRegion, distanceToBoundary, regionContains, makeSpine, distanceToSpine } from "../region";
import { pointInRing } from "../fabricConstraints";

// A 200×200 square centered at the origin (closed, CCW).
const SQUARE: Pt[] = [
  [-100, -100],
  [100, -100],
  [100, 100],
  [-100, 100],
  [-100, -100],
];

describe("sdfPolygon", () => {
  const sdf = sdfPolygon(SQUARE);
  it("is positive inside, negative outside, ~0 on the boundary", () => {
    expect(sdf(0, 0)).toBeCloseTo(100, 6); // deepest interior of a 200-wide square
    expect(sdf(0, 90)).toBeCloseTo(10, 6);
    expect(sdf(0, 150)).toBeCloseTo(-50, 6); // 50 m outside the top edge
    expect(sdf(0, 100)).toBeCloseTo(0, 6); // on the edge
  });

  it("closes an open ring (open input === closed input)", () => {
    const open = SQUARE.slice(0, -1);
    const a = sdfPolygon(open);
    for (const [x, y] of [[0, 0], [50, -30], [140, 10], [-100, -100]] as Pt[]) {
      expect(a(x, y)).toBe(sdf(x, y));
    }
  });

  it("is a pure, deterministic function of position (seam-safe: identical sample anywhere)", () => {
    // Point-evaluability ⇒ the same world point yields the same value no matter
    // which tile asked — the seam property. Repeated calls are byte-identical.
    for (const [x, y] of [[12.5, -7.25], [99.999, 0], [-33, 61]] as Pt[]) {
      expect(sdf(x, y)).toBe(sdf(x, y));
      expect(sdfPolygon(SQUARE)(x, y)).toBe(sdf(x, y)); // fresh builder, same bytes
    }
  });
});

describe("sdfPolyline (capsule)", () => {
  const line: Pt[] = [
    [0, 0],
    [100, 0],
  ];
  const sdf = sdfPolyline(line, 15);
  it("is positive within halfWidth of the line, negative beyond", () => {
    expect(sdf(50, 0)).toBeCloseTo(15, 6); // on the line
    expect(sdf(50, 10)).toBeCloseTo(5, 6); // 10 m off → 15−10
    expect(sdf(50, 15)).toBeCloseTo(0, 6); // exactly halfWidth away
    expect(sdf(50, 40)).toBeCloseTo(-25, 6); // outside
  });
  it("matches signedDistancePolyline numerically", () => {
    expect(sdf(30, 12)).toBe(signedDistancePolyline(line, 15, 30, 12));
  });
});

describe("bit-exact equivalence to the retrofitted region.ts / fabricConstraints code", () => {
  it("signedDistancePolygon === region.distanceToBoundary (polygon branch), byte-for-byte", () => {
    const region = makeRegion("sq", SQUARE);
    const pts: Pt[] = [
      [0, 0],
      [37.5, -12.25],
      [140, 10],
      [-95, 95],
      [100, 100],
      [0, 100],
    ];
    for (const [x, y] of pts) {
      expect(signedDistancePolygon(region.ring, x, y)).toBe(distanceToBoundary(region, x, y));
    }
  });

  it("ringContainsEvenOdd backs region.contains; pointInRingClosed backs fabric.pointInRing", () => {
    const region = makeRegion("sq", SQUARE);
    const pts: Pt[] = [
      [0, 0],
      [99, 99],
      [101, 0],
      [50, -50],
    ];
    for (const [x, y] of pts) {
      // Each even-odd loop is the byte-exact backing of the wrapper it now feeds.
      expect(ringContainsEvenOdd(region.ring, x, y)).toBe(regionContains(region, x, y));
      expect(pointInRingClosed(SQUARE, x, y)).toBe(pointInRing(SQUARE, x, y));
    }
    // Sanity: clear interior/exterior classify correctly.
    expect(ringContainsEvenOdd(region.ring, 0, 0)).toBe(true);
    expect(ringContainsEvenOdd(region.ring, 500, 500)).toBe(false);
  });

  it("distanceToPolyline === region.distanceToSpine, byte-for-byte", () => {
    const spine = makeSpine("s", [
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    for (const [x, y] of [[50, 20], [-10, 0], [120, 50], [100, 100]] as Pt[]) {
      expect(distanceToPolyline(spine.points, x, y)).toBe(distanceToSpine(spine, x, y));
    }
  });

  it("distanceToRingBoundary is the unsigned edge distance (always ≥ 0)", () => {
    for (const [x, y] of [[0, 0], [0, 150], [200, 200]] as Pt[]) {
      expect(distanceToRingBoundary(SQUARE, x, y)).toBeGreaterThanOrEqual(0);
    }
    expect(distanceToRingBoundary(SQUARE, 0, 0)).toBeCloseTo(100, 6);
  });
});

describe("combinators (positive-inside convention)", () => {
  const a: Field = (x) => 10 - x; // inside where x < 10
  const b: Field = (x) => x - 20; // inside where x > 20
  it("fUnion is pointwise max, fIntersect pointwise min", () => {
    expect(fUnion(a, b)(0, 0)).toBe(Math.max(10, -20));
    expect(fIntersect(a, b)(0, 0)).toBe(Math.min(10, -20));
  });
  it("fSubtract(a,b) = inside a and outside b", () => {
    // point x=5: a=5 (inside a), b=-15 (outside b → -b=15). subtract = min(5,15)=5.
    expect(fSubtract(a, b)(5, 0)).toBe(5);
    // point x=25: a=-15, b=5 → -b=-5. subtract = min(-15,-5) = -15 (outside).
    expect(fSubtract(a, b)(25, 0)).toBe(-15);
  });
  it("fSmoothUnion ≥ hard union and degrades to fUnion at k≤0", () => {
    const hard = fUnion(a, b);
    const smooth = fSmoothUnion(a, b, 8);
    // Smooth max is ≥ the hard max (rounds the crease outward/inward within k).
    for (const x of [0, 10, 15, 20, 30]) {
      expect(smooth(x, 0)).toBeGreaterThanOrEqual(hard(x, 0) - 1e-9);
    }
    expect(fSmoothUnion(a, b, 0)(15, 0)).toBe(hard(15, 0));
    expect(fSmoothUnion(a, b, -5)(15, 0)).toBe(hard(15, 0));
  });
});

describe("transforms", () => {
  const sdf = sdfPolygon(SQUARE);
  it("fMask ramps 0 at the boundary/outside → 1 at `band` inside (smoothstep)", () => {
    const mask = fMask(sdf, 20);
    expect(mask(0, 100)).toBeCloseTo(0, 6); // boundary
    expect(mask(0, 150)).toBe(0); // outside → clamped 0
    expect(mask(0, 0)).toBeCloseTo(1, 6); // deep inside (≥ band)
    const mid = mask(0, 90); // 10 m inside → smoothstep(0.5) = 0.5
    expect(mid).toBeCloseTo(0.5, 6);
    // band ≤ 0 → hard step
    expect(fMask(sdf, 0)(0, 99)).toBe(1);
    expect(fMask(sdf, 0)(0, 101)).toBe(0);
  });
  it("fOffset / fScale / fClamp / fSum", () => {
    expect(fOffset(sdf, 5)(0, 0)).toBeCloseTo(105, 6);
    expect(fScale(sdf, 2)(0, 0)).toBeCloseTo(200, 6);
    expect(fClamp(sdf, 0, 50)(0, 0)).toBe(50);
    expect(fClamp(sdf, 0, 50)(0, 150)).toBe(0); // -50 clamped to 0
    expect(fSum(sdf, sdf)(0, 0)).toBeCloseTo(200, 6);
    expect(fSum()(0, 0)).toBe(0);
  });
});

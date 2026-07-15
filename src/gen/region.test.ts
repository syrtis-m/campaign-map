import { describe, expect, it } from "vitest";
import {
  makeRegion,
  regionContains,
  distanceToBoundary,
  interiorT,
  boundaryPointAt,
  boundaryPointFrom,
  generationCenter,
  segmentCrossesBoundary,
  clipPolylineToRegion,
  insetRing,
  ringIsConvex,
  validateRegionRing,
  REGION_MIN_AREA_M2,
  REGION_MAX_AREA_M2,
  makeSpine,
  makeCorridorRegion,
  distanceToSpine,
  validateSpineLine,
} from "./region";

type Pt = [number, number];

const SQUARE: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
  [0, 0],
];

// L-shape: 1600×1600 square minus its NE 800×800 quadrant. Concave, centroid
// at (2000/3, 2000/3) ≈ (666.667, 666.667) — inside.
const L_SHAPE: Pt[] = [
  [0, 0],
  [1600, 0],
  [1600, 800],
  [800, 800],
  [800, 1600],
  [0, 1600],
  [0, 0],
];

const TRIANGLE: Pt[] = [
  [0, 0],
  [1200, 0],
  [0, 1200],
  [0, 0],
];

// C-shape whose area centroid falls in the (excluded) mouth of the C.
const C_SHAPE: Pt[] = [
  [0, 0],
  [900, 0],
  [900, 200],
  [200, 200],
  [200, 800],
  [900, 800],
  [900, 1000],
  [0, 1000],
  [0, 0],
];

describe("makeRegion", () => {
  it("computes bbox, area, centroid, effectiveRadius for a square", () => {
    const r = makeRegion("sq", SQUARE);
    expect(r.bbox).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    expect(r.area).toBeCloseTo(1_000_000, 6);
    expect(r.centroid).toEqual([500, 500]);
    expect(r.effectiveRadius).toBeCloseTo(Math.sqrt(1_000_000 / Math.PI), 9);
    // Interior pole of a square is its center; the 10 m lattice hits it.
    expect(r.interiorPole).toEqual([500, 500]);
    expect(r.maxInteriorDistance).toBeCloseTo(500, 9);
    // Closed, and normalized CCW regardless of input orientation.
    expect(r.ring[0]).toEqual(r.ring[r.ring.length - 1]);
    const cw = makeRegion("sq-cw", [...SQUARE].reverse());
    expect(cw.area).toBeCloseTo(r.area, 6);
    expect(cw.centroid).toEqual([500, 500]);
  });

  it("mm-quantizes the ring at ingest (D5)", () => {
    const r = makeRegion("q", [
      [0.0004, 0],
      [1000.0006, 0.0004],
      [1000, 1000],
      [0, 1000],
    ]);
    expect(r.ring[0]).toEqual([0, 0]);
    expect(r.ring[1]).toEqual([1000.001, 0]);
  });

  it("computes an area centroid, not a vertex average (concave L)", () => {
    const r = makeRegion("L", L_SHAPE);
    expect(r.centroid[0]).toBeCloseTo(2000 / 3, 2);
    expect(r.centroid[1]).toBeCloseTo(2000 / 3, 2);
    expect(r.area).toBeCloseTo(3 * 800 * 800, 6);
  });
});

describe("regionContains / distanceToBoundary / interiorT", () => {
  const sq = makeRegion("sq", SQUARE);
  const L = makeRegion("L", L_SHAPE);
  const tri = makeRegion("tri", TRIANGLE);

  it("square: even-odd containment and exact signed distances", () => {
    expect(regionContains(sq, 500, 500)).toBe(true);
    expect(regionContains(sq, -1, 500)).toBe(false);
    expect(distanceToBoundary(sq, 500, 500)).toBeCloseTo(500, 9);
    expect(distanceToBoundary(sq, 100, 500)).toBeCloseTo(100, 9);
    expect(distanceToBoundary(sq, -100, 500)).toBeCloseTo(-100, 9); // signed, − outside
    expect(interiorT(sq, 500, 500)).toBeCloseTo(0, 6);
    expect(interiorT(sq, 0, 500)).toBeCloseTo(1, 6);
    expect(interiorT(sq, -100, 500)).toBeGreaterThan(1);
  });

  it("L-shape: the notch is outside; distances respect the reflex corner", () => {
    expect(regionContains(L, 400, 400)).toBe(true);
    expect(regionContains(L, 1200, 1200)).toBe(false); // the notch
    expect(distanceToBoundary(L, 1200, 1200)).toBeLessThan(0);
    // Point near the reflex corner (800,800): distance is to the notch edges.
    expect(distanceToBoundary(L, 700, 700)).toBeCloseTo(Math.hypot(100, 100), 9);
    expect(interiorT(L, 0, 0)).toBeCloseTo(1, 6);
    expect(interiorT(L, 1200, 1200)).toBeGreaterThan(1);
  });

  it("triangle: distance to the hypotenuse and edges", () => {
    expect(regionContains(tri, 100, 100)).toBe(true);
    expect(distanceToBoundary(tri, 100, 100)).toBeCloseTo(100, 9);
    expect(regionContains(tri, 700, 700)).toBe(false); // past the hypotenuse
    expect(interiorT(tri, 100, 100)).toBeGreaterThan(0);
    expect(interiorT(tri, 100, 100)).toBeLessThan(1);
  });
});

describe("boundaryPointAt / generationCenter (concave handling)", () => {
  it("square: rays from the centroid hit the expected edges, mm-quantized", () => {
    const sq = makeRegion("sq", SQUARE);
    expect(boundaryPointAt(sq, 0)).toEqual([1000, 500]);
    expect(boundaryPointAt(sq, Math.PI / 2)).toEqual([500, 1000]);
    expect(boundaryPointAt(sq, Math.PI)).toEqual([0, 500]);
  });

  it("L-shape: contained centroid rays hit the FIRST crossing", () => {
    const L = makeRegion("L", L_SHAPE);
    // Ray east from (666.667, 666.667) exits at x=1600 (y < 800: no notch).
    const east = boundaryPointAt(L, 0);
    expect(east).not.toBeNull();
    expect(east![0]).toBeCloseTo(1600, 3);
  });

  it("C-shape: centroid outside → boundaryPointAt null; generationCenter falls back to the interior pole", () => {
    const c = makeRegion("c", C_SHAPE);
    expect(regionContains(c, c.centroid[0], c.centroid[1])).toBe(false);
    expect(boundaryPointAt(c, 0)).toBeNull();
    const center = generationCenter(c);
    expect(regionContains(c, center[0], center[1])).toBe(true);
    // And rays from the generation center do hit the boundary.
    expect(boundaryPointFrom(c, center[0], center[1], 0)).not.toBeNull();
  });
});

describe("segmentCrossesBoundary / clipPolylineToRegion", () => {
  const L = makeRegion("L", L_SHAPE);

  it("detects a segment cutting across the notch between two inside points", () => {
    // (1200,700) and (700,1200) are both inside; the straight segment
    // between them crosses the notch.
    expect(regionContains(L, 1200, 700)).toBe(true);
    expect(regionContains(L, 700, 1200)).toBe(true);
    expect(segmentCrossesBoundary(L, 1200, 700, 700, 1200)).toBe(true);
    expect(segmentCrossesBoundary(L, 100, 100, 400, 400)).toBe(false);
  });

  it("splits a polyline crossing the notch into two runs with on-boundary endpoints", () => {
    const runs = clipPolylineToRegion(L, [
      [1400, 700],
      [1400, 1400], // exits through the notch edge y=800… wait: x=1400 > 800, so exits at y=800
      [400, 1400], // re-enters through the notch edge x=800
    ]);
    expect(runs.length).toBe(2);
    // Every run endpoint is inside-or-on the boundary.
    for (const run of runs) {
      for (const [x, y] of run) {
        expect(distanceToBoundary(L, x, y)).toBeGreaterThanOrEqual(-0.01);
      }
    }
    // First run ends exactly on the notch edge y=800.
    const firstEnd = runs[0][runs[0].length - 1];
    expect(firstEnd[1]).toBeCloseTo(800, 9);
  });

  it("returns the whole line when fully inside, [] when fully outside", () => {
    expect(clipPolylineToRegion(L, [[100, 100], [400, 400]])).toEqual([[[100, 100], [400, 400]]]);
    expect(clipPolylineToRegion(L, [[2000, 2000], [3000, 3000]])).toEqual([]);
  });
});

describe("insetRing", () => {
  it("insets a square to a smaller square", () => {
    const sq = makeRegion("sq", SQUARE);
    const inner = insetRing(sq, 100);
    expect(inner.length).toBe(5); // 4 corners + closure
    expect(inner[0]).toEqual(inner[inner.length - 1]);
    const xs = inner.map((p) => p[0]);
    const ys = inner.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(100, 3);
    expect(Math.max(...xs)).toBeCloseTo(900, 3);
    expect(Math.min(...ys)).toBeCloseTo(100, 3);
    expect(Math.max(...ys)).toBeCloseTo(900, 3);
    // Every inset vertex sits at ≥ ~inset from the boundary.
    for (const [x, y] of inner) {
      expect(distanceToBoundary(sq, x, y)).toBeGreaterThanOrEqual(100 - 0.01);
    }
  });

  it("insets a concave L without throwing and stays inside", () => {
    const L = makeRegion("L", L_SHAPE);
    const inner = insetRing(L, 120);
    expect(inner.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of inner) {
      expect(regionContains(L, x, y)).toBe(true);
    }
  });

  it("degenerate inset (wider than the shape) falls back or returns [] — never throws", () => {
    const sq = makeRegion("sq", SQUARE);
    const result = insetRing(sq, 600); // > half-width: raw inset flips
    // Fallback halving (600→300→150…) may produce a valid smaller ring, or [].
    if (result.length > 0) {
      for (const [x, y] of result) expect(regionContains(sq, x, y)).toBe(true);
    }
  });
});

describe("ringIsConvex", () => {
  it("square convex, L-shape not", () => {
    expect(ringIsConvex(makeRegion("sq", SQUARE).ring)).toBe(true);
    expect(ringIsConvex(makeRegion("L", L_SHAPE).ring)).toBe(false);
  });
});

describe("validateRegionRing", () => {
  it("accepts a plain square of valid size", () => {
    expect(validateRegionRing(SQUARE)).toEqual({ ok: true });
  });

  it("rejects a bowtie (self-intersection)", () => {
    const bowtie: Pt[] = [
      [0, 0],
      [1000, 1000],
      [1000, 0],
      [0, 1000],
      [0, 0],
    ];
    const v = validateRegionRing(bowtie);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/crosses itself/);
  });

  it("rejects <3 distinct vertices", () => {
    expect(validateRegionRing([[0, 0], [10, 0], [0, 0]]).ok).toBe(false);
    expect(validateRegionRing([[0, 0], [0.0001, 0], [10, 0], [10, 0.0001]]).ok).toBe(false);
  });

  it("rejects areas outside the [π·150², π·2500²] envelope", () => {
    const tiny: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ]; // 10 000 m² < π·150² ≈ 70 686 m²
    expect(validateRegionRing(tiny).ok).toBe(false);
    const side = Math.sqrt(REGION_MAX_AREA_M2) + 100;
    const huge: Pt[] = [
      [0, 0],
      [side, 0],
      [side, side],
      [0, side],
    ];
    expect(validateRegionRing(huge).ok).toBe(false);
    expect(REGION_MIN_AREA_M2).toBeCloseTo(Math.PI * 150 * 150, 6);
  });
});

describe("spine (line-kind) support", () => {
  const LINE: Pt[] = [
    [0, 0],
    [100, 0],
    [100.0004, 0], // sub-mm duplicate — dropped by quantization
    [200, 50],
  ];

  it("makeSpine mm-quantizes, dedupes, and indexes arc length", () => {
    const s = makeSpine("s", LINE);
    // The sub-mm duplicate collapses into its neighbor.
    expect(s.points.length).toBe(3);
    expect(s.cumLen[0]).toBe(0);
    expect(s.totalLen).toBeGreaterThan(0);
    // Monotone cumulative length.
    for (let i = 1; i < s.cumLen.length; i++) expect(s.cumLen[i]).toBeGreaterThanOrEqual(s.cumLen[i - 1]);
    expect(s.cumLen[s.cumLen.length - 1]).toBeCloseTo(s.totalLen, 6);
  });

  it("distanceToSpine is 0 on the polyline and grows away from it", () => {
    const s = makeSpine("s", [[0, 0], [100, 0]]);
    expect(distanceToSpine(s, 50, 0)).toBeCloseTo(0, 6);
    expect(distanceToSpine(s, 50, 20)).toBeCloseTo(20, 6);
    // Off the ends: nearest is the endpoint.
    expect(distanceToSpine(s, -10, 0)).toBeCloseTo(10, 6);
  });

  it("makeCorridorRegion: spine-aware distanceToBoundary (positive inside, negative outside)", () => {
    const s = makeSpine("s", [[0, 0], [200, 0]]);
    const r = makeCorridorRegion("s", s, 30);
    expect(r.spine).toBeDefined();
    expect(r.corridorMaxOffset).toBe(30);
    // On the spine: distance-to-boundary = maxOffset.
    expect(distanceToBoundary(r, 100, 0)).toBeCloseTo(30, 6);
    // 25 m off the spine: still inside (positive).
    expect(distanceToBoundary(r, 100, 25)).toBeCloseTo(5, 6);
    // 40 m off: outside (negative).
    expect(distanceToBoundary(r, 100, 40)).toBeCloseTo(-10, 6);
    // The ring is a valid CCW rectangle covering the corridor bbox.
    expect(regionContains(r, 100, 0)).toBe(true);
  });

  it("validateSpineLine: rejects too-short / accepts a real line", () => {
    expect(validateSpineLine([[0, 0], [0, 0]]).ok).toBe(false); // one distinct point
    expect(validateSpineLine([[0, 0], [5, 0]]).ok).toBe(false); // below min length
    expect(validateSpineLine([[0, 0], [200, 0]]).ok).toBe(true);
  });
});

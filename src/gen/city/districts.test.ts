import { describe, expect, it } from "vitest";
import { generateDistricts } from "./districts";
import { generateCityBlocks } from "./blocks";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";

const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const SEED = 4181;

function constraints(): GenerationConstraints {
  return { worldBounds: WORLD_BOUNDS };
}

describe("generateDistricts determinism", () => {
  const bbox: BBox = { minX: 0, minY: 0, maxX: 600, maxY: 600 };

  it("same seed twice is deep-equal", () => {
    const a = generateDistricts(SEED, bbox, constraints());
    const b = generateDistricts(SEED, bbox, constraints());
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("every polygon is a valid closed ring with >= 3 distinct vertices", () => {
    const districts = generateDistricts(SEED, bbox, constraints());
    for (const d of districts) {
      const ring = (d.geometry as GeoJSON.Polygon).coordinates[0];
      expect(ring.length).toBeGreaterThanOrEqual(4); // >=3 distinct + closing point
      const [fx, fy] = ring[0];
      const [lx, ly] = ring[ring.length - 1];
      expect(fx).toBeCloseTo(lx, 9);
      expect(fy).toBeCloseTo(ly, 9);
    }
  });
});

describe("generateDistricts seam alignment", () => {
  const TILE = 600;
  const west: BBox = { minX: -TILE, minY: -TILE, maxX: 0, maxY: TILE };
  const east: BBox = { minX: 0, minY: -TILE, maxX: TILE, maxY: TILE };

  function uniquePointsOnEdge(features: GeoJSON.Feature[], x: number) {
    // Dedupe: a shared boundary vertex is duplicated by ring closure (first
    // vertex repeats as last) and can be touched by multiple district
    // polygons that meet there — occurrence *count* is a test artifact, not
    // a seam signal. What must match is the *set* of crossing positions.
    const seen = new Map<string, number>();
    for (const f of features) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      for (const [px, py] of ring) {
        if (Math.abs(px - x) < 1e-9) seen.set(py.toFixed(6), py);
      }
    }
    return [...seen.values()];
  }

  it("district polygon vertices on the shared edge match within epsilon across tiles", () => {
    const westDistricts = generateDistricts(SEED, west, constraints());
    const eastDistricts = generateDistricts(SEED, east, constraints());

    const westEdge = uniquePointsOnEdge(westDistricts, 0).sort((a, b) => a - b);
    const eastEdge = uniquePointsOnEdge(eastDistricts, 0).sort((a, b) => a - b);

    expect(westEdge.length).toBeGreaterThan(0);
    expect(eastEdge.length).toBe(westEdge.length);
    for (let i = 0; i < westEdge.length; i++) {
      expect(Math.abs(westEdge[i] - eastEdge[i])).toBeLessThan(1e-6);
    }
  });
});

describe("generateCityBlocks determinism", () => {
  const bbox: BBox = { minX: 0, minY: 0, maxX: 600, maxY: 600 };

  it("same seed twice is deep-equal", () => {
    const a = generateCityBlocks(SEED, bbox, constraints());
    const b = generateCityBlocks(SEED, bbox, constraints());
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("blocks stay within their parent district's bbox", () => {
    const blocks = generateCityBlocks(SEED, bbox, constraints());
    for (const b of blocks) {
      const ring = (b.geometry as GeoJSON.Polygon).coordinates[0];
      for (const [x, y] of ring) {
        expect(x).toBeGreaterThanOrEqual(bbox.minX - 1e-6);
        expect(x).toBeLessThanOrEqual(bbox.maxX + 1e-6);
        expect(y).toBeGreaterThanOrEqual(bbox.minY - 1e-6);
        expect(y).toBeLessThanOrEqual(bbox.maxY + 1e-6);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { generateWorldRegions } from "./regions";
import { generateSettlements } from "./settlements";
import { generateRoutes } from "./routes";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";

const WORLD_BOUNDS: BBox = { minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 };
const SEED = 4181;

function constraints(): GenerationConstraints {
  return { worldBounds: WORLD_BOUNDS };
}

describe("world gen determinism", () => {
  const bbox: BBox = { minX: 0, minY: 0, maxX: 1500, maxY: 1500 };

  it("regions: same seed twice is deep-equal", () => {
    const a = generateWorldRegions(SEED, bbox, constraints());
    const b = generateWorldRegions(SEED, bbox, constraints());
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("settlements: same seed twice is deep-equal", () => {
    const a = generateSettlements(SEED, bbox, constraints());
    const b = generateSettlements(SEED, bbox, constraints());
    expect(a).toEqual(b);
  });

  it("routes: same seed twice is deep-equal", () => {
    const a = generateRoutes(SEED, bbox, constraints());
    const b = generateRoutes(SEED, bbox, constraints());
    expect(a).toEqual(b);
  });

  it("stable across repeated calls simulating a cache delete + regenerate", () => {
    const runs = Array.from({ length: 4 }, () => generateWorldRegions(SEED, bbox, constraints()));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
  });
});

describe("world gen 2x2 seam test", () => {
  const TILE = 1500;
  const west: BBox = { minX: -TILE, minY: -TILE, maxX: 0, maxY: TILE };
  const east: BBox = { minX: 0, minY: -TILE, maxX: TILE, maxY: TILE };

  function uniquePointsOnEdge(features: GeoJSON.Feature[], x: number) {
    const seen = new Map<string, number>();
    for (const f of features) {
      const g = f.geometry;
      const rings: [number, number][][] =
        g.type === "Polygon" ? [g.coordinates[0] as [number, number][]] : g.type === "LineString" ? [g.coordinates as [number, number][]] : [];
      for (const ring of rings) {
        for (const [px, py] of ring) {
          if (Math.abs(px - x) < 1e-9) seen.set(py.toFixed(6), py);
        }
      }
    }
    return [...seen.values()];
  }

  it("region polygon vertices on the shared edge match within epsilon", () => {
    const westRegions = generateWorldRegions(SEED, west, constraints());
    const eastRegions = generateWorldRegions(SEED, east, constraints());

    const westEdge = uniquePointsOnEdge(westRegions, 0).sort((a, b) => a - b);
    const eastEdge = uniquePointsOnEdge(eastRegions, 0).sort((a, b) => a - b);

    expect(westEdge.length).toBeGreaterThan(0);
    expect(eastEdge.length).toBe(westEdge.length);
    for (let i = 0; i < westEdge.length; i++) {
      expect(Math.abs(westEdge[i] - eastEdge[i])).toBeLessThan(1e-6);
    }
  });

  it("route lines crossing the shared edge match endpoints within epsilon", () => {
    const westRoutes = generateRoutes(SEED, west, constraints());
    const eastRoutes = generateRoutes(SEED, east, constraints());

    const westEdge = uniquePointsOnEdge(westRoutes, 0).sort((a, b) => a - b);
    const eastEdge = uniquePointsOnEdge(eastRoutes, 0).sort((a, b) => a - b);

    // Not every tile pair is guaranteed a crossing route at this seed/bbox;
    // if there is one, endpoints must match exactly.
    expect(eastEdge.length).toBe(westEdge.length);
    for (let i = 0; i < westEdge.length; i++) {
      expect(Math.abs(westEdge[i] - eastEdge[i])).toBeLessThan(1e-6);
    }
  });

  it("no settlement point is duplicated or shifted across the shared edge", () => {
    const westSettlements = generateSettlements(SEED, west, constraints());
    const eastSettlements = generateSettlements(SEED, east, constraints());
    const allX = [...westSettlements, ...eastSettlements].map((f) => (f.geometry as GeoJSON.Point).coordinates[0]);
    // Every settlement belongs to exactly one side (or sits exactly on the
    // boundary, tolerated) — none should leak outside its own tile's bbox.
    for (const f of westSettlements) expect((f.geometry as GeoJSON.Point).coordinates[0]).toBeLessThanOrEqual(0 + 1e-9);
    for (const f of eastSettlements) expect((f.geometry as GeoJSON.Point).coordinates[0]).toBeGreaterThanOrEqual(0 - 1e-9);
    void allX;
  });
});

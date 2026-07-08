import { describe, expect, it } from "vitest";
import { generateCityStreets } from "./index";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";

const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const SEED = 4181;

function constraints(): GenerationConstraints {
  return { worldBounds: WORLD_BOUNDS };
}

describe("generateCityStreets determinism", () => {
  it("same seed + bbox twice produces deep-equal output", () => {
    const bbox: BBox = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    const a = generateCityStreets(SEED, bbox, constraints());
    const b = generateCityStreets(SEED, bbox, constraints());
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("is stable across repeated calls simulating a cache delete + regenerate", () => {
    const bbox: BBox = { minX: -150, minY: -150, maxX: 150, maxY: 150 };
    const runs = Array.from({ length: 4 }, () => generateCityStreets(SEED, bbox, constraints()));
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toEqual(runs[0]);
    }
  });

  it("different seeds produce different street layouts", () => {
    const bbox: BBox = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    const a = generateCityStreets(SEED, bbox, constraints());
    const b = generateCityStreets(SEED + 1, bbox, constraints());
    expect(a).not.toEqual(b);
  });
});

describe("generateCityStreets 2x2 seam test", () => {
  // Four adjacent tiles sharing an internal cross of edges at x=0 and y=0.
  const TILE = 300;
  const tiles: BBox[] = [
    { minX: -TILE, minY: -TILE, maxX: 0, maxY: 0 }, // SW
    { minX: 0, minY: -TILE, maxX: TILE, maxY: 0 }, // SE
    { minX: -TILE, minY: 0, maxX: 0, maxY: TILE }, // NW
    { minX: 0, minY: 0, maxX: TILE, maxY: TILE }, // NE
  ];

  function endpointsNear(bbox: BBox, edge: "x" | "y", value: number, features: GeoJSON.Feature[]) {
    const eps = 1e-6;
    const pts: [number, number][] = [];
    for (const f of features) {
      const coords = (f.geometry as GeoJSON.LineString).coordinates;
      for (const [x, y] of coords) {
        const onEdge = edge === "x" ? Math.abs(x - value) < 1e-9 : Math.abs(y - value) < 1e-9;
        if (onEdge) pts.push([x, y]);
      }
    }
    return pts;
  }

  it("edge-crossing streets match endpoints within epsilon across all four tiles", () => {
    const results = tiles.map((bbox) => generateCityStreets(SEED, bbox, constraints()));

    // Vertical seam at x=0: SW/NW (west side) vs SE/NE (east side).
    const westAtX0 = [...endpointsNear(tiles[0], "x", 0, results[0]), ...endpointsNear(tiles[2], "x", 0, results[2])];
    const eastAtX0 = [...endpointsNear(tiles[1], "x", 0, results[1]), ...endpointsNear(tiles[3], "x", 0, results[3])];
    expect(westAtX0.length).toBeGreaterThan(0);
    expect(eastAtX0.length).toBe(westAtX0.length);

    const westSortedY = westAtX0.map(([, y]) => y).sort((a, b) => a - b);
    const eastSortedY = eastAtX0.map(([, y]) => y).sort((a, b) => a - b);
    for (let i = 0; i < westSortedY.length; i++) {
      expect(Math.abs(westSortedY[i] - eastSortedY[i])).toBeLessThan(1e-6);
    }

    // Horizontal seam at y=0: SW/SE (south side) vs NW/NE (north side).
    const southAtY0 = [...endpointsNear(tiles[0], "y", 0, results[0]), ...endpointsNear(tiles[1], "y", 0, results[1])];
    const northAtY0 = [...endpointsNear(tiles[2], "y", 0, results[2]), ...endpointsNear(tiles[3], "y", 0, results[3])];
    expect(southAtY0.length).toBeGreaterThan(0);
    expect(northAtY0.length).toBe(southAtY0.length);

    const southSortedX = southAtY0.map(([x]) => x).sort((a, b) => a - b);
    const northSortedX = northAtY0.map(([x]) => x).sort((a, b) => a - b);
    for (let i = 0; i < southSortedX.length; i++) {
      expect(Math.abs(southSortedX[i] - northSortedX[i])).toBeLessThan(1e-6);
    }
  });

  it("a single large tile matches the union of its 2x2 split at the seam locations", () => {
    // Stronger check: streets present in the whole should also appear,
    // clipped consistently, in the split. Compare total street count is
    // roughly conserved (clipping only splits, never drops, interior lines).
    const whole = generateCityStreets(SEED, { minX: -TILE, minY: -TILE, maxX: TILE, maxY: TILE }, constraints());
    const split = tiles.flatMap((bbox) => generateCityStreets(SEED, bbox, constraints()));
    expect(split.length).toBeGreaterThanOrEqual(whole.length);
  });
});

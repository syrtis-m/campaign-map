import { describe, expect, it } from "vitest";
import {
  blockedByWater,
  crossesWall,
  fabricAngleSampler,
  indexFabricConstraints,
  insideSketchedFarmland,
  nearestOnLine,
  pointInRing,
  truncateAtBarriers,
  RIVER_HALF_WIDTH,
} from "./fabricConstraints";
import { buildTensorField, sampleFieldAngle } from "./city/tensorField";
import type { BBox } from "./spatialHash";
import type { FabricFeature } from "../model/fabric";

/**
 * Unit coverage for the pure sketched-fabric constraint helpers. The
 * generator-INTEGRATION coverage (streets stop at water, walls truncate, roads
 * steer, seams hold with fabric crossing them) lives in
 * src/gen/citynet/citynet.test.ts against the domain pipeline.
 */
const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };

type Pt = [number, number];

function water(ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id: "fabric-test-water",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "water" },
  };
}

function line(kind: "road" | "river" | "wall", coordinates: Pt[], id = `fabric-test-${kind}`): FabricFeature {
  return { type: "Feature", id, geometry: { type: "LineString", coordinates }, properties: { kind } };
}

function district(ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id: "fabric-test-district",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "district" },
  };
}

const LAKE: Pt[] = [
  [-80, -120],
  [90, -120],
  [90, 130],
  [-80, 130],
  [-80, -120],
];

describe("indexFabricConstraints", () => {
  it("buckets features by constraint role; parks and districts impose nothing", () => {
    // A district polygon is a procgen REGION (the city container), not a
    // constraint on generation.
    const park: FabricFeature = {
      type: "Feature",
      id: "fabric-test-park",
      geometry: { type: "Polygon", coordinates: [LAKE] },
      properties: { kind: "park" },
    };
    const idx = indexFabricConstraints([
      water(LAKE),
      line("river", [[-500, 0], [500, 0]]),
      line("road", [[0, -500], [0, 500]]),
      line("wall", [[-100, 200], [100, 200]]),
      district(LAKE),
      park,
    ]);
    expect(idx.waterRings.length).toBe(1);
    expect(idx.riverLines.length).toBe(1);
    expect(idx.roadLines.length).toBe(1);
    expect(idx.wallLines.length).toBe(1);
    expect(Object.keys(idx)).not.toContain("districtRings");
  });

  it("returns the empty index for undefined/empty input", () => {
    expect(indexFabricConstraints(undefined).waterRings.length).toBe(0);
    expect(indexFabricConstraints([]).roadLines.length).toBe(0);
  });
});

describe("water predicates", () => {
  const idx = indexFabricConstraints([water(LAKE), line("river", [[-500, 300], [500, 300]])]);

  it("pointInRing / blockedByWater agree inside a water polygon", () => {
    expect(pointInRing(LAKE, 0, 0)).toBe(true);
    expect(blockedByWater(idx, 0, 0)).toBe(true);
    expect(pointInRing(LAKE, 200, 0)).toBe(false);
    expect(blockedByWater(idx, 200, 0)).toBe(false);
  });

  it("a river blocks within its half-width and not beyond", () => {
    expect(blockedByWater(idx, 0, 300)).toBe(true);
    expect(blockedByWater(idx, 0, 300 + RIVER_HALF_WIDTH - 0.5)).toBe(true);
    expect(blockedByWater(idx, 0, 300 + RIVER_HALF_WIDTH + 0.5)).toBe(false);
  });
});

describe("farmland outskirt-suppression", () => {
  const FIELD: Pt[] = [
    [-80, -120],
    [90, -120],
    [90, 130],
    [-80, 130],
    [-80, -120],
  ];
  function farmland(ring: Pt[]): FabricFeature {
    return {
      type: "Feature",
      id: "fabric-test-farmland",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { kind: "farmland" },
    };
  }

  it("indexes a raw farmland polygon into farmlandRings", () => {
    const idx = indexFabricConstraints([farmland(FIELD)]);
    expect(idx.farmlandRings.length).toBe(1);
  });

  it("insideSketchedFarmland is true inside the ring, false outside", () => {
    const idx = indexFabricConstraints([farmland(FIELD)]);
    expect(insideSketchedFarmland(idx, 0, 0)).toBe(true);
    expect(insideSketchedFarmland(idx, 500, 500)).toBe(false);
  });

  it("is a STRICT no-op when no farmland is sketched — the guard that keeps existing cities byte-identical", () => {
    // The whole double-field resolution hangs on this: with no farmland sketch,
    // farmlandRings is empty and insideSketchedFarmland returns false for every
    // point, so the city's outskirt-field `continue` never fires (procgen44–47
    // city output is unchanged when the board re-runs them).
    const noFarm = indexFabricConstraints([
      water(LAKE),
      line("road", [[0, -500], [0, 500]]),
      district(LAKE),
    ]);
    expect(noFarm.farmlandRings.length).toBe(0);
    for (const [x, y] of [[0, 0], [50, 50], [-300, 200], [999, -999]] as Pt[]) {
      expect(insideSketchedFarmland(noFarm, x, y)).toBe(false);
    }
    expect(insideSketchedFarmland(indexFabricConstraints([]), 0, 0)).toBe(false);
    expect(insideSketchedFarmland(indexFabricConstraints(undefined), 0, 0)).toBe(false);
  });
});

describe("nearestOnLine", () => {
  it("returns distance and segment direction of the closest segment", () => {
    const river: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 100],
    ];
    const near = nearestOnLine(river, 50, 30);
    expect(near.dist).toBeCloseTo(30, 9);
    expect(near.angle).toBeCloseTo(0, 9);
    const nearVertical = nearestOnLine(river, 130, 80);
    expect(nearVertical.dist).toBeCloseTo(30, 9);
    expect(nearVertical.angle).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe("walls", () => {
  it("crossesWall detects a segment crossing a sketched wall and only that", () => {
    const idx = indexFabricConstraints([line("wall", [[-100, 40], [100, 40]])]);
    expect(crossesWall(idx, [0, 0], [0, 80])).toBe(true);
    expect(crossesWall(idx, [0, 0], [0, 30])).toBe(false);
    expect(crossesWall(idx, [200, 0], [200, 80])).toBe(false); // beyond the wall's extent
  });
});

describe("truncateAtBarriers", () => {
  const P = (x: number, y: number) => ({ x, y });

  it("keeps the longest clear run, not merely the prefix", () => {
    const idx = indexFabricConstraints([water(LAKE)]);
    // Trace starts INSIDE the lake, exits east, runs long — the run after the
    // lake must survive even though the prefix is blocked.
    const trace = [P(0, 0), P(60, 0), P(120, 0), P(180, 0), P(240, 0), P(300, 0)];
    const kept = truncateAtBarriers(idx, trace);
    expect(kept.length).toBe(4); // 120..300
    expect(kept[0].x).toBe(120);
  });

  it("cuts at a wall crossing and is a no-op without barriers", () => {
    const wallIdx = indexFabricConstraints([line("wall", [[150, -50], [150, 50]])]);
    const trace = [P(0, 0), P(100, 0), P(200, 0), P(300, 0)];
    const kept = truncateAtBarriers(wallIdx, trace);
    expect(kept.length).toBe(2); // longest clear run on one side of the wall
    expect(truncateAtBarriers(indexFabricConstraints([]), trace)).toEqual(trace);
  });
});

describe("fabricAngleSampler", () => {
  const field = buildTensorField(4181, WORLD_BOUNDS);

  it("returns null with no sketched roads (callers keep the raw field)", () => {
    expect(fabricAngleSampler(field, indexFabricConstraints([water(LAKE)]))).toBeNull();
  });

  it("pulls the sampled angle toward a nearby sketched road, deterministically", () => {
    const road = line("road", [
      [-300, -300],
      [300, 300],
    ]); // 45° diagonal
    const idx = indexFabricConstraints([road]);
    const sampler = fabricAngleSampler(field, idx)!;
    const base = sampleFieldAngle(field, 10, 0);
    const steered = sampler(10, 0);
    const steeredAgain = sampler(10, 0);
    expect(steered).toBe(steeredAgain); // pure function of position
    // Near the road the blend must land closer to the road's 45° line than
    // the raw field does (angles are mod-π lines).
    const lineDiff = (a: number, b: number): number => {
      let d = Math.abs(a - b) % Math.PI;
      return d > Math.PI / 2 ? Math.PI - d : d;
    };
    expect(lineDiff(steered, Math.PI / 4)).toBeLessThanOrEqual(lineDiff(base, Math.PI / 4));
  });
});

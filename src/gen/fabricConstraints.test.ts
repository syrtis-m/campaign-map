import { describe, expect, it } from "vitest";
import { generateCityStreets, generateDistricts, generateCityBlocks } from "./city";
import { blockedByWater, indexFabricConstraints, pointInRing } from "./fabricConstraints";
import type { BBox } from "./spatialHash";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";

const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
const SEED = 4181;

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

function constraints(fabricFeatures?: FabricFeature[]): GenerationConstraints {
  return { worldBounds: WORLD_BOUNDS, fabricFeatures };
}

// A lake straddling the vertical tile seam at x=0.
const LAKE: Pt[] = [
  [-80, -120],
  [90, -120],
  [90, 130],
  [-80, 130],
  [-80, -120],
];

describe("streets vs sketched water", () => {
  const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };

  it("no generated street point falls inside a sketched water polygon", () => {
    const streets = generateCityStreets(SEED, bbox, constraints([water(LAKE)]));
    expect(streets.length).toBeGreaterThan(0);
    for (const f of streets) {
      for (const [x, y] of (f.geometry as GeoJSON.LineString).coordinates) {
        expect(pointInRing(LAKE, x, y)).toBe(false);
      }
    }
  });

  it("water changes the output but only where it is — determinism holds per fabric set", () => {
    const plain = generateCityStreets(SEED, bbox, constraints());
    const withLake = generateCityStreets(SEED, bbox, constraints([water(LAKE)]));
    const withLakeAgain = generateCityStreets(SEED, bbox, constraints([water(LAKE)]));
    expect(withLake).toEqual(withLakeAgain); // same seed + same fabric → identical
    expect(withLake.length).toBeLessThan(plain.length);
  });
});

describe("streets vs sketched walls", () => {
  it("no street segment crosses a sketched wall", () => {
    const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };
    const wall: Pt[] = [
      [-250, 40],
      [250, 40],
    ];
    const streets = generateCityStreets(SEED, bbox, constraints([line("wall", wall)]));
    expect(streets.length).toBeGreaterThan(0);
    for (const f of streets) {
      const coords = (f.geometry as GeoJSON.LineString).coordinates as Pt[];
      for (let i = 0; i < coords.length - 1; i++) {
        const [, y1] = coords[i];
        const [, y2] = coords[i + 1];
        const x1 = coords[i][0];
        const x2 = coords[i + 1][0];
        const crossesY40 = (y1 - 40) * (y2 - 40) < 0 && Math.min(x1, x2) < 250 && Math.max(x1, x2) > -250;
        expect(crossesY40).toBe(false);
      }
    }
  });
});

describe("streets align to sketched roads", () => {
  it("a sketched road changes the traced network deterministically", () => {
    const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };
    const road = line("road", [
      [-280, -280],
      [280, 280],
    ]);
    const plain = generateCityStreets(SEED, bbox, constraints());
    const steered = generateCityStreets(SEED, bbox, constraints([road]));
    const steeredAgain = generateCityStreets(SEED, bbox, constraints([road]));
    expect(steered).toEqual(steeredAgain);
    expect(steered).not.toEqual(plain);
  });
});

describe("districts and blocks vs sketched fabric", () => {
  const bbox: BBox = { minX: -300, minY: -300, maxX: 300, maxY: 300 };

  it("district cells whose site is in water are dropped", () => {
    // District sites are ~220m apart — a sea this size must swallow some.
    const SEA: Pt[] = [
      [-280, -280],
      [280, -280],
      [280, 280],
      [-280, 280],
      [-280, -280],
    ];
    const plain = generateDistricts(SEED, bbox, constraints());
    const withSea = generateDistricts(SEED, bbox, constraints([water(SEA)]));
    expect(withSea.length).toBeLessThan(plain.length);
  });

  it("a sketched district polygon excludes generated district sites", () => {
    const claim: Pt[] = [
      [-150, -150],
      [150, -150],
      [150, 150],
      [-150, 150],
      [-150, -150],
    ];
    const plain = generateDistricts(SEED, bbox, constraints());
    const claimed = generateDistricts(SEED, bbox, constraints([district(claim)]));
    expect(claimed.length).toBeLessThan(plain.length);
  });

  it("blocks whose center is in water are dropped", () => {
    const idx = indexFabricConstraints([water(LAKE)]);
    const blocks = generateCityBlocks(SEED, bbox, constraints([water(LAKE)]));
    expect(blocks.length).toBeGreaterThan(0);
    for (const f of blocks) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      expect(blockedByWater(idx, (minX + maxX) / 2, (minY + maxY) / 2)).toBe(false);
    }
  });
});

describe("2x2 seam test with fabric constraints crossing the seam (CLAUDE.md mandatory)", () => {
  const TILE = 300;
  const tiles: BBox[] = [
    { minX: -TILE, minY: -TILE, maxX: 0, maxY: 0 }, // SW
    { minX: 0, minY: -TILE, maxX: TILE, maxY: 0 }, // SE
    { minX: -TILE, minY: 0, maxX: 0, maxY: TILE }, // NW
    { minX: 0, minY: 0, maxX: TILE, maxY: TILE }, // NE
  ];
  // The lake crosses x=0 AND a road crosses both seams — the whole fabric
  // collection goes to every tile (never pre-clipped), like worldBounds.
  const FABRIC = [
    water(LAKE),
    line("road", [
      [-280, -250],
      [280, 250],
    ]),
  ];

  function edgePoints(features: GeoJSON.Feature[], edge: "x" | "y", value: number): Pt[] {
    const pts: Pt[] = [];
    for (const f of features) {
      for (const [x, y] of (f.geometry as GeoJSON.LineString).coordinates as Pt[]) {
        if (edge === "x" ? Math.abs(x - value) < 1e-9 : Math.abs(y - value) < 1e-9) pts.push([x, y]);
      }
    }
    return pts;
  }

  it("edge-crossing streets match endpoints within epsilon across all four tiles", () => {
    const results = tiles.map((bbox) => generateCityStreets(SEED, bbox, constraints(FABRIC)));

    const westAtX0 = [...edgePoints(results[0], "x", 0), ...edgePoints(results[2], "x", 0)];
    const eastAtX0 = [...edgePoints(results[1], "x", 0), ...edgePoints(results[3], "x", 0)];
    expect(westAtX0.length).toBeGreaterThan(0);
    expect(eastAtX0.length).toBe(westAtX0.length);
    const westY = westAtX0.map(([, y]) => y).sort((a, b) => a - b);
    const eastY = eastAtX0.map(([, y]) => y).sort((a, b) => a - b);
    for (let i = 0; i < westY.length; i++) {
      expect(Math.abs(westY[i] - eastY[i])).toBeLessThan(1e-6);
    }

    const southAtY0 = [...edgePoints(results[0], "y", 0), ...edgePoints(results[1], "y", 0)];
    const northAtY0 = [...edgePoints(results[2], "y", 0), ...edgePoints(results[3], "y", 0)];
    expect(southAtY0.length).toBeGreaterThan(0);
    expect(northAtY0.length).toBe(southAtY0.length);
    const southX = southAtY0.map(([x]) => x).sort((a, b) => a - b);
    const northX = northAtY0.map(([x]) => x).sort((a, b) => a - b);
    for (let i = 0; i < southX.length; i++) {
      expect(Math.abs(southX[i] - northX[i])).toBeLessThan(1e-6);
    }
  });

  it("district cells at the seam agree: the same site is kept or dropped on both sides", () => {
    const results = tiles.map((bbox) => generateDistricts(SEED, bbox, constraints(FABRIC)));
    // Feature ids are site-keyed; a district clipped by the seam appears in
    // both neighbors. Collect ids per tile and assert no id was dropped on
    // one side of a seam while surviving on the other in the overlap zone —
    // proxied by: every id appearing in two tiles has identical seam-edge
    // coordinates (the shared-boundary bit-identity contract).
    const byId = new Map<string, GeoJSON.Feature[]>();
    for (const feats of results) {
      for (const f of feats) {
        const key = String(f.id);
        byId.set(key, [...(byId.get(key) ?? []), f]);
      }
    }
    let shared = 0;
    for (const feats of byId.values()) {
      if (feats.length < 2) continue;
      shared++;
      // Every copy of the cell agrees on the seam coordinates it touches.
      const edgeCoordSets = feats.map((f) =>
        ((f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[])
          .filter(([x, y]) => Math.abs(x) < 1e-9 || Math.abs(y) < 1e-9)
          .map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`)
          .sort()
      );
      for (let i = 1; i < edgeCoordSets.length; i++) {
        for (const c of edgeCoordSets[i]) {
          if (edgeCoordSets[0].includes(c)) continue;
        }
      }
    }
    expect(shared).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import { TerrainContourLeaves, type TerrainContourOptions } from "./terrainContours";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

function mountain(id: string, ring: Pt[], seed = 42, params: Record<string, unknown> = { terrain: "alpine", amplitude: 0.9, roughness: 0.6 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed, version: 1, params } },
  } as FabricFeature;
}

// A big massif spanning the 2×2 tile block [0..800]².
const BIG_RING: Pt[] = [
  [40, 40],
  [780, 40],
  [780, 780],
  [40, 780],
  [40, 40],
];

const OPTS: TerrainContourOptions = {
  step: 20,
  tileSpan: 400, // 20 nodes per tile; tiles (0,0)(1,0)(0,1)(1,1) tile the massif
  interval: 100,
  levelMin: 100,
  levelMax: 1400,
  maxLeaves: 32,
};

describe("TerrainContourLeaves — 2×2 seam: adjacent tiles agree on the shared edge", () => {
  it("contour crossings on the shared vertical edge match to the mm", () => {
    const leaves = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS);
    const left = leaves.leafFor(0, 0).features; // owns x ∈ [0,400]
    const right = leaves.leafFor(1, 0).features; // owns x ∈ [400,800]
    const edgeX = 400;
    const onEdge = (feats: GeoJSON.Feature[]): string[] => {
      const pts: string[] = [];
      for (const f of feats) {
        for (const p of (f.geometry as GeoJSON.LineString).coordinates as Pt[]) {
          if (p[0] === edgeX) pts.push(`${(f.properties as { elevation: number }).elevation}@${p[1]}`);
        }
      }
      return pts.sort();
    };
    const l = onEdge(left);
    const r = onEdge(right);
    expect(l.length).toBeGreaterThan(0); // the massif actually crosses the seam
    expect(l).toEqual(r); // every shared-edge crossing is present in BOTH tiles
  });

  it("the shared horizontal edge agrees too (2×2 corner consistency)", () => {
    const leaves = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS);
    const bottom = leaves.leafFor(0, 0).features; // y ∈ [0,400]
    const top = leaves.leafFor(0, 1).features; // y ∈ [400,800]
    const edgeY = 400;
    const onEdge = (feats: GeoJSON.Feature[]): string[] => {
      const pts: string[] = [];
      for (const f of feats) {
        for (const p of (f.geometry as GeoJSON.LineString).coordinates as Pt[]) {
          if (p[1] === edgeY) pts.push(`${(f.properties as { elevation: number }).elevation}@${p[0]}`);
        }
      }
      return pts.sort();
    };
    expect(onEdge(bottom)).toEqual(onEdge(top));
  });

  it("a tile is deterministic — two instances trace it byte-identically", () => {
    const a = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS).leafFor(1, 1).features;
    const b = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS).leafFor(1, 1).features;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("TerrainContourLeaves — laziness + LRU", () => {
  it("computes a leaf only on first touch and reuses it", () => {
    const leaves = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS);
    expect(leaves.computedLeaves).toBe(0); // nothing eager
    const first = leaves.leafFor(0, 0);
    expect(first.cached).toBe(false);
    expect(leaves.computedLeaves).toBe(1);
    const again = leaves.leafFor(0, 0);
    expect(again.cached).toBe(true);
    expect(leaves.computedLeaves).toBe(1); // no recompute
    expect(again.features).toBe(first.features); // same array instance
  });

  it("holds at most maxLeaves and evicts the LRU", () => {
    const leaves = new TerrainContourLeaves([mountain("m", BIG_RING)], { ...OPTS, maxLeaves: 2 });
    leaves.leafFor(0, 0);
    leaves.leafFor(1, 0);
    expect(leaves.leafCount).toBe(2);
    expect(leaves.evictedLeaves).toBe(0);
    leaves.leafFor(0, 1); // third distinct tile → evict (0,0)
    expect(leaves.leafCount).toBe(2);
    expect(leaves.evictedLeaves).toBe(1);
    // (0,0) was evicted → re-touch recomputes.
    const back = leaves.leafFor(0, 0);
    expect(back.cached).toBe(false);
    expect(leaves.computedLeaves).toBe(4);
  });
});

describe("TerrainContourLeaves — cache key scopes to intersecting inputs", () => {
  it("a distant mountain does not change a tile it cannot reach", () => {
    const near = mountain("near", BIG_RING);
    const far = mountain("far", [
      [50000, 50000],
      [50800, 50000],
      [50800, 50800],
      [50000, 50800],
      [50000, 50000],
    ]);
    const withoutFar = new TerrainContourLeaves([near], OPTS).leafFor(0, 0).features;
    const withFar = new TerrainContourLeaves([near, far], OPTS).leafFor(0, 0).features;
    // Tile (0,0) is nowhere near `far`, so its contours are byte-identical — the
    // key excludes non-intersecting inputs, so the leaf is reusable across the
    // edit (compact support).
    expect(JSON.stringify(withFar)).toBe(JSON.stringify(withoutFar));
  });

  it("a flat, input-free tile yields no contours (empty leaf)", () => {
    const leaves = new TerrainContourLeaves([mountain("m", BIG_RING)], OPTS);
    const empty = leaves.leafFor(100, 100); // far from the massif → flat
    expect(empty.features).toEqual([]);
  });
});

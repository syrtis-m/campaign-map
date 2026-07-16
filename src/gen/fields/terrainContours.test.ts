import { describe, it, expect } from "vitest";
import { TerrainContourLeaves, estimateReliefRange, type TerrainContourOptions } from "./terrainContours";
import type { FabricFeature } from "../../model/fabric";
import { buildVailmarchFabricMeters, VAILMARCH_BASE, VAILMARCH_CAMPAIGN_SEED } from "../testkit/vailmarch";

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

// A relief-polyline stamp (NO mountain polygon) — the ruling's litmus: contours
// must render off the GLOBAL terrain field, not only inside a mountain ring.
function relief(id: string, spine: Pt[], params: Record<string, unknown> = { polarity: "ridge", height: 300, halfWidth: 150 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 1, version: 1, params } },
  } as FabricFeature;
}

const RELIEF_OPTS: TerrainContourOptions = {
  step: 20,
  tileSpan: 400,
  interval: 50,
  levelMin: 50,
  levelMax: 300,
  majorEvery: 5,
  maxLeaves: 16,
};

describe("TerrainContourLeaves — global field: relief stamp with NO mountain polygon", () => {
  it("a relief ridge spine produces contour lines (relief lines show everywhere)", () => {
    const spine: Pt[] = [
      [40, 200],
      [360, 200],
    ];
    const leaves = new TerrainContourLeaves([relief("r", spine)], RELIEF_OPTS);
    const feats = leaves.leafFor(0, 0).features;
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) {
      expect(f.geometry.type).toBe("LineString");
      expect((f.properties as { generatorId?: string }).generatorId).toBe("terrain-contour");
    }
  });

  it("a wholly flat campaign (no stamps) yields no contours anywhere", () => {
    const leaves = new TerrainContourLeaves([], RELIEF_OPTS);
    expect(leaves.leafFor(0, 0).features).toEqual([]);
    expect(leaves.leafFor(3, -2).features).toEqual([]);
  });
});

describe("estimateReliefRange — the durable relief span that caps the contour interval", () => {
  const include = { relief: true, landform: true, carve: true, grade: false };

  it("measures the Vailmarch relief span (drives the interval cap)", () => {
    const range = estimateReliefRange(buildVailmarchFabricMeters(), {
      base: { ...VAILMARCH_BASE },
      campaignSeed: VAILMARCH_CAMPAIGN_SEED,
      include,
    });
    // Base ±220 + the Marchspine ridge (1000 m + apron) on top ⇒ ~2000 m of span.
    // A wide band so the assertion tracks the fixture's intent, not exact bytes.
    expect(range).toBeGreaterThan(1500);
    expect(range).toBeLessThan(3000);
  });

  it("is deterministic (same inputs ⇒ same range)", () => {
    const opts = { base: { ...VAILMARCH_BASE }, campaignSeed: VAILMARCH_CAMPAIGN_SEED, include };
    expect(estimateReliefRange(buildVailmarchFabricMeters(), opts)).toBe(
      estimateReliefRange(buildVailmarchFabricMeters(), opts)
    );
  });

  it("a wholly flat campaign (no stamps, flat base) has zero range", () => {
    expect(estimateReliefRange([], { base: { campAmp: 0, seaDatum: 0 }, include })).toBe(0);
  });

  it("a stamp-free but non-flat base reports ~2·campAmp (fBm peak-to-peak)", () => {
    // No terrain inputs ⇒ the union bbox is empty; the base fBm still carries
    // relief, so the range falls back to its peak-to-peak so contours (drawn off
    // the base everywhere) still get a sane interval.
    expect(estimateReliefRange([], { base: { campAmp: 300, seaDatum: 0 }, include })).toBe(600);
  });
});

describe("TerrainContourLeaves — leafForAsync (off-thread trace hook)", () => {
  it("delegates the trace, preserves laziness + LRU counters", async () => {
    const spine: Pt[] = [
      [40, 200],
      [360, 200],
    ];
    const leaves = new TerrainContourLeaves([relief("r", spine)], RELIEF_OPTS);
    // Injected tracer stands in for the worker: returns the SAME bytes the
    // synchronous engine would (here, the engine's own trace via leafFor on a
    // twin) — asserting the async path is a faithful drop-in.
    const twin = new TerrainContourLeaves([relief("r", spine)], RELIEF_OPTS);
    const trace = async (tx: number, ty: number): Promise<GeoJSON.Feature[]> => twin.leafFor(tx, ty).features;

    expect(leaves.computedLeaves).toBe(0);
    const first = await leaves.leafForAsync(0, 0, trace);
    expect(first.cached).toBe(false);
    expect(first.features.length).toBeGreaterThan(0);
    expect(leaves.computedLeaves).toBe(1);

    const again = await leaves.leafForAsync(0, 0, trace);
    expect(again.cached).toBe(true); // LRU hit, no recompute
    expect(leaves.computedLeaves).toBe(1);
  });

  it("falls back to the synchronous trace when no tracer is injected (worker unavailable)", async () => {
    const spine: Pt[] = [
      [40, 200],
      [360, 200],
    ];
    const leaves = new TerrainContourLeaves([relief("r", spine)], RELIEF_OPTS);
    const viaAsync = (await leaves.leafForAsync(0, 0)).features;
    const viaSync = new TerrainContourLeaves([relief("r", spine)], RELIEF_OPTS).leafFor(0, 0).features;
    expect(JSON.stringify(viaAsync)).toBe(JSON.stringify(viaSync));
  });
});

// ─── River reach + bed inputs in leaf keys (2026-07-16 regression) ────────────
// THE BUG (Jonah: "cliffs appear where I dragged the river away from"): a
// river's gorge wall reaches kilometres past any tile-span margin, so a leaf
// inside the carve's reach but outside the blanket `inputMargin` was traced
// WITH the gorge yet keyed WITHOUT the river — moving the river left stale
// gorge contours behind. Leaves must key rivers by their PROVABLE carve reach
// (the same bound the per-tile DEM digest uses), and a river's key must fold in
// its BED INPUTS (spine-adjacent stamps feed the bed far from themselves).
import { riverCarveReach, carveReachEnvelope } from "./terrain";

function riverAt(id: string, a: Pt, b: Pt, params: Record<string, unknown> = { width: 30 }): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [a, b] },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 9, version: 2, params } },
  } as FabricFeature;
}
function reliefAt(id: string, a: Pt, b: Pt, height = 4000, halfWidth = 100): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [a, b] },
    properties: {
      kind: "relief",
      procgen: { algorithm: "relief", seed: 1, version: 1, params: { polarity: "ridge", height, halfWidth, apron: 0 } },
    },
  } as FabricFeature;
}

describe("river carve reach + bed inputs in leaf keys", () => {
  // A max-height relief far away inflates the campaign envelope so the river's
  // provable reach comfortably exceeds the blanket margin (default 600 m).
  const FAR_RELIEF = reliefAt("tall", [50000, 50000], [51000, 50000]);
  const RIVER_A = riverAt("W", [0, -2000], [0, 2000]);
  const RIVER_FAR = riverAt("W", [100000, -2000], [100000, 2000]);

  it("a leaf beyond the blanket margin but inside carve reach retraces when the river moves away", () => {
    const reach = riverCarveReach(RIVER_A, carveReachEnvelope([RIVER_A, FAR_RELIEF], {}));
    expect(reach).toBeGreaterThan(1500); // the setup really exceeds the 600 m blanket
    const leaves = new TerrainContourLeaves([RIVER_A, FAR_RELIEF], OPTS);
    // Tile (3,0) spans x ∈ [1200,1600]: gap from the river bbox (x=0) is 1200 —
    // beyond the old blanket margin, inside the carve reach.
    expect(leaves.leafFor(3, 0).cached).toBe(false);
    expect(leaves.computedLeaves).toBe(1);
    // Re-touch: cached (key stable while inputs stand still).
    expect(leaves.leafFor(3, 0).cached).toBe(true);
    // Move the river far away: the leaf's key drops the river ⇒ retrace.
    leaves.setInputs([RIVER_FAR, FAR_RELIEF], "");
    expect(leaves.leafFor(3, 0).cached).toBe(false);
    expect(leaves.computedLeaves).toBe(2);
  });

  it("a leaf beyond the carve reach never keys the river (an edit there is a cache hit)", () => {
    const reach = riverCarveReach(RIVER_A, carveReachEnvelope([RIVER_A, FAR_RELIEF], {}));
    const leaves = new TerrainContourLeaves([RIVER_A, FAR_RELIEF], OPTS);
    const farTx = Math.ceil((reach + 2000) / OPTS.tileSpan); // provably beyond reach
    leaves.leafFor(farTx, 0);
    expect(leaves.computedLeaves).toBe(1);
    // Nudge the river (still far from the far tile): its key is unchanged.
    leaves.setInputs([riverAt("W", [0, -2000], [10, 2000]), FAR_RELIEF], "");
    expect(leaves.leafFor(farTx, 0).cached).toBe(true);
    expect(leaves.computedLeaves).toBe(1);
  });

  it("BED INPUT: editing a spine-adjacent relief re-keys a far leaf the river reaches", () => {
    const nearSpine = reliefAt("bed", [50, -500], [50, 500], 800, 100);
    const leaves = new TerrainContourLeaves([RIVER_A, FAR_RELIEF, nearSpine], OPTS);
    leaves.leafFor(3, 0); // in the river's reach; far outside nearSpine's own support
    expect(leaves.computedLeaves).toBe(1);
    // Raise the spine-adjacent relief: the river's bed changes ⇒ the leaf must retrace.
    const raised = reliefAt("bed", [50, -500], [50, 500], 1200, 100);
    leaves.setInputs([RIVER_A, FAR_RELIEF, raised], "");
    expect(leaves.leafFor(3, 0).cached).toBe(false);
    expect(leaves.computedLeaves).toBe(2);
  });
});

// Plan 038 item 7 — forest ↔ farmland ↔ park sketch adjacency (hashed agreement).
//
// Where two sketched polygons abut (rings within HEDGE_ADJ_EPS), a hedgerow /
// woodland-bank line runs along the shared edge. The two regions are generated
// INDEPENDENTLY, so the line must be BIT-IDENTICAL from either side (the 2×2-style
// seam contract). Pinned seeds; asserts:
//   (a) forest ↔ farmland both emit the shared-boundary line, bit-exactly equal,
//   (b) forest ↔ park and farmland ↔ park likewise,
//   (c) the lines carry the right paint tags on each side,
//   (d) NO adjacency in reach ⇒ byte-identical to the uncoupled generator (23-E),
//   (e) recomputing each region independently reproduces the identical seam.
import { describe, expect, it } from "vitest";
import { generateForest, type ForestParams } from "./forest";
import { generateFarmland, type FarmlandParams } from "./farmland";
import { generatePark, type ParkParams } from "./park";
import { makeRegion } from "./region";
import type { GenerationConstraints } from "./types";
import type { BBox } from "./spatialHash";

type Pt = [number, number];

const WORLD: BBox = { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 };

function boxRing(minX: number, minY: number, maxX: number, maxY: number): Pt[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}
function sketch(id: string, kind: string, ring: Pt[]): GeoJSON.Feature {
  return { type: "Feature", id, geometry: { type: "Polygon", coordinates: [ring] }, properties: { kind } };
}

// Three regions in a row sharing vertical edges at x = 100 and x = 200.
const FOREST_RING = boxRing(0, 0, 100, 200);
const FARM_RING = boxRing(100, 0, 200, 200);
const PARK_RING = boxRing(200, 0, 300, 200);
const FOREST = sketch("region-forest", "forest", FOREST_RING);
const FARM = sketch("region-farm", "farmland", FARM_RING);
const PARK = sketch("region-park", "park", PARK_RING);

const forestRegion = makeRegion("region-forest", FOREST_RING);
const farmRegion = makeRegion("region-farm", FARM_RING);
const parkRegion = makeRegion("region-park", PARK_RING);

const FOREST_PARAMS: ForestParams = { variety: "mixed", density: 0.6, clearings: 0.15, edgeRaggedness: 0.5 };
const FARM_PARAMS: FarmlandParams = { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.4 };
const PARK_PARAMS: ParkParams = { variety: "city-park", pathDensity: 0.5, pond: true };
const SEED = 5150;

const ALL: GeoJSON.Feature[] = [FOREST, FARM, PARK];
const C = (feats: GeoJSON.Feature[]): GenerationConstraints => ({ worldBounds: WORLD, fabricFeatures: feats as never });

function hedgeCoords(feats: GeoJSON.Feature[], pred: (p: Record<string, unknown>) => boolean): string[] {
  return feats
    .filter((f) => f.geometry.type === "LineString" && pred(f.properties as Record<string, unknown>))
    .map((f) => JSON.stringify((f.geometry as GeoJSON.LineString).coordinates));
}

describe("forest ↔ farmland ↔ park sketch adjacency (plan 038 item 7)", () => {
  const forestOut = generateForest(SEED, forestRegion, FOREST_PARAMS, C(ALL));
  const farmOut = generateFarmland(SEED, farmRegion, FARM_PARAMS, C(ALL));
  const parkOut = generatePark(SEED, parkRegion, PARK_PARAMS, C(ALL));

  it("(a,c) forest ↔ farmland derive the SAME shared-boundary line, bit-exactly", () => {
    const fHedge = hedgeCoords(forestOut, (p) => p.hedgerow === true);
    const aHedge = hedgeCoords(farmOut, (p) => p.woodlandBank === true);
    expect(fHedge.length).toBeGreaterThan(0);
    expect(aHedge.length).toBeGreaterThan(0);
    // Forest's only neighbour is farmland (x=100); farmland also neighbours park
    // (x=200), so aHedge ⊇ fHedge. Every forest hedge is bit-identical to the
    // farmland side — the hashed-agreement seam contract.
    expect(aHedge).toEqual(expect.arrayContaining(fHedge));
    expect(fHedge).toContain("[[100,200],[100,0]]"); // the exact shared x=100 seam
  });

  it("(b) farmland ↔ park derive the SAME shared-boundary line, bit-exactly", () => {
    const aHedge = hedgeCoords(farmOut, (p) => p.woodlandBank === true);
    const pHedge = hedgeCoords(parkOut, (p) => p.hedgerow === true);
    // The x=200 seam line is shared by farmland and park (both present, equal).
    const shared = aHedge.filter((c) => pHedge.includes(c));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("(b) forest ↔ park (non-adjacent, gap > 0) share NO seam line", () => {
    // forest [0..100] and park [200..300] do not touch ⇒ no forest/park hedge.
    const fHedge = hedgeCoords(forestOut, (p) => p.hedgerow === true);
    const pHedge = hedgeCoords(parkOut, (p) => p.hedgerow === true);
    // forest's only neighbour is farmland (x=100); park's is farmland (x=200):
    // no line is shared between forest and park.
    expect(fHedge.filter((c) => pHedge.includes(c)).length).toBe(0);
  });

  it("(d) no adjacency in reach ⇒ byte-identical to the uncoupled generator", () => {
    // Each generator alone (only its own sketch present) emits no hedge.
    const forestSolo = generateForest(SEED, forestRegion, FOREST_PARAMS, C([FOREST]));
    const forestBare = generateForest(SEED, forestRegion, FOREST_PARAMS, { worldBounds: WORLD });
    expect(JSON.stringify(forestSolo)).toBe(JSON.stringify(forestBare));
    const farmSolo = generateFarmland(SEED, farmRegion, FARM_PARAMS, C([FARM]));
    const farmBare = generateFarmland(SEED, farmRegion, FARM_PARAMS, { worldBounds: WORLD });
    expect(JSON.stringify(farmSolo)).toBe(JSON.stringify(farmBare));
    // A far-away neighbour (gap ≫ eps) is byte-inert too.
    const farForest = sketch("region-far", "farmland", boxRing(5000, 5000, 5100, 5100));
    expect(JSON.stringify(generateForest(SEED, forestRegion, FOREST_PARAMS, C([FOREST, farForest])))).toBe(
      JSON.stringify(forestBare)
    );
  });

  it("(e) 2×2-style: recomputing each region independently reproduces the identical seam", () => {
    const f2 = generateForest(SEED, forestRegion, FOREST_PARAMS, C(ALL));
    const a2 = generateFarmland(SEED, farmRegion, FARM_PARAMS, C(ALL));
    expect(JSON.stringify(f2)).toBe(JSON.stringify(forestOut));
    expect(JSON.stringify(a2)).toBe(JSON.stringify(farmOut));
    // The seam endpoints are bit-equal across the independent runs.
    expect(hedgeCoords(f2, (p) => p.hedgerow === true)).toEqual(hedgeCoords(forestOut, (p) => p.hedgerow === true));
  });
});

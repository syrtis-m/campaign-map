/**
 * Overlap test map — fixture contract tests. Three families:
 *  1. validity: every feature parses under the Fabric.geojson zod schema; every
 *     procgen block references a real registry algorithm at its CURRENT
 *     version, with params its own schema accepts, on a kind it applies to;
 *  2. stability: two builds are byte-identical JSON (stable ids, stable order);
 *  3. premises: each scenario's geometric claim actually holds (the river truly
 *     crosses the district, the park is strictly nested, the mountain never
 *     touches the river, …) — asserted with the repo's own sdf helpers, so a
 *     future coordinate tweak that silently breaks a scenario fails HERE, not
 *     three plans later in a coupling gate.
 *
 * All distances below are MAP UNITS (1 unit = OVERLAP_SCALE_M_PER_UNIT = 100 m).
 */
import { describe, it, expect } from "vitest";
import {
  FabricCollectionSchema,
  FabricFeatureSchema,
  isProcgenRegion,
  type FabricFeature,
} from "../../model/fabric";
import { algorithmById } from "../procgen/registry";
import {
  distanceToPolyline,
  pointInRingClosed,
  signedDistancePolygon,
} from "../fields/sdf";
import {
  buildOverlapCampaignFabric,
  buildMainDistrict,
  buildAnnexDistrict,
  buildRiver,
  buildCityWall,
  buildForest,
  buildFarmlandEast,
  buildParkInner,
  buildMountain,
  buildFarmlandUpland,
  MAIN_DISTRICT_RING,
  OVERLAP_BOUNDS,
  OVERLAP_PINS,
  OVERLAP_SCALE_M_PER_UNIT,
} from "./overlapMap";

type Pt = [number, number];

// ─── Local geometry helpers (test-only) ─────────────────────────────────────

/** Proper segment intersection (excludes collinear touching — the fixtures
 * never rely on degenerate contact). */
function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Number of ring edges a polyline properly crosses. */
function polylineRingCrossings(line: readonly Pt[], closedRing: Pt[]): number {
  let n = 0;
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < closedRing.length - 1; j++) {
      if (segmentsIntersect(line[i], line[i + 1], closedRing[j], closedRing[j + 1])) n++;
    }
  }
  return n;
}

/** True iff two closed rings' interiors are disjoint: no vertex containment in
 * either direction and no proper edge intersections. */
function ringsDisjoint(a: Pt[], b: Pt[]): boolean {
  for (const p of a) if (pointInRingClosed(b, p[0], p[1])) return false;
  for (const p of b) if (pointInRingClosed(a, p[0], p[1])) return false;
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return false;
  return true;
}

function closedRingOf(f: FabricFeature): Pt[] {
  expect(f.geometry.type).toBe("Polygon");
  return (f.geometry as { coordinates: Pt[][] }).coordinates[0];
}

function lineOf(f: FabricFeature): Pt[] {
  expect(f.geometry.type).toBe("LineString");
  return (f.geometry as { coordinates: Pt[] }).coordinates;
}

/** The (closed) ring edge from `p` to `q` exists in `ring` (either direction),
 * with endpoints matching within `eps`. */
function ringHasEdge(ring: Pt[], p: Pt, q: Pt, eps: number): boolean {
  const near = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if ((near(a, p) && near(b, q)) || (near(a, q) && near(b, p))) return true;
  }
  return false;
}

const fabric = buildOverlapCampaignFabric();
const byId = new Map(fabric.features.map((f) => [f.id, f]));
const district = closedRingOf(byId.get("overlap-district-main")!);
const annex = closedRingOf(byId.get("overlap-district-annex")!);
const forest = closedRingOf(byId.get("overlap-forest")!);
const farmlandEast = closedRingOf(byId.get("overlap-farmland-east")!);
const farmlandUpland = closedRingOf(byId.get("overlap-farmland-upland")!);
const park = closedRingOf(byId.get("overlap-park")!);
const mountain = closedRingOf(byId.get("overlap-mountain")!);
const river = lineOf(byId.get("overlap-river")!);
const wall = lineOf(byId.get("overlap-wall")!);

describe("overlapMap — validity", () => {
  it("the whole collection parses under the Fabric.geojson schema", () => {
    expect(() => FabricCollectionSchema.parse(fabric)).not.toThrow();
  });

  it("every feature parses individually and stays inside the campaign bounds", () => {
    const [minX, minY, maxX, maxY] = OVERLAP_BOUNDS;
    for (const f of fabric.features) {
      expect(() => FabricFeatureSchema.parse(f)).not.toThrow();
      const coords: Pt[] = f.geometry.type === "Polygon" ? (f.geometry.coordinates[0] as Pt[]) : (f.geometry.coordinates as Pt[]);
      for (const [x, y] of coords) {
        expect(x, `${f.id} x`).toBeGreaterThanOrEqual(minX);
        expect(x, `${f.id} x`).toBeLessThanOrEqual(maxX);
        expect(y, `${f.id} y`).toBeGreaterThanOrEqual(minY);
        expect(y, `${f.id} y`).toBeLessThanOrEqual(maxY);
      }
    }
  });

  it("every feature is a procgen region with a registry-valid block at the algorithm's currentVersion", () => {
    for (const f of fabric.features) {
      expect(isProcgenRegion(f), `${f.id} must carry a procgen block`).toBe(true);
      const block = f.properties.procgen!;
      const alg = algorithmById(block.algorithm);
      expect(alg, `${f.id}: unknown algorithm ${block.algorithm}`).toBeDefined();
      expect(alg!.appliesTo, `${f.id}: ${block.algorithm} does not apply to ${f.properties.kind}`).toContain(
        f.properties.kind
      );
      expect(block.version, `${f.id}: version must pin ${block.algorithm}'s currentVersion`).toBe(
        alg!.currentVersion
      );
      expect(() => alg!.paramsSchema.parse(block.params), `${f.id}: params rejected`).not.toThrow();
      expect(Number.isInteger(block.seed), `${f.id}: seed must be an integer literal`).toBe(true);
      if (block.presetId !== undefined) {
        expect(
          alg!.presets.some((p) => p.id === block.presetId),
          `${f.id}: presetId ${block.presetId} is not a preset of ${block.algorithm}`
        ).toBe(true);
      }
    }
  });

  it("every polygon ring is closed; the wall polyline is a closed loop", () => {
    for (const f of fabric.features) {
      if (f.geometry.type !== "Polygon") continue;
      const ring = f.geometry.coordinates[0] as Pt[];
      expect(ring[0], `${f.id} ring closure`).toEqual(ring[ring.length - 1]);
    }
    expect(wall[0]).toEqual(wall[wall.length - 1]);
  });
});

describe("overlapMap — stability", () => {
  it("two builds are byte-identical JSON (stable ids, order, seeds, versions)", () => {
    expect(JSON.stringify(buildOverlapCampaignFabric())).toBe(JSON.stringify(fabric));
  });

  it("individual builders are deterministic too", () => {
    const builders = [
      buildMainDistrict,
      buildAnnexDistrict,
      buildRiver,
      buildCityWall,
      buildForest,
      buildFarmlandEast,
      buildParkInner,
      buildMountain,
      buildFarmlandUpland,
    ];
    for (const b of builders) expect(JSON.stringify(b())).toBe(JSON.stringify(b()));
  });

  it("feature ids are unique", () => {
    expect(byId.size).toBe(fabric.features.length);
  });
});

describe("overlapMap — scenario premises", () => {
  it("S1: the river crosses straight through the main district (enters and exits; interior spine vertices)", () => {
    expect(polylineRingCrossings(river, district)).toBe(2);
    const inside = river.filter(([x, y]) => pointInRingClosed(district, x, y));
    expect(inside.length).toBeGreaterThanOrEqual(2);
  });

  it("S2: the wall is a closed ring tracing the district boundary exactly", () => {
    // Same vertex count (plus closure) and every wall vertex ON the district ring.
    expect(wall.length).toBe(MAIN_DISTRICT_RING.length + 1);
    for (const [i, v] of wall.entries()) {
      const expected = district[i % (district.length - 1)];
      expect(v, `wall vertex ${i}`).toEqual(expected);
    }
  });

  it("S3: the forest overlaps the river's upstream reach, and touches neither district", () => {
    const inForest = river.filter(([x, y]) => pointInRingClosed(forest, x, y));
    expect(inForest.length).toBeGreaterThanOrEqual(2);
    expect(polylineRingCrossings(river, forest)).toBe(2);
    expect(ringsDisjoint(forest, district)).toBe(true);
    expect(ringsDisjoint(forest, annex)).toBe(true);
  });

  it("S4: farmland shares the district's full east edge (≥500 m) AND the river crosses it downstream", () => {
    // Shared edge: (3,-2.5) → (3,2.5) exists verbatim in BOTH rings (ε = 0
    // sharing: identical endpoints — the durable geometry plan 038 hashes).
    const p: Pt = [3, -2.5];
    const q: Pt = [3, 2.5];
    expect(ringHasEdge(district, p, q, 0)).toBe(true);
    expect(ringHasEdge(farmlandEast, p, q, 0)).toBe(true);
    const edgeMeters = Math.hypot(q[0] - p[0], q[1] - p[1]) * OVERLAP_SCALE_M_PER_UNIT;
    expect(edgeMeters).toBeGreaterThanOrEqual(500);

    // Downstream overlap: interior spine vertices, all AFTER the district reach.
    const inFarm = river.map(([x, y], i) => (pointInRingClosed(farmlandEast, x, y) ? i : -1)).filter((i) => i >= 0);
    expect(inFarm.length).toBeGreaterThanOrEqual(2);
    const lastInDistrict = river.reduce((acc, [x, y], i) => (pointInRingClosed(district, x, y) ? i : acc), -1);
    expect(lastInDistrict).toBeGreaterThanOrEqual(0);
    expect(Math.min(...inFarm)).toBeGreaterThan(lastInDistrict);
  });

  it("S5: the park is strictly nested inside the district (≥30 m margin) and untouched by the river", () => {
    for (const [x, y] of park) {
      const margin = signedDistancePolygon(district, x, y) * OVERLAP_SCALE_M_PER_UNIT;
      expect(margin, `park vertex (${x},${y}) margin`).toBeGreaterThanOrEqual(30);
    }
    expect(polylineRingCrossings(river, park)).toBe(0);
    for (const [x, y] of river) expect(pointInRingClosed(park, x, y)).toBe(false);
  });

  it("S6: the annex district shares the main district's full south edge (ε = 0)", () => {
    const p: Pt = [-3, -2.5];
    const q: Pt = [3, -2.5];
    expect(ringHasEdge(district, p, q, 0)).toBe(true);
    expect(ringHasEdge(annex, p, q, 0)).toBe(true);
    // Interiors stay disjoint: adjacency only, never overlap. No proper edge
    // crossings, and no annex vertex STRICTLY inside the district (the two
    // shared vertices sit exactly ON the boundary — signed distance 0).
    expect(polylineRingCrossings(annex, district)).toBe(0);
    for (const [x, y] of annex.slice(0, -1)) {
      expect(signedDistancePolygon(district, x, y), `annex vertex (${x},${y})`).toBeLessThanOrEqual(1e-9);
    }
  });

  it("S7: the mountain is NEAR the river (50–500 m, never touching) and overlaps the upland farmland", () => {
    // Never touching: no crossings, no containment either way.
    expect(polylineRingCrossings(river, mountain)).toBe(0);
    for (const [x, y] of river) expect(pointInRingClosed(mountain, x, y)).toBe(false);
    // Near: min vertex→spine distance within a hillside's reach.
    const dUnits = Math.min(...mountain.map(([x, y]) => distanceToPolyline(river as Pt[], x, y)));
    const dMeters = dUnits * OVERLAP_SCALE_M_PER_UNIT;
    expect(dMeters).toBeGreaterThanOrEqual(50);
    expect(dMeters).toBeLessThanOrEqual(500);
    // Overlapping the upland farmland: at least one farmland vertex inside the
    // mountain, and a genuine boundary crossing (partial overlap, not nesting).
    const inMountain = farmlandUpland.slice(0, -1).filter(([x, y]) => pointInRingClosed(mountain, x, y));
    expect(inMountain.length).toBeGreaterThanOrEqual(1);
    expect(inMountain.length).toBeLessThan(farmlandUpland.length - 1);
    // And the upland farmland never touches river or forest (terrain→farmland
    // is the ONLY coupling in this scenario).
    expect(polylineRingCrossings(river, farmlandUpland)).toBe(0);
    for (const [x, y] of river) expect(pointInRingClosed(farmlandUpland, x, y)).toBe(false);
    expect(ringsDisjoint(farmlandUpland, forest)).toBe(true);
  });

  it("S8: the market pin sits strictly inside the main district, outside the park", () => {
    const market = OVERLAP_PINS.find((p) => p.type === "market");
    expect(market).toBeDefined();
    expect(pointInRingClosed(district, market!.point[0], market!.point[1])).toBe(true);
    expect(pointInRingClosed(park, market!.point[0], market!.point[1])).toBe(false);
  });

  it("S8: boundary pins sit within 30 m of their coupling boundary; all pins in bounds", () => {
    const [minX, minY, maxX, maxY] = OVERLAP_BOUNDS;
    const nearM = (d: number): number => d * OVERLAP_SCALE_M_PER_UNIT;
    for (const pin of OVERLAP_PINS) {
      expect(pin.point[0]).toBeGreaterThanOrEqual(minX);
      expect(pin.point[0]).toBeLessThanOrEqual(maxX);
      expect(pin.point[1]).toBeGreaterThanOrEqual(minY);
      expect(pin.point[1]).toBeLessThanOrEqual(maxY);
    }
    const quay = OVERLAP_PINS.find((p) => p.name === "Old Quay")!;
    expect(nearM(Math.abs(quay.point[0] - 3))).toBeLessThanOrEqual(30); // shared east edge x = 3
    const shrine = OVERLAP_PINS.find((p) => p.name === "Southgate Shrine")!;
    expect(nearM(Math.abs(shrine.point[1] - -2.5))).toBeLessThanOrEqual(30); // shared south edge y = -2.5
    const stone = OVERLAP_PINS.find((p) => p.name === "Fernside Stone")!;
    expect(pointInRingClosed(forest, stone.point[0], stone.point[1])).toBe(true);
    expect(nearM(distanceToPolyline(river as Pt[], stone.point[0], stone.point[1]))).toBeLessThanOrEqual(120);
  });

  it("premise hygiene: regions that no scenario couples stay disjoint", () => {
    // The matrix is exact: any accidental extra overlap would contaminate a
    // coupling gate's blame assignment.
    expect(ringsDisjoint(park, annex)).toBe(true);
    expect(ringsDisjoint(park, farmlandEast)).toBe(true);
    expect(ringsDisjoint(mountain, forest)).toBe(true);
    expect(ringsDisjoint(mountain, district)).toBe(true);
    expect(ringsDisjoint(farmlandUpland, district)).toBe(true);
    expect(ringsDisjoint(farmlandEast, forest)).toBe(true);
    expect(ringsDisjoint(farmlandEast, farmlandUpland)).toBe(true);
  });
});

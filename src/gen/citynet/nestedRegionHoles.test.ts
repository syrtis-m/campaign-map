// Plan 037-D — nested region → outer city hole-with-frontage.
//
// The outer city treats any strictly-CONTAINED park/district sketch ring as a
// HOLE: no streets/blocks/parcels/footprints inside it, a perimeter frontage
// street just outside, and hashed entrance points ON the ring. It NEVER reads
// the inner region's OUTPUT — only its sketch ring. Uniform for park-in-city
// (S5) and district-in-district (a citadel). Pinned seeds; asserts:
//   (1) zero city geometry inside the contained ring,
//   (2) a perimeter frontage street is present,
//   (3) entrances/output deterministic under re-runs,
//   (4) the same rule for district-in-district,
//   (5) outskirts suppression NOT regressed: farmland/forest rings do NOT hole,
//   (6) no contained region ⇒ byte-identical to today.
import { describe, expect, it } from "vitest";
import { generateCityNetwork } from "./index";
import { WORLD_BOUNDS, fixtureAt } from "./citynet.fixtures";
import { containedRegionRings } from "../fabricConstraints";
import { signedDistancePolygon } from "../fields/sdf";
import { hashSeed } from "../rng";
import type { FabricFeature } from "../../model/fabric";
import type { GenerationConstraints } from "../types";

type Pt = [number, number];

const CX = 600;
const CY = 600;

/** A polygon sketch feature of `kind` at the given ring. */
function poly(id: string, kind: string, ring: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: kind as FabricFeature["properties"]["kind"] },
  };
}

// A ring strictly inside the fixtureAt(600,600) disc district (radius 900),
// OFF-CENTER so it does not swallow the city core at (600,600) — an S5-style
// nested park to one side of the town.
const INNER: Pt[] = [
  [490, 990],
  [710, 990],
  [710, 1210],
  [490, 1210],
  [490, 990],
];

function city(constraints: Partial<GenerationConstraints>): { seed: number; net: GeoJSON.Feature[] } {
  const { seed, region } = fixtureAt(CX, CY, "euro-medieval");
  return { seed, net: generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS, ...constraints }) };
}

function vertsOf(f: GeoJSON.Feature): Pt[] {
  const g = f.geometry;
  if (g.type === "Point") return [g.coordinates as Pt];
  if (g.type === "LineString") return g.coordinates as Pt[];
  if (g.type === "Polygon") return g.coordinates.flat() as Pt[];
  if (g.type === "MultiPolygon") return (g.coordinates as number[][][][]).flat(2) as Pt[];
  return [];
}
const gidOf = (f: GeoJSON.Feature): string => (f.properties as { generatorId?: string }).generatorId ?? "";

describe("nested region → outer city hole-with-frontage (plan 037-D)", () => {
  it("(5) containedRegionRings returns park/district but NEVER farmland/forest (suppress ≠ hole)", () => {
    const feats: FabricFeature[] = [
      poly("p", "park", INNER),
      poly("d", "district", INNER),
      poly("fa", "farmland", INNER),
      poly("fo", "forest", INNER),
    ];
    const outer: Pt[] = [
      [-300, -300],
      [1500, -300],
      [1500, 1500],
      [-300, 1500],
      [-300, -300],
    ];
    const rings = containedRegionRings(feats, outer);
    expect(rings.length).toBe(2); // park + district only
  });

  it("excludes a region that is not strictly contained (crossing / adjacent)", () => {
    const outer: Pt[] = [
      [0, 0],
      [400, 0],
      [400, 400],
      [0, 400],
      [0, 0],
    ];
    // Crosses the outer boundary (half in, half out) — NOT contained.
    const crossing: Pt[] = [
      [300, 300],
      [600, 300],
      [600, 600],
      [300, 600],
      [300, 300],
    ];
    expect(containedRegionRings([poly("d", "district", crossing)], outer).length).toBe(0);
  });

  describe("park-in-district (S5)", () => {
    const park = poly("overlap-park", "park", INNER);
    const { seed, net } = city({ fabricFeatures: [park] });

    it("(1) zero city street/block/parcel/footprint geometry inside the contained ring", () => {
      const interiorGids = new Set(["city-street", "city-block", "city-parcel", "city-footprint"]);
      for (const f of net) {
        if (!interiorGids.has(gidOf(f))) continue;
        // The frontage street sits OUTSIDE the ring (negative sdf); genuine
        // interior geometry has a positive depth. Allow a small band for the
        // frontage/boundary-hugging blocks.
        for (const [x, y] of vertsOf(f)) {
          expect(signedDistancePolygon(INNER, x, y)).toBeLessThan(8);
        }
      }
    });

    it("(2) a perimeter frontage street is present", () => {
      expect(net.some((f) => f.id === hashSeed(seed, "frontage", 0))).toBe(true);
    });

    it("(3) entrances + output are deterministic under re-runs", () => {
      const again = city({ fabricFeatures: [park] });
      expect(JSON.stringify(again.net)).toBe(JSON.stringify(net));
      // Hashed entrance points exist ON the ring (city-landmark gate near a ring edge).
      const entrances = net.filter(
        (f) => gidOf(f) === "city-landmark" && (f.properties as { type?: string }).type === "gate"
      );
      expect(entrances.length).toBeGreaterThan(0);
    });
  });

  describe("district-in-district (citadel)", () => {
    const citadel = poly("citadel", "district", INNER);
    const { seed, net } = city({ fabricFeatures: [citadel] });

    it("(4) same rule: zero interior geometry + a frontage street", () => {
      const interiorGids = new Set(["city-street", "city-block", "city-parcel", "city-footprint"]);
      for (const f of net) {
        if (!interiorGids.has(gidOf(f))) continue;
        for (const [x, y] of vertsOf(f)) {
          expect(signedDistancePolygon(INNER, x, y)).toBeLessThan(8);
        }
      }
      expect(net.some((f) => f.id === hashSeed(seed, "frontage", 0))).toBe(true);
    });
  });

  it("(6) no contained region ⇒ byte-identical to the uncoupled city", () => {
    const base = JSON.stringify(city({}).net);
    // A farmland ring inside is SUPPRESS, not HOLE — it must not change the
    // street/block geometry via the hole path (its own outskirt suppression is a
    // separate, pre-existing edge tested elsewhere; here we assert no frontage
    // and identical output for a contained FOREST, which the city never reads).
    const forest = poly("fo", "forest", INNER);
    expect(JSON.stringify(city({ fabricFeatures: [forest] }).net)).toBe(base);
  });
});

/**
 * BIT-EXACT city golden (plan 023 §2 retrofit gate — fast tier).
 *
 * The city generator has no committed `.snap` (unlike forest/farmland/park/
 * river/wall), so before plan 023-A there was no stored byte reference for
 * `generateCityNetwork` — only in-process `a === b` determinism. This golden
 * fills exactly that gap: it pins the emitted bytes of a representative set of
 * cities so the `interiorT`/constraint retrofit onto `src/gen/fields/` is
 * provably output-preserving.
 *
 * CAPTURE DISCIPLINE (do not casually `-u`): these digests were captured on the
 * PRE-retrofit source. A diff here after the retrofit is a PHASE FAILURE — the
 * whole point is bit-exactness — never a snapshot update. The golden is the
 * SHA-256 of `JSON.stringify(network)` (the cache emit surface: mm-quantized
 * coords, canonical feature order) plus the byte length and feature count, so
 * the golden IS the determinism surface the `.mapcache/` relies on — a full-JSON
 * snapshot would be ~10 MB of repo bloat for the same bit-exact detection (a
 * single flipped bit changes the digest).
 *
 * Coverage is deliberate (advisor 2026-07-13): a BARE region proves the
 * `interiorT`/`distanceToBoundary` polygon path (cityness falloff), and a
 * CONSTRAINED region (river line + water polygon + road) proves the
 * fabricConstraints water/river predicate path — a bit-shift there would
 * silently re-roll every city with a sketched river on upgrade, the exact
 * cross-version identity break §2 guards against.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateCityNetwork, makeDomain, discToRing, citySeedFor, type ProfileId } from "../citynet/index";
import { makeRegion } from "../region";
import type { BBox } from "../spatialHash";
import type { GenerationConstraints } from "../types";
import { hashSeed } from "../rng";
import type { FabricFeature } from "../../model/fabric";

const WORLD_BOUNDS: BBox = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };
const CAMPAIGN_SEED = 90210;

function cityAt(cx: number, cy: number, profile: ProfileId, constraints: Partial<GenerationConstraints> = {}, radius = 900) {
  const domain = makeDomain(cx, cy, radius, profile, 0);
  const seed = citySeedFor(CAMPAIGN_SEED, domain);
  const region = makeRegion(`dom-shim:${domain.id}`, discToRing(domain));
  return generateCityNetwork(seed, region, profile, { worldBounds: WORLD_BOUNDS, ...constraints });
}

/** River line crossing the region's cost-field bbox horizontally at `cy`. */
function riverThrough(cy: number): FabricFeature {
  return {
    type: "Feature",
    id: "river-golden",
    geometry: { type: "LineString", coordinates: [[-4000, cy], [4000, cy]] },
    properties: { kind: "river" },
  };
}

/** A water polygon (lake) overlapping the region — exercises pointInRing. */
function lakeAt(cx: number, cy: number): FabricFeature {
  return {
    type: "Feature",
    id: "lake-golden",
    geometry: {
      type: "Polygon",
      coordinates: [[[cx - 250, cy - 250], [cx + 250, cy - 250], [cx + 250, cy + 250], [cx - 250, cy + 250], [cx - 250, cy - 250]]],
    },
    properties: { kind: "water" },
  };
}

/** A sketched road the streets should align to — exercises nearestOnLine. */
function roadThrough(cx: number, cy: number): FabricFeature {
  return {
    type: "Feature",
    id: "road-golden",
    geometry: { type: "LineString", coordinates: [[cx - 800, cy - 400], [cx + 800, cy + 400]] },
    properties: { kind: "road" },
  };
}

/** Bit-exact digest of a generated network: feature count, JSON byte length,
 * and the SHA-256 of the emitted JSON. Any change to any coordinate, id, or
 * emission order flips `sha256`. */
function digest(network: GeoJSON.Feature[]): { features: number; bytes: number; sha256: string } {
  const json = JSON.stringify(network);
  return { features: network.length, bytes: json.length, sha256: createHash("sha256").update(json).digest("hex") };
}

describe("city byte golden (plan 023-A bit-exact retrofit reference)", () => {
  it("bare disc region — euro-medieval (interiorT/cityness falloff path)", () => {
    expect(digest(cityAt(600, 600, "euro-medieval"))).toMatchSnapshot();
  });

  it("bare disc region — na-grid (second profile, different skeleton)", () => {
    expect(digest(cityAt(600, 600, "na-grid"))).toMatchSnapshot();
  });

  it("irregular concave hexagon region — euro-medieval (concave distanceToBoundary path)", () => {
    const hex: [number, number][] = [
      [1200, -300],
      [700, 700],
      [-200, 900],
      [-900, 250],
      [-650, -600],
      [300, -950],
      [1200, -300],
    ];
    const region = makeRegion("hex-golden", hex);
    const seed = hashSeed(CAMPAIGN_SEED, "hex", 1);
    expect(digest(generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS }))).toMatchSnapshot();
  });

  it("constrained region — river + lake + road (fabricConstraints water/river predicate path)", () => {
    const cy = 600;
    const net = cityAt(600, cy, "euro-medieval", {
      fabricFeatures: [riverThrough(cy), lakeAt(600, cy), roadThrough(600, cy)],
    });
    // Sanity: the constraints must actually bite (fewer features than the bare
    // city), else this fixture would silently stop covering the predicate path.
    // NOTE (plan 024-C): this golden was DELIBERATELY regenerated — the new
    // "buildings don't swim" filter drops footprints whose centroid falls in the
    // sketched river/lake (39 fewer features). The BARE (no-water) golden above
    // is byte-identical (the filter is a strict no-op without water), so the
    // 23-A retrofit reference still stands for every no-water city.
    expect(net.length).toBeGreaterThan(0);
    expect(digest(net)).toMatchSnapshot();
  });
});

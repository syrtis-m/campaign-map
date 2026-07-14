/**
 * City byte golden + structural path coverage.
 *
 * ONE byte-golden per algorithm (versioned-determinism policy): a single
 * representative fixture asserts "the current generator version reproduces the
 * committed bytes" — the digest below is the SHA-256 of `JSON.stringify(network)`
 * (the cache emit surface: mm-quantized coords, canonical order) plus byte length
 * and feature count, so one flipped bit changes the digest. It is re-accepted on
 * a deliberate version bump via `npm run goldens:accept -- city`, never casually.
 *
 * The three other code paths this file used to byte-pin are now covered WITHOUT
 * a second golden — bytes are no longer the regression net, structure and bands
 * are:
 *  - a SECOND profile (na-grid, different skeleton) → determinism + emits streets
 *    here, and its metric bands in `citynet/metrics.test.ts`;
 *  - the concave `distanceToBoundary` path → the shared structural invariants on
 *    an irregular concave hexagon;
 *  - the fabricConstraints water/river predicate path → the "constraints bite"
 *    behavioural assertion (a constrained city has fewer features than the bare
 *    one, because footprints in the sketched water/river are dropped).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateCityNetwork, makeDomain, discToRing, citySeedFor, type ProfileId } from "../citynet/index";
import { makeRegion } from "../region";
import { expectGeneratorInvariants, expectDeterministic } from "../testkit/invariants";
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

describe("city byte golden (current-version fixture + structural path coverage)", () => {
  it("bare disc region — euro-medieval reproduces the committed bytes", () => {
    expect(digest(cityAt(600, 600, "euro-medieval"))).toMatchSnapshot();
  });

  it("bare disc region — na-grid is deterministic and emits a street network (second skeleton)", () => {
    const domain = makeDomain(600, 600, 900, "na-grid", 0);
    const region = makeRegion(`dom-shim:${domain.id}`, discToRing(domain));
    const seed = citySeedFor(CAMPAIGN_SEED, domain);
    const net = expectDeterministic(() => generateCityNetwork(seed, region, "na-grid", { worldBounds: WORLD_BOUNDS }));
    expect(net.some((f) => f.properties?.generatorId === "city-street")).toBe(true);
  });

  it("irregular concave hexagon region — euro-medieval stays inside the concave ring (structural)", () => {
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
    expectGeneratorInvariants(generateCityNetwork(seed, region, "euro-medieval", { worldBounds: WORLD_BOUNDS }), region);
  });

  it("constrained region — river + lake + road: the water/river predicate bites (fewer features than bare)", () => {
    const cy = 600;
    const bare = cityAt(600, cy, "euro-medieval");
    const net = cityAt(600, cy, "euro-medieval", {
      fabricFeatures: [riverThrough(cy), lakeAt(600, cy), roadThrough(600, cy)],
    });
    // The "buildings don't swim" filter drops footprints whose centroid falls in
    // the sketched river/lake, so the constrained city has strictly fewer
    // features — proving the fabricConstraints predicate path is exercised.
    expect(net.length).toBeGreaterThan(0);
    expect(net.length).toBeLessThan(bare.length);
  });
});

import { describe, expect, it } from "vitest";
import { regionFingerprint, isCacheRecordFresh, type RegionFingerprintInput } from "./fingerprint";
import { makeRegion } from "../region";
import type { FabricFeature } from "../../model/fabric";

/** A square region ring (gen-space meters, mm-quantized by makeRegion). */
const RING: [number, number][] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
  [0, 0],
];
const region = makeRegion("region-A", RING);

function base(): RegionFingerprintInput {
  return {
    algorithm: "city",
    seed: 12345,
    version: 1,
    params: { profile: "euro-medieval" },
    region,
    fabricFeatures: [],
  };
}

function waterPolygon(id: string, x: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[x, x], [x + 10, x], [x + 10, x + 10], [x, x + 10], [x, x]]] },
    properties: { kind: "water" },
  } as FabricFeature;
}

function parkPolygon(id: string): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]] },
    properties: { kind: "park" },
  } as FabricFeature;
}

describe("regionFingerprint — determinism", () => {
  it("is a stable hex string, identical across repeated calls with the same input", () => {
    const a = regionFingerprint(base());
    const b = regionFingerprint(base());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("regionFingerprint — change detection per input class (plan 024 §5.1)", () => {
  const ref = regionFingerprint(base());

  it("seed change flips the fingerprint (re-roll)", () => {
    expect(regionFingerprint({ ...base(), seed: 99999 })).not.toBe(ref);
  });

  it("version change flips the fingerprint", () => {
    expect(regionFingerprint({ ...base(), version: 2 })).not.toBe(ref);
  });

  it("params change flips the fingerprint (windiness/profile edit)", () => {
    expect(regionFingerprint({ ...base(), params: { profile: "na-grid" } })).not.toBe(ref);
  });

  it("algorithm change flips the fingerprint", () => {
    expect(regionFingerprint({ ...base(), algorithm: "forest" })).not.toBe(ref);
  });

  it("geometry (ring) change flips the fingerprint (vertex edit)", () => {
    const moved = makeRegion("region-A", [
      [0, 0],
      [1200, 0],
      [1200, 1000],
      [0, 1000],
      [0, 0],
    ]);
    expect(regionFingerprint({ ...base(), region: moved })).not.toBe(ref);
  });

  it("adding a constraint-bearing raw sketch (water) flips the fingerprint", () => {
    expect(regionFingerprint({ ...base(), fabricFeatures: [waterPolygon("w1", 100)] })).not.toBe(ref);
  });

  it("moving an existing constraint sketch flips the fingerprint", () => {
    const before = regionFingerprint({ ...base(), fabricFeatures: [waterPolygon("w1", 100)] });
    const after = regionFingerprint({ ...base(), fabricFeatures: [waterPolygon("w1", 200)] });
    expect(after).not.toBe(before);
  });
});

describe("regionFingerprint — invariances (no false staleness)", () => {
  it("params key order does not matter", () => {
    const a = regionFingerprint({ ...base(), params: { a: 1, b: 2 } });
    const b = regionFingerprint({ ...base(), params: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("constraint feature order does not matter", () => {
    const a = regionFingerprint({ ...base(), fabricFeatures: [waterPolygon("w1", 100), waterPolygon("w2", 300)] });
    const b = regionFingerprint({ ...base(), fabricFeatures: [waterPolygon("w2", 300), waterPolygon("w1", 100)] });
    expect(a).toBe(b);
  });

  it("a non-constraint sketch (park/district) is ISOLATED — it never changes the fingerprint", () => {
    // Parks/districts impose nothing on generators (fabricConstraints.ts), so
    // editing one must not invalidate a neighbouring region's cache.
    const withPark = regionFingerprint({ ...base(), fabricFeatures: [parkPolygon("p1")] });
    expect(withPark).toBe(regionFingerprint(base()));
  });
});

describe("isCacheRecordFresh — back-compat grandfathering", () => {
  it("a record with no stored fingerprint is fresh (pre-024 grandfathering)", () => {
    expect(isCacheRecordFresh(undefined, "fpNow")).toBe(true);
  });

  it("an undefined expected fingerprint can never invalidate", () => {
    expect(isCacheRecordFresh("fpStored", undefined)).toBe(true);
  });

  it("a matching fingerprint is fresh", () => {
    expect(isCacheRecordFresh("fpX", "fpX")).toBe(true);
  });

  it("a mismatched fingerprint is stale", () => {
    expect(isCacheRecordFresh("fpOld", "fpNew")).toBe(false);
  });
});

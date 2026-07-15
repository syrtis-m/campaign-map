import { describe, expect, it } from "vitest";
import {
  regionFingerprint,
  isCacheRecordFresh,
  hashByteBudget,
  resetHashByteBudget,
  type RegionFingerprintInput,
} from "./fingerprint";
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

describe("regionFingerprint — change detection per input class", () => {
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

describe("regionFingerprint — upstream artifact fingerprints", () => {
  const ref = regionFingerprint(base());

  it("BACK-COMPAT: no upstream ⇒ the same fingerprint as a no-upstream composition (no version bump, no storm)", () => {
    // A region with no cross-region dependency hashes as if upstream were absent
    // — opening such a campaign triggers NO recompute. Empty AND absent both
    // collapse to the no-upstream string.
    expect(regionFingerprint({ ...base(), upstreamFingerprints: [] })).toBe(ref);
    expect(regionFingerprint({ ...base(), upstreamFingerprints: undefined })).toBe(ref);
  });

  it("gaining an upstream flips the fingerprint (the new coupling is real)", () => {
    expect(regionFingerprint({ ...base(), upstreamFingerprints: ["deadbeef"] })).not.toBe(ref);
  });

  it("a CHANGED upstream fingerprint flips it (an upstream edit invalidates the downstream)", () => {
    const before = regionFingerprint({ ...base(), upstreamFingerprints: ["aaaa"] });
    const after = regionFingerprint({ ...base(), upstreamFingerprints: ["bbbb"] });
    expect(after).not.toBe(before);
  });

  it("is invariant to upstream fingerprint order (defensive sort)", () => {
    const a = regionFingerprint({ ...base(), upstreamFingerprints: ["a1", "b2"] });
    const b = regionFingerprint({ ...base(), upstreamFingerprints: ["b2", "a1"] });
    expect(a).toBe(b);
  });

  it("adding a second upstream flips it (a new dependency joined)", () => {
    const one = regionFingerprint({ ...base(), upstreamFingerprints: ["a1"] });
    const two = regionFingerprint({ ...base(), upstreamFingerprints: ["a1", "a2"] });
    expect(two).not.toBe(one);
  });
});

describe("hasher (plan 033-B) — two-lane 32-bit, budget counter", () => {
  it("emits the same 16-hex width as the old FNV-64 output", () => {
    expect(regionFingerprint(base())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("byte budget scales with the hashed ring — a big ring hashes O(vertices) more bytes", () => {
    // The budget counter is the perf surface: a fingerprint pass hashes the
    // whole quantized ring, so a 10k-vertex ring costs ~O(vertices) bytes. We
    // assert the counter tracks that WORK (bytes/pass) rather than wall-clock,
    // per docs/06 (throttled numbers only) — the hasher swap keeps this budget
    // identical while dropping the per-byte BigInt multiply.
    const smallRing: [number, number][] = [
      [0, 0],
      [1000, 0],
      [1000, 1000],
      [0, 1000],
      [0, 0],
    ];
    // A 10k-vertex ring. Built by OVERRIDING `ring` on a small base region so
    // `makeRegion`'s O(bbox-area) interior-distance lattice scan never runs on
    // it — `regionFingerprint` reads only `region.ring`/`region.spine`, so this
    // exercises the hash budget without paying the region constructor's cost.
    const bigRing: [number, number][] = [];
    for (let i = 0; i <= 10000; i++) {
      const a = (i / 10000) * Math.PI * 2;
      bigRing.push([Math.round(Math.cos(a) * 5000), Math.round(Math.sin(a) * 5000)]);
    }
    const smallRegion = makeRegion("small", smallRing);
    const bigRegion = { ...smallRegion, ring: bigRing };

    resetHashByteBudget();
    regionFingerprint({ ...base(), region: smallRegion });
    const smallBytes = hashByteBudget();

    resetHashByteBudget();
    regionFingerprint({ ...base(), region: bigRegion });
    const bigBytes = hashByteBudget();

    // Every pass hashes at least its own concatenated field string.
    expect(smallBytes).toBeGreaterThan(0);
    // A 10k-vertex ring dominates the budget — tens of KB more than the tiny one.
    expect(bigBytes).toBeGreaterThan(smallBytes + 50_000);
  });

  it("resetHashByteBudget zeroes the counter", () => {
    regionFingerprint(base());
    resetHashByteBudget();
    expect(hashByteBudget()).toBe(0);
  });
});

describe("isCacheRecordFresh — back-compat grandfathering", () => {
  it("a record with no stored fingerprint is fresh (grandfathering)", () => {
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

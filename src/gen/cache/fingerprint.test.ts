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

  it("a park/district sketch flips the fingerprint ONLY when the algorithm consumes it (plan 037 item 5)", () => {
    // Pre-037 a park/district imposed nothing. Since plan 037 item 5 the CITY
    // consumes a strictly-contained park/district as a HOLE, so its ring must
    // flip the city's fingerprint when scoped in (kind ∈ consumesSketch ∧ within
    // margin) — else a contained region's move would silently serve stale bytes.
    const cityScope = {
      consumesSketch: ["water", "river", "road", "wall", "farmland", "park", "district"] as const,
      influenceMargin: 1500,
    };
    const withPark = regionFingerprint({ ...base(), ...cityScope, fabricFeatures: [parkPolygon("p1")] });
    expect(withPark).not.toBe(regionFingerprint({ ...base(), ...cityScope }));
    // A region that consumes NOTHING (forest/mountain) stays ISOLATED from a park.
    const inert = { consumesSketch: [] as const, influenceMargin: 0 };
    expect(regionFingerprint({ ...base(), ...inert, fabricFeatures: [parkPolygon("p1")] })).toBe(
      regionFingerprint({ ...base(), ...inert })
    );
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

function roadLine(id: string, x: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[x, 0], [x, 100]] },
    properties: { kind: "road" },
  } as FabricFeature;
}

describe("regionFingerprint — scoped constraints (plan 033-D)", () => {
  // base() is `city`; scope it to a consumed kind (water) with a tight margin.
  function scopedBase(): RegionFingerprintInput {
    return { ...base(), consumesSketch: ["water"], influenceMargin: 50 };
  }
  const ref = regionFingerprint(scopedBase());

  it("a consumed kind INSIDE the influence bbox flips the fingerprint", () => {
    // Water at (100,100), region ring 0..1000 ⇒ inside ⇒ within margin.
    expect(regionFingerprint({ ...scopedBase(), fabricFeatures: [waterPolygon("w1", 100)] })).not.toBe(ref);
  });

  it("a consumed kind BEYOND the influence margin is byte-inert (the P5 far-edit fix)", () => {
    // Water at (5000,5000): ~4000 m from the region bbox, well beyond 50 m.
    expect(regionFingerprint({ ...scopedBase(), fabricFeatures: [waterPolygon("wFar", 5000)] })).toBe(ref);
  });

  it("a NON-consumed kind is byte-inert even overlapping the region", () => {
    // A road overlapping the region, but this scope consumes only water.
    expect(regionFingerprint({ ...scopedBase(), fabricFeatures: [roadLine("r1", 100)] })).toBe(ref);
  });

  it("an empty consumesSketch hashes NO raw sketch (forest/mountain read nothing)", () => {
    const inert = { ...base(), consumesSketch: [] as const, influenceMargin: 0 };
    const bare = regionFingerprint(inert);
    // Neither a water nor a road (nor anything) can move an empty-scope fingerprint.
    expect(regionFingerprint({ ...inert, fabricFeatures: [waterPolygon("w", 100)] })).toBe(bare);
    expect(regionFingerprint({ ...inert, fabricFeatures: [roadLine("r", 100)] })).toBe(bare);
  });

  it("scoping is strictly narrower: a far edit that flips the GLOBAL hash leaves the SCOPED hash intact", () => {
    const far = [waterPolygon("wFar", 5000)];
    // Pre-033 global behavior (no consumesSketch): far water flips it.
    expect(regionFingerprint({ ...base(), fabricFeatures: far })).not.toBe(regionFingerprint(base()));
    // Scoped: the same far water is inert.
    expect(regionFingerprint({ ...scopedBase(), fabricFeatures: far })).toBe(ref);
  });
});

function reliefLine(id: string, x0: number, x1: number, halfWidth: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: [[x0, 500], [x1, 500]] },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 7, version: 1, params: { polarity: "ridge", height: 300, halfWidth } } },
  } as FabricFeature;
}
function landformPoly(id: string, x: number): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[[x, x], [x + 200, x], [x + 200, x + 200], [x, x + 200], [x, x]]] },
    properties: { kind: "landform", procgen: { algorithm: "landform", seed: 9, version: 1, params: { mode: "plateau", band: 100, priority: 0 } } },
  } as FabricFeature;
}

describe("regionFingerprint — terrain stamps + base params (ruling 2026-07-15)", () => {
  // A terrain-reading algorithm scope (forest): declares the terrain-stamp kinds.
  function forestScope(): RegionFingerprintInput {
    return { ...base(), algorithm: "forest", consumesSketch: ["mountain", "relief", "landform", "farmland", "park"], influenceMargin: 8 };
  }
  const forestRef = regionFingerprint(forestScope());

  it("VARIABLE SUPPORT: a relief within its half-width flips the fingerprint; past it is inert", () => {
    // Ridge spine at y=500; region 0..1000. A relief with halfWidth 300 whose
    // spine sits 200 m outside the region (bboxGap 200 < 300) is IN reach.
    const near = reliefLine("near", 1200, 1600, 300); // bbox starts 200 m past maxX
    expect(regionFingerprint({ ...forestScope(), fabricFeatures: [near] })).not.toBe(forestRef);
    // Same relief but only 100 m half-width ⇒ bboxGap 200 > 100 ⇒ byte-inert
    // (the scalar 8 m margin would have wrongly dropped BOTH — this is the
    // per-feature reach doing its job).
    const outOfBand = reliefLine("far", 1200, 1600, 100);
    expect(regionFingerprint({ ...forestScope(), fabricFeatures: [outOfBand] })).toBe(forestRef);
  });

  it("a landform's replace-mask uses reach 0: overlapping flips, disjoint is inert", () => {
    expect(regionFingerprint({ ...forestScope(), fabricFeatures: [landformPoly("over", 100)] })).not.toBe(forestRef);
    expect(regionFingerprint({ ...forestScope(), fabricFeatures: [landformPoly("far", 5000)] })).toBe(forestRef);
  });

  it("terrain stamps stay ISOLATED from a NON-terrain consumer (city ignores them)", () => {
    // City's real scope does NOT declare relief/landform ⇒ a terrain stamp is
    // byte-inert to it (byte-stability: no churn for the settlement algorithms).
    const cityScope = (): RegionFingerprintInput => ({
      ...base(),
      consumesSketch: ["water", "river", "road", "wall", "farmland", "park", "district"],
      influenceMargin: 1500,
    });
    const cityRef = regionFingerprint(cityScope());
    expect(regionFingerprint({ ...cityScope(), fabricFeatures: [reliefLine("r", 100, 400, 300)] })).toBe(cityRef);
    expect(regionFingerprint({ ...cityScope(), fabricFeatures: [landformPoly("l", 100)] })).toBe(cityRef);
  });

  it("BYTE-STABILITY: a default (inert) terrainBase leaves the fingerprint unchanged", () => {
    // The append-when-present discipline: an absent/inert base must not flip an
    // existing campaign's fingerprint (goldens + no-config campaigns byte-stable).
    expect(regionFingerprint({ ...forestScope(), terrainBase: { campAmp: 0, seaDatum: 0 }, campaignSeed: 42 })).toBe(forestRef);
    expect(regionFingerprint({ ...forestScope(), terrainBase: undefined })).toBe(forestRef);
  });

  it("a NON-inert base change dirties every terrain consumer", () => {
    const withBase = regionFingerprint({ ...forestScope(), terrainBase: { campAmp: 100, seaDatum: 0 }, campaignSeed: 42 });
    expect(withBase).not.toBe(forestRef);
    // The campaign seed feeds the base fBm ⇒ a re-seed re-hashes when campAmp>0.
    const reseeded = regionFingerprint({ ...forestScope(), terrainBase: { campAmp: 100, seaDatum: 0 }, campaignSeed: 99 });
    expect(reseeded).not.toBe(withBase);
  });

  it("a base change is INERT for a non-terrain consumer (city keeps byte-stability)", () => {
    const cityRef = regionFingerprint(base());
    expect(regionFingerprint({ ...base(), terrainBase: { campAmp: 100, seaDatum: 25 }, campaignSeed: 7 })).toBe(cityRef);
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
    // per docs/quality-bar.md (throttled numbers only) — the hasher swap keeps this budget
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

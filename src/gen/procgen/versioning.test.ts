/**
 * Version-pin contract tests: the registry side of versioned determinism.
 * The policy: byte-determinism within an algorithm version; a change that
 * alters output bytes for the same (seed, params) bumps `currentVersion`;
 * regions pin the version they were created under and only explicit GM
 * adoption raises the pin. The fingerprint side (a version-only difference
 * flips the cache fingerprint) is asserted in `cache/fingerprint.test.ts`;
 * the host side (creation writes currentVersion, edits never change it) in
 * `controller/MapController.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { allAlgorithms, algorithmById, migrateParamsForAdoption, type ProcgenAlgorithm } from "./registry";
import { FabricFeatureSchema, type FabricFeature } from "../../model/fabric";

describe("registry — currentVersion contract", () => {
  it("every algorithm declares an integer currentVersion ≥ 1", () => {
    const algos = allAlgorithms();
    expect(algos.length).toBeGreaterThan(0);
    for (const a of algos) {
      expect(Number.isInteger(a.currentVersion), a.id).toBe(true);
      expect(a.currentVersion, a.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("adoption from any older pin yields params the CURRENT schema accepts (identity or migrated)", () => {
    // migrateParams is optional — absent means the bump changed no param
    // semantics and the identity fallback is the adoption path. Either way,
    // adopting a v1-pinned preset must produce currently-valid params.
    for (const a of allAlgorithms()) {
      if (a.currentVersion <= 1) continue;
      for (const preset of a.presets) {
        const adopted = migrateParamsForAdoption(a, 1, preset.params);
        expect(
          a.paramsSchema.safeParse(adopted).success,
          `${a.id} v1→v${a.currentVersion} adoption of preset ${preset.id}`
        ).toBe(true);
      }
    }
  });
});

describe("migrateParamsForAdoption", () => {
  const withMigration: ProcgenAlgorithm = {
    ...algorithmById("river")!,
    currentVersion: 2,
    migrateParams(oldVersion, params) {
      return { ...params, migratedFrom: oldVersion };
    },
  };

  it("identity (fresh copy) when the pin already matches currentVersion", () => {
    const params = { windiness: 0.5 };
    const out = migrateParamsForAdoption(algorithmById("river")!, 1, params);
    expect(out).toEqual(params);
    expect(out).not.toBe(params); // callers persist it into a new block
  });

  it("identity when the algorithm defines no migrateParams", () => {
    const out = migrateParamsForAdoption(algorithmById("city")!, 0, { profile: "euro-medieval" });
    expect(out).toEqual({ profile: "euro-medieval" });
  });

  it("applies migrateParams when adopting from an older pin", () => {
    const out = migrateParamsForAdoption(withMigration, 1, { windiness: 0.5 });
    expect(out).toEqual({ windiness: 0.5, migratedFrom: 1 });
  });

  it("never migrates 'down' — a pin at/above currentVersion is returned as-is", () => {
    const out = migrateParamsForAdoption(withMigration, 2, { windiness: 0.5 });
    expect(out).toEqual({ windiness: 0.5 });
  });
});

describe("pinned params parse leniently at the fabric IO boundary", () => {
  it("a procgen block with unknown param keys round-trips unchanged", () => {
    // A region pinned to an older version may carry params the current schema
    // does not know. They must pass through the fabric boundary untouched —
    // they only feed the pinned cache's fingerprint, never current generator
    // code — so the block schema keeps params as a loose record.
    const feature: FabricFeature = {
      type: "Feature",
      id: "f-1",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        kind: "district",
        procgen: {
          algorithm: "city",
          seed: 42,
          version: 1,
          params: { profile: "euro-medieval", retiredKnob: 0.7, futureKnob: [1, 2] },
        },
      },
    };
    const parsed = FabricFeatureSchema.parse(JSON.parse(JSON.stringify(feature)));
    expect(parsed.properties.procgen?.version).toBe(1);
    expect(parsed.properties.procgen?.params).toEqual({
      profile: "euro-medieval",
      retiredKnob: 0.7,
      futureKnob: [1, 2],
    });
  });

  it("a block without a version field still defaults to 1 (pre-versioning data)", () => {
    const raw = {
      type: "Feature",
      id: "f-2",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {
        kind: "district",
        procgen: { algorithm: "city", seed: 7, params: { profile: "na-grid" } },
      },
    };
    const parsed = FabricFeatureSchema.parse(raw);
    expect(parsed.properties.procgen?.version).toBe(1);
  });
});

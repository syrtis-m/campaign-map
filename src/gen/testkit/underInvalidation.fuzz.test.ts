/**
 * Plan 033-A — the under-invalidation property gate, fuzz tier (runs here
 * FOREVER per the plan's red-team precondition: scoped invalidation inverts
 * the failure mode from slow-but-correct to silently-stale, so the net stays
 * up as long as declarations exist).
 *
 * For every registry algorithm × every sketch kind NOT in its declared
 * consumption set (any placement, incl. overlapping) and every declared kind
 * placed strictly OUTSIDE its margin: generation with vs without the feature
 * must be byte-identical. Plus the prove-the-net-catches tests: intentionally
 * under-declared clones of the table MUST produce violations.
 */
import { describe, expect, it } from "vitest";
import { algorithmById, allAlgorithms, type ProcgenAlgorithm } from "../procgen/registry";
import {
  checkUnderInvalidation,
  formatViolations,
  type DeclaredConsumption,
} from "./underInvalidation";

/**
 * The consumption declarations now live on the REGISTRY (plan 033-C:
 * `consumesSketch` + `influenceMargin`); this harness reads them straight
 * off it, so a wrong declaration fails HERE — the declaration IS the contract
 * the scoped invalidation walk + fingerprints key on. The temporary local
 * MEASURED_CONSUMPTION fixture that seeded 033-C was deleted when the values
 * moved onto the registry; the intentionally-WRONG clones below (prove-the-net)
 * are kept.
 *
 * The registry rows (verified against the code + empirically by this harness)
 * diverge from the research report §1 SUMMARY table twice: river ALSO consumes
 * `mountain` (slope coupling, compact-support field ⇒ margin 30), and city's
 * margin is 1500 m not 200 (the road→street tensor blend `3·exp(−d/60)` has no
 * distance cutoff and still steers streets at ~1 km). See the registry JSDoc on
 * `consumesSketch` / `influenceMargin` for the per-algorithm constants.
 */
function declaredConsumption(alg: ProcgenAlgorithm): DeclaredConsumption {
  return { kinds: alg.consumesSketch, marginMeters: alg.influenceMargin };
}

describe("under-invalidation property harness (plan 033-A)", () => {
  it("every registry algorithm declares a consumption (consumesSketch + influenceMargin)", () => {
    const ids = allAlgorithms().map((a) => a.id);
    // plan 036 added the terrain stamps `relief` + `landform` (7 → 9).
    expect(ids.length).toBe(9);
    for (const alg of allAlgorithms()) {
      expect(Array.isArray(alg.consumesSketch), `algorithm "${alg.id}" missing consumesSketch`).toBe(true);
      expect(typeof alg.influenceMargin, `algorithm "${alg.id}" missing influenceMargin`).toBe("number");
      expect(alg.influenceMargin).toBeGreaterThanOrEqual(0);
    }
  });

  for (const alg of allAlgorithms()) {
    it(`${alg.id}: byte-identical under every undeclared / out-of-margin sketch placement`, () => {
      const violations = checkUnderInvalidation(alg.id, declaredConsumption(alg));
      expect(violations, formatViolations(violations)).toEqual([]);
    });
  }
});

describe("prove the net catches (intentional under-declarations MUST fail)", () => {
  it("dropping `road` from park's set is detected", () => {
    const bad: DeclaredConsumption = { kinds: [], marginMeters: 30 };
    const violations = checkUnderInvalidation("park", bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "road")).toBe(true);
    // And ONLY road — park reads nothing else, so the detector is precise,
    // not just noisy.
    expect(violations.every((v) => v.kind === "road")).toBe(true);
  });

  it("dropping `road` from wall's set is detected", () => {
    const bad: DeclaredConsumption = { kinds: [], marginMeters: 0 };
    const violations = checkUnderInvalidation("wall", bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === "road")).toBe(true);
  });

  it("dropping `mountain` from river's set is detected (the report §1 summary-table gap)", () => {
    const bad: DeclaredConsumption = { kinds: ["water", "river"], marginMeters: 30 };
    const violations = checkUnderInvalidation("river", bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "mountain")).toBe(true);
  });

  it("dropping `relief` from forest's set is detected (ruling 2026-07-15 terrain read)", () => {
    // Forest reads the composed terrain field (`macroTerrainField`), so a relief
    // RIDGE overlapping the region thins its canopy above the treeline. An
    // under-declaration that omits `relief` must be caught (an overlapping relief
    // moves bytes) — the net over the new terrain-stamp coupling.
    const bad: DeclaredConsumption = { kinds: ["mountain", "landform", "farmland", "park"], marginMeters: 8 };
    const violations = checkUnderInvalidation("forest", bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "relief")).toBe(true);
  });

  it("dropping `landform` from farmland's set is detected (ruling 2026-07-15 terrain read)", () => {
    // Farmland (paddy) reads the composed terrain field, so a landform PLATEAU
    // overlapping the region reshapes its terrace banks. Omitting `landform` must
    // be caught.
    const bad: DeclaredConsumption = { kinds: ["mountain", "relief", "forest", "park"], marginMeters: 8 };
    const violations = checkUnderInvalidation("farmland", bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.kind === "landform")).toBe(true);
  });

  it("an under-declared MARGIN is detected (city road margin 200 m is too small)", () => {
    const city = algorithmById("city")!;
    const bad: DeclaredConsumption = { kinds: city.consumesSketch, marginMeters: 200 };
    const violations = checkUnderInvalidation("city", bad);
    expect(violations.length).toBeGreaterThan(0);
    // The road tensor blend is the unbounded read; the violation must be a
    // DECLARED kind caught outside the (too small) margin.
    expect(violations.some((v) => v.kind === "road" && v.declared)).toBe(true);
  });
});

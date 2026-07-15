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
import type { FabricKind } from "../../model/fabric";
import { allAlgorithms } from "../procgen/registry";
import {
  checkUnderInvalidation,
  formatViolations,
  type DeclaredConsumption,
} from "./underInvalidation";

/**
 * The MEASURED consumption table — TEMPORARY LOCAL FIXTURE: plan 033-C moves
 * these rows onto the registry as `consumesSketch` + `influenceMargin`; when
 * it does, this literal is deleted and the suite reads the registry instead.
 *
 * Rows verified against the code (2026-07-15) and empirically by this
 * harness. Two divergences from the research report §1 SUMMARY table (its
 * wired-reads COLUMN already agrees — the summary row dropped them):
 *
 *  - river ALSO consumes `mountain`: `generateRiver` composes
 *    `elevationFieldFromFabric` for slope coupling (river.ts:576, on by
 *    default — lazy-lowland has slopeSensitivity 1) and dressRiver classifies
 *    rapids/falls by slope. Margin 30 covers it: the mountain height field
 *    has compact support (mask is 0 outside the sketched ring,
 *    fields/mountainField.ts), and the zero-sample path is
 *    arithmetic-transparent (measured byte-identical at any positive gap;
 *    overlap measurably flips bytes).
 *  - city's margin must be far LARGER than the report §3 P4 sketch
 *    ("road-falloff + bridge span", default 200 m): the road→street tensor
 *    blend `3·exp(−d/60)` (fabricConstraints.ts ROAD_ALIGN_STRENGTH/
 *    ROAD_FALLOFF) has NO distance cutoff, so a road at 200–400 m still
 *    steers streets by whole degrees and flips bytes (proven below by the
 *    under-declared-margin test). Measured byte-inert from ≈1 km; declared
 *    1500 m for headroom. Every other city read has an exact cutoff well
 *    inside that (cost-field bbox +200 m, RIVER_HALF_WIDTH 15 m, exact
 *    point-in-ring / segment-crossing predicates).
 *
 * Other margins, from the code's own constants:
 *  - river 30 m: CONFLUENCE_SNAP_M = 30 (river.ts) bounds both the
 *    water-mouth test and the partner-spine confluence test, measured from
 *    spine endpoints (inside the region bbox); mountain needs only > 0.
 *  - park 30 m: ROAD_ENTRANCE_THRESH_M = 30 (park.ts) — exact `<=` cutoff on
 *    road-to-ring distance.
 *  - wall 0 m: gates come from exact road×spine segment crossings (wall.ts);
 *    a road strictly outside the corridor bbox cannot cross the spine.
 *  - farmland 0 m: paddy-terraces reads the mountain elevation field, which
 *    is zero outside the sketched mountain ring (compact support) and gates
 *    on in-region relief (PADDY_MIN_RELIEF_M) — a disjoint mountain is
 *    byte-inert.
 *  - forest, mountain: consume NOTHING (generateForest/generateMountain never
 *    read constraints) — their DAG `consumes` declarations (`water`, none)
 *    are about upstream OUTPUT artifacts, not raw sketch kinds.
 */
const MEASURED_CONSUMPTION: Record<string, DeclaredConsumption> = {
  city: { kinds: ["water", "river", "road", "wall", "farmland"], marginMeters: 1500 },
  river: { kinds: ["water", "river", "mountain"], marginMeters: 30 },
  forest: { kinds: [], marginMeters: 0 },
  park: { kinds: ["road"], marginMeters: 30 },
  wall: { kinds: ["road"], marginMeters: 0 },
  farmland: { kinds: ["mountain"], marginMeters: 0 },
  mountain: { kinds: [], marginMeters: 0 },
};

describe("under-invalidation property harness (plan 033-A)", () => {
  it("covers every registry algorithm (a new algorithm must add a table row)", () => {
    const ids = allAlgorithms().map((a) => a.id);
    expect(ids.length).toBe(7);
    for (const id of ids) {
      expect(MEASURED_CONSUMPTION[id], `algorithm "${id}" has no consumption row`).toBeDefined();
    }
    expect(Object.keys(MEASURED_CONSUMPTION).sort()).toEqual([...ids].sort());
  });

  for (const alg of allAlgorithms()) {
    it(`${alg.id}: byte-identical under every undeclared / out-of-margin sketch placement`, () => {
      const violations = checkUnderInvalidation(alg.id, MEASURED_CONSUMPTION[alg.id]);
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

  it("an under-declared MARGIN is detected (city road margin 200 m is too small)", () => {
    const bad: DeclaredConsumption = { ...MEASURED_CONSUMPTION.city, marginMeters: 200 };
    const violations = checkUnderInvalidation("city", bad);
    expect(violations.length).toBeGreaterThan(0);
    // The road tensor blend is the unbounded read; the violation must be a
    // DECLARED kind caught outside the (too small) margin.
    expect(violations.some((v) => v.kind === "road" && v.declared)).toBe(true);
  });
});

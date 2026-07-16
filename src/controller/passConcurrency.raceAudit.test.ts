/**
 * RACE-AUDIT item 4 (2026-07-15) — FIXED. Concurrent `runForwardPass`
 * invocations used to share mutable controller state (`sessionCache` force-drops,
 * `pendingPass`, `outdatedRegions` / `needsAdoption` / `previewedRegions` /
 * `regionPaintedStage`) with no serialization: a panel edit's pass and the
 * debounced external-fabric reload's pass could interleave. The fix chains every
 * pass behind the previous through `passChain`, so pass bodies never overlap.
 *
 * These tests witness the invariant directly (peak concurrency stays 1) and prove
 * the deferred-cascade state stays coherent across overlapping over-budget passes.
 */
import { describe, it, expect } from "vitest";
import { FakeHost } from "./FakeHost";

const RING: [number, number][] = [
  [10, -26],
  [26, -26],
  [26, -10],
  [10, -10],
];
const RIVER_LINE: [number, number][] = [
  [6, -30],
  [16, -20],
  [24, -12],
];

function cityHost(): FakeHost {
  const host = new FakeHost({ zoom: 10 });
  host.begin();
  return host;
}

describe("concurrent runForwardPass shared-state interleave (race-audit item 4)", () => {
  it("serializes overlapping passes — pass bodies never run concurrently", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");

    // Launch two passes WITHOUT awaiting between them (genuinely overlapping):
    // unserialized, both bodies would enter and interleave at their first await.
    await Promise.all([
      host.controller.regenerateRegionById(river.featureId),
      host.controller.regenerateRegionById(city.featureId),
    ]);

    expect(host.controller.passConcurrencyPeak).toBe(1);
  });

  it("overlapping over-budget passes leave a COHERENT pendingPass + outdated badge (no stuck ghosts)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");

    // Budget below the city's cost so any pass touching the river defers the city.
    host.controller.overrideCascadeCostBudgetForTest(3);

    // Two over-budget river edits fired concurrently. Serialized, they run in
    // launch order and the SECOND leaves the authoritative deferred set.
    await Promise.all([
      host.controller.setRegionParams(river.featureId, { windiness: 0.9 }),
      host.controller.setRegionParams(river.featureId, { windiness: 0.1 }),
    ]);

    expect(host.controller.passConcurrencyPeak).toBe(1);
    // Coherent bill: exactly the city deferred, badge matches pendingPass.
    expect(host.controller.hasPendingCascade).toBe(true);
    expect(host.controller.outdatedRegionIds()).toEqual([city.featureId]);

    // The held bill applies cleanly and clears — no stuck outdated ghost.
    await host.controller.applyPendingCascade();
    expect(host.controller.hasPendingCascade).toBe(false);
    expect(host.controller.outdatedRegionIds()).toEqual([]);
  });
});

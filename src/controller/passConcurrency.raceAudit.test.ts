import { describe, it } from "vitest";

/**
 * RACE-AUDIT (2026-07-15): concurrent `runForwardPass` invocations share mutable
 * controller state with no serialization.
 *
 * `runForwardPass` (MapController) is `async` and holds no mutex/epoch. Multiple
 * triggers reduce to it without ordering: `setRegionParams`/`setRegionPreset`,
 * `adoptAllRegions`, `applyPendingCascade`, and — the reachable overlap — the
 * debounced external-fabric reload (`reloadFabricFromDisk` → runForwardPass) that
 * can fire WHILE a panel edit's pass is still awaiting its worker jobs. Two passes
 * then interleave over shared fields:
 *   - `sessionCache` (the 032-B view): pass A `.delete`s a region's network record
 *     (force-drop) while pass B iterates/reads it — extra recompute; converges only
 *     because bytes are deterministic (benign UNLESS the fabric moved between them).
 *   - `pendingPass`: an over-budget pass B overwrites A's deferred set; A's deferred
 *     regions stay `outdatedRegions`-badged until an unrelated later trigger clears
 *     them (stuck-badge — stale-serve severity).
 *   - `outdatedRegions` / `needsAdoption` / `previewedRegions` / `regionPaintedStage`:
 *     add/delete interleavings leave inconsistent badge/paint state (visual).
 *
 * Rated CONFIRMED-structural (no guard exists) but the harmful window needs two
 * genuinely-concurrent passes; the deterministic-bytes property makes the common
 * case self-healing, so the durable-corruption risk is bounded to the fabric-moved
 * -mid-pass case already covered by the reconcile CAS (73853a0).
 *
 * FIX NOT APPLIED HERE — it belongs on `runForwardPass` and its reload caller,
 * which the parallel MapController flush/reload agent owns, and a proper guard
 * (serialize passes through a promise chain, or an epoch that supersedes an
 * in-flight pass on a newer trigger) is > the ~30-line guard-application budget of
 * this audit. Filed as a recommendation in OVERNIGHT_RUN.md § RACE AUDIT.
 *
 * TODO(race-audit): once passes are serialized, add a FakeHost test that fires an
 * over-budget `setRegionParams` pass and a `reloadFabricFromDisk` pass
 * concurrently and asserts a single coherent `pendingPass` + no stuck
 * `outdatedRegions`.
 */
describe("concurrent runForwardPass shared-state interleave (race-audit)", () => {
  it.skip("serializes overlapping passes so pendingPass/outdatedRegions stay coherent (fix owned by the flush/reload agent)", () => {
    // Documented above; recommendation only.
  });
});

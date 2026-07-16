import { describe, it } from "vitest";

/**
 * RACE-AUDIT (2026-07-15): worker double-init in `CampaignMapPlugin.getGenerationWorker`.
 *
 * CONFIRMED by inspection (fix applied in main.ts): the pre-fix guard was a bare
 * `if (this.workerClient) return this.workerClient` around an `await
 * GenerationWorkerClient.create(this.app)`. A cold campaign open fires three
 * worker consumers concurrently — DEM-tile lattice fill (campaignDemProtocol),
 * contour leaves (terrainContourManager), and region replay (MapController) — all
 * before `create()`'s async `adapter.read(workerPath)` resolves. Each sees
 * `workerClient === null` and spawns its own `Worker`; the losers are leaked
 * (onunload only terminates the one field). Fix: memoize the in-flight CREATION
 * promise (`workerClientPromise`), so concurrent first-callers share one worker.
 *
 * SKIPPED, not runnable headlessly: `main.ts` does `class CampaignMapPlugin
 * extends Plugin` and `Plugin` comes from the `obsidian` package, which ships
 * only type declarations (empty runtime `main`). Importing `main.ts` in the node
 * vitest env throws at module-evaluation, so there is no way to construct the
 * plugin here. A real regression test needs an `obsidian` runtime mock (a
 * project-wide harness change, out of scope for this audit).
 *
 * TODO(race-audit): once an `obsidian` test mock exists, un-skip and assert that
 * N concurrent `getGenerationWorker()` calls (with a `create` that resolves on a
 * gate) construct EXACTLY ONE worker.
 */
describe("getGenerationWorker worker double-init (race-audit)", () => {
  it.skip("shares one worker across concurrent first-callers (needs an obsidian Plugin harness)", () => {
    // Documented above; fix applied in main.ts (workerClientPromise memoization).
  });
});

# Plan 034 — runForwardPass: one invalidation rule, preview mode, cost-weighted cap

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §6 (Jonah 2026-07-14;
§9 Q2 OK'd the preview-mode mitigation, Q5 the Apply pattern for campaign-wide bills).

**Depends:** 032 (persistent view + sharding + staged repaint), 033 (consumption-aware
declarations + scoped fingerprints). **Read first:** research report §6 (the full execution model),
§3 (P8–P10); `src/controller/MapController.ts`; `src/gen/procgen/dag.ts`.

## 0. Context for a cold-start implementer

After 031–033, the pieces exist but four separate code paths still drive regen (flush /
regenerateAffectedTiles / cascadeFromRoot / replay). This plan collapses them into ONE:
`markDirty(roots) → runForwardPass()`, making Jonah's requirement — any edit is a single forward
pass; an edit at stage s never touches stage < s — structural, asserted at runtime, and identical
between live editing and campaign-open replay. The stage semantics themselves do NOT change here
(that is plan 035); this plan is pure mechanics.

## 1. Scope

1. **Sketch + canon source nodes:** `dag.ts` `Stage` gains −1; every constraint-bearing sketch
   feature (and canon pin) becomes a source node `{stage: −1, produces: [kind]}`; source→region
   edges use 033's `consumesSketch × influenceMargin`. `regenerateAffectedTiles` is DELETED.
2. **The pass:** dirty = `downstreamClosure(roots)`; one scoped-fp pass (033); walk in `(stage,id)`
   order; each region computed once, fp-stamped, written into the persistent view so downstream
   reads fresh upstream with zero IO; batched drops (032 shards); staged repaint (032). Runtime
   assertions: executed stage sequence non-decreasing; no writes outside the closure.
3. **Cost-weighted confirm cap** replacing the region-count threshold: Σ registry `costClass` over
   the closure, INCLUDING render-leaf work once plan 036 lands (a region-count cap is blind to both
   10-farmlands-vs-10-cities and to contour storms). Non-modal (Notice + command), headless bypass
   retained. Covers every trigger — the former raw channel included (fixes P10).
4. **Declined bills never storm:** a declined pass leaves downstream records fp-stale; replay
   SERVES stale-fp bytes with an "outdated" badge (re-using the plan-029 badge surface) instead of
   an uncapped recompute at next open; "Apply pending cascade" runs the deferred pass explicitly.
5. **Preview mode (precondition for plan 035, ratified Q2):** during a drag, only the ROOT
   regenerates per debounce pause, painted as ephemeral render state — never fp-stamped, never
   cached; the full pass runs once on release/commit. The `debounce:false` vertex APIs and undo
   route through the same pending-roots path (fixes P8's double regen; undo = restore durable state
   + run the pass ⇒ byte-identical restoration). Per-stage debounce tiers and closure-truncation
   heuristics are REJECTED (report §6.6) — do not reintroduce them.
6. **Adopt-all as one pass:** raise all pins first (durable writes, (stage,id) order), then a single
   pass over the union closure (fixes P9's O(k²)).
7. **Replay-on-load = `runForwardPass(dirty = fp mismatches)`** — live and replay share the code
   path verbatim; pinned-old semantics unchanged inside a pass (cache-serve-or-badge, never
   recompute; consent stays at direct-edit entry points).

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **34-A (source nodes + closure):** invalidation-scope parity tests vs 033's walk; DAG acyclicity
  with −1 sources; district sketch-add dirties nothing.
- **34-B (the pass):** the report's counter suite as standing invariants — `generatorRunCount ===
  dirtyRegionCount`, one fp pass, reads/writes batched per 032's counters, repaints ≤ stages
  touched; stage-monotonicity + closure-bound assertions firing on an injected violation (prove the
  guard guards); shuffled-fabric-order byte-identity; rm-`.mapcache` replay byte-diff via the SAME
  entry point.
- **34-C (cap + badge):** decline ⇒ zero downstream writes; reopen ⇒ badge-not-storm (zero
  generator runs for deferred regions); apply-pending ⇒ same bytes as an undeferred pass.
- **34-D (preview):** during simulated drag, zero cache writes + zero fp stamps + downstream
  untouched; release ⇒ one full pass; interrupted session (kill before release) leaves no durable
  trace of previews.
- **34-E (adopt-all):** k-chain fixture (mountain→river→city pinned) ⇒ each region regenerated
  exactly once; total runs O(k).

## 3. STOP conditions / risks

- If any behavior difference between live-edit and replay staleness survives this plan, the plan
  has failed its purpose — do not paper over it with a special case; find the divergence.
- The cap must never defer the ROOT (the GM's own edit always applies; only downstream defers).
- Explicit-only generation is untouched: a pass only RE-generates; sketch sources never trigger
  first-time generation; pan/zoom Δ0 gates stay green.

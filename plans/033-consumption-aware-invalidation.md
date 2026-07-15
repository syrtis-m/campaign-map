# Plan 033 — Consumption-aware invalidation: harness first, then consumesSketch + scoped fingerprints

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §4.3/§6.3 (Jonah 2026-07-14).

**Depends:** 031. **Read first:** research report §1 (the MEASURED consumption table), §3 (P4/P5),
§6.3; `src/gen/cache/fingerprint.ts`; `src/gen/procgen/registry.ts`.

## 0. Context for a cold-start implementer

Today any sketch edit force-regens every region within a blanket 200 m (P4 — editing a road
regenerates mountains, which read nothing), and the staleness fingerprint hashes ALL fabric (P5 —
any sketch edit anywhere flips every region's fingerprint, so the next campaign open recomputes the
whole campaign and can spuriously blank plan-029 pinned-old regions). The fix is declaring, per
algorithm, which sketch KINDS it reads and how far they reach — then scoping fingerprints to that.

**The one danger (hard precondition, red-team):** today's blanket hash is conservative — wrong in
the slow-but-correct direction. Scoping inverts the failure mode: an under-declared `consumesSketch`
row silently serves STALE BYTES AS FRESH — the exact class plan 029 exists to prevent. Therefore
the property harness (33-A) ships BEFORE any behavior keys on the declarations, and it runs in the
fuzz tier forever.

## 1. Scope

1. **33-A — Under-invalidation property harness (shipping gate for everything else):** for every
   registry algorithm × every sketch kind NOT in its declared set (and for declared kinds placed
   OUTSIDE the declared margin): generate with and without the extra feature ⇒ output must be
   byte-identical. Seeded + fuzzed placements. This converts `consumesSketch` from trusted
   declaration into verified contract; it would have caught P4's whole class at birth.
2. **33-B — Hasher replacement:** the FNV hasher does a BigInt multiply per character (~10–30 MB/s);
   replace with a two-lane 32-bit (or xxhash-style) implementation before fingerprints hash
   10–15 k-vertex quantized rings. `FP_VERSION` bump ⇒ one-time self-healing recompute (documented
   mechanism, harmless).
3. **33-C — Registry declarations:** `consumesSketch: FabricKind[]` seeded from the report §1
   MEASURED table (city: water/river/road/wall/farmland; river: water + river; park: road; wall:
   road; farmland: mountain; forest/mountain: none) — never from optimistic intent — plus
   per-algorithm `influenceMargin` (city ≈ road-falloff + bridge span; river ≈ confluence snap;
   default 200 m preserves today) and a `costClass` (consumed later by plan 034's cost-weighted
   cap). Raw-channel invalidation switches from blanket reach to `kind ∈ consumesSketch ∧ bbox
   within influenceMargin`.
4. **33-D — Scoped fingerprints:** `canonicalConstraints` hashes only the consumed kinds within the
   influence bbox (+ upstream artifact fps as today); the fp pass THROWS on a missing upstream fp
   (never silently filters); a region whose recomputed fp equals its cached record's fp is skipped
   even when nominally dirty (declared-but-inert edges become free). `FP_VERSION` bump.

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **33-A:** the harness itself green across all 7 algorithms (fuzz tier); intentionally
  under-declare a kind in a test-only registry clone ⇒ harness must FAIL (prove the net catches).
- **33-B:** hash-equivalence not required (FP_VERSION bump); perf micro-benchmark asserted as a
  budget counter (bytes-hashed per pass), not wall-clock.
- **33-C:** invalidation-scope tests: road edit ⇒ only road-consumers within margin regenerate
  (`generatorRunCount` deltas); district sketch-add ⇒ zero neighbor regens; P4 fixture from the
  report goes from 3 regens to 1.
- **33-D:** live-vs-replay fp agreement (same inputs ⇒ identical fps through both paths); pinned-old
  region survives an unrelated sketch edit across the map (no badge, no blank); campaign-open after
  a far-away sketch edit recomputes ZERO out-of-reach regions (the P5 load-storm test); rm
  `.mapcache/` replay byte-diff.

## 3. STOP conditions / risks

- No behavior may key on `consumesSketch` before 33-A is merged and green — review-blocking.
- If a generator turns out to read a kind the measured table missed, fix the DECLARATION (and the
  harness catches it); never special-case the invalidation walk.
- Declarations describe today's generators; plans 035/037/038 add consumption — each such change
  updates the declaration AND rides its own algorithm version bump (029 policy).

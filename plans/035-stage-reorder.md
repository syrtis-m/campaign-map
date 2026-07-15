# Plan 035 — Stage reorder: hydrology above terrain, peri-urban band, park split, river v2

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §4 (Jonah 2026-07-14;
§9 Q1 river default flip OK'd, Q2 peri-urban coupling OK'd, Q3 grading default-off OK'd).

**Depends:** 034 (preview mode is the ratified precondition — without it this reorder makes the
most common edit 5–10× slower). **Read first:** research report §4 (the graph), §2 (hydrology +
vegetation cluster verdicts); `src/gen/procgen/registry.ts`, `dag.ts`.

## 0. Context for a cold-start implementer

The stage numbers become the product's semantic order (report §4.1):

```
−1 sources · 0 HYDROLOGY (river) · 1 TERRAIN (mountain→stamps) · 2 VEGETATION (forest, rural park)
 · 3 SETTLEMENT (city) · 4 PERI-URBAN (farmland, urban-park) · 5 DETAIL (wall)
```

Rivers are canon strokes; terrain conforms to them (the carve lands in plan 036 — this plan only
frees rivers from terrain). Jonah's litmus: a terrain edit reaches farmland, never a river. The one
cycle-guard invariant introduced here: **nothing may consume `settlement` while producing a
currency the city consumes** — enforce it as a registry contract test, not a comment.

## 1. Scope

1. **Renumber stages** per the table; `dag.ts` machinery is stage-agnostic (verify, don't rewrite).
2. **River v2 (ratified Q1):** `slopeSensitivity` default 1→0; river drops `consumes:
   ["elevation"]` (the opt-in >0 path reads macro-terrain-from-sketch — `elevationFieldFromFabric`
   — which is durable-input and legal at any stage; document as "macro terrain, not finished
   terrain"). `currentVersion` bump + goldens:accept; existing rivers stay pinned until adoption
   (the adoption UX exists; a mountain-crossing river re-meanders once on adopt — signed off).
3. **Park split by variety:** rural varieties (formal-garden, wild-common …) stay stage 2 producing
   `vegetation`; an `urban-park` path sits at stage 4 consuming `settlement` (entrances/axes align
   to generated street crossings on the ring) and produces NOTHING (the invariant). Variety drives
   the stage via the registry — no second algorithm id unless the schema forces it. Park version
   bump.
4. **Farmland → stage 4 (peri-urban):** declares `consumes: ["settlement"]` and wires the marquee
   read in the same phase (declarations must not outrun behavior): lanes/strips orient to the
   nearest generated gate/arterial, field-size gradient toward the wall line. The city keeps
   reading only the farmland SKETCH for outskirt suppression (unchanged, stage-agnostic — "ring =
   land claim, output = interior dressing"). Farmland version bump. `consumesSketch` +
   fingerprints follow automatically from 033.
5. **Wall → stage 5.** No behavior change here (payload consumption is plan 037).

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **35-A (renumber + river v2):** litmus test — mountain param/vertex edit ⇒ ZERO river generator
  runs, zero river byte change; opted-in river (slopeSensitivity>0) still adapts; river goldens
  re-accepted under v2; adoption test: pinned v1 river byte-stable until adopt.
- **35-B (park split):** urban-park entrances land on generated street crossings (fixture city +
  contained park); rural park byte-identical to pre-split (no version-visible change for rural
  varieties beyond the bump bookkeeping); the cycle-guard contract test (any registry entry
  consuming `settlement` must have `produces` disjoint from city's `consumes`) — make it a standing
  registry test, it guards 037/038 too.
- **35-C (farmland move):** city edit cascades adjacent farmland (order test via
  `cascadeRegeneratedIds`); farmland edit never touches the city; lanes visibly radiate from gates
  in the playground (eyeball via `npm run playground`, no Obsidian needed); farmland goldens
  re-accepted; 033's under-invalidation harness green against the updated declarations.

## 3. STOP conditions / risks

- Preview mode (34-D) must be merged and green before 35-C lands — the ratification of Q2 was
  conditional on it.
- If urban-park needs to both read streets AND feed the city's growth-cost (someone will ask), the
  answer is NO — that is the bidirectional trap the invariant exists to block; rural varieties are
  the vegetation producers.
- Stage renumbering must not leak into persisted data (stages live in the registry, never in
  `Fabric.geojson` blocks) — verify nothing serializes a stage number.

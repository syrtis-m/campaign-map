# Plan 030 — Rearchitecture waves: sweep, gate shrink, declarative paint, operators-as-data

**Status:** SEQUENCING RATIFIED (Jonah, 2026-07-14 — see DECISIONS same date). Phases
execute AFTER the in-flight 026–028 HEARTBEAT waves land. Waves 0–1 of the arc are
already DONE (plan 029 policy ratified; `playground/` shipped, `npm run playground`).

## §0 Cold start — intent, and the pitfalls that shaped this plan

**Intent.** The codebase's core design (pure generators, registry, region/DAG
machinery) is sound; what slows building and tuning procgen is three taxes: the
feedback loop ran through Obsidian (fixed — playground), the determinism contract was
byte-eternal (fixed in policy — plan 029), and every new algorithm fans out into
hand-written work across comments/themes/gates. This plan removes the fan-out: one
sweep of accumulated context rot (A), a test pyramid whose expensive tier is small (B),
paint that derives from data instead of five hand-edited themes (D), and a standing
convention that new presets are operators + data, not new code paths (C).

**Global ordering (ratified):**

```
[026–028 waves land] → 030-A sweep → plan 029 §3–§8 (versioned determinism mechanics)
                     → 030-B gate shrink → 030-D declarative paint
                     → 030-E documentation reconciliation (ALWAYS the last phase)
030-C (operators+data) = standing convention from 030-A onward, not a wave
```

Rationale: the sweep needs 029's policy to know which comments are dead; the gate
shrink needs the playground + 029's metric bands to exist as replacements; declarative
paint has no upstream dependency and is last because it is pure future-velocity (pull
it earlier if the playground's paint shim becomes a maintenance drag).

**Pitfalls for a cold-start agent:**
- 030-A is a REPO-WIDE diff. Never run it concurrently with any other writing agent;
  it needs a dedicated quiet window and lands as few large commits, not many small
  ones interleaved with feature work.
- The sweep deletes comments, never behavior. `npm test` + `npm run test:fuzz` +
  `tsc` byte-green after every sweep commit; zero source-semantics changes ride along.
- 030-B deletes gates only AFTER their replacement assertion exists and is proven to
  catch a seeded failure (see B's "prove-by-breaking" rule). Deleting coverage on the
  promise of a replacement is the failure mode.
- 030-D moves paint *definitions*, not paint *values*: every theme must render
  pixel-identically before/after (the vo-w0-style-bytes gate pattern — style JSON
  byte-compare per theme is the cheap proof).
- `dev-vault/Campaigns/Vespergate` stays byte-intact through everything, as always.

---

## 030-A — The sweep: comments, docs, and single-home invariants (wave 2)

**Goal.** Kill context rot: the code states local constraints only; every invariant
has exactly one home; docs stop overlapping.

Scope, in commit-sized slices (each slice: T0 green, no semantic diffs):

1. **Comment rules, applied file-by-file across `src/`:**
   - DELETE: plan/provenance citations ("plan 025 §2.9", "the 23-A lesson",
     "since v3.2"), before/after narration ("was X, now Y"), restatements of
     CLAUDE.md/ARCHITECTURE invariants, PR-reviewer reassurance ("byte-identical —
     verified"), determinism essays that repeat D1–D6 (one pointer suffices).
   - KEEP: local constraints the code can't show (why a tie-break is total, why a
     value is clamped, a non-obvious unit), module-top one-paragraph purpose
     statements, genuine APPROXIMATION/LIMITATION notes.
   - Heuristic (ratified): **a comment that cites a plan number dies**; if the fact
     it carried still matters, it moves to ARCHITECTURE.md or the module-top
     paragraph, stated timelessly.
2. **Invariants get one home.** ARCHITECTURE.md §12 is the list; each item points at
   the test/assert that enforces it (add the few missing enforcement tests found
   during the sweep — e.g. a "generators emit no style props" walk). CLAUDE.md keeps
   only the agent-operational rules and links out.
3. **Docs dedup.** `docs/02-architecture.md` folds into ARCHITECTURE.md (delete after
   folding); `procgen_v3_design.md`/`procgen_explainer.md`/`procgen_v2_ideas.md`
   compress to one `docs/procgen-design.md` (D1–D6 + the city pipeline rationale —
   most of their content is now code or ARCHITECTURE.md); stale roadmap phases in
   docs/03 get a "shipped, historical" banner instead of edits. `waitgen.mjs` and
   other root scratch files are removed or moved under `scripts/`.
4. **State-file hygiene.** PROGRESS.md older than the current arc is archived to
   `review/progress-archive.md`; DECISIONS.md stays append-only (never rewrite
   rulings) but gains a short index header by year-month.
5. **Update the additive-params text** in CLAUDE.md/docs to the 029 policy wording
   (029 §6 owns the substance; A only makes the text agree everywhere).

**Gate (T1):** full fast+fuzz suite + tsc + build green with **zero golden changes**
(the sweep proves itself by not moving a single generated byte). A grep budget:
`grep -rn "plan 0[0-9][0-9]" src/ | wc -l` ends ≤ 10 (from ~hundreds).
**Exit test:** a cold agent given one module (say `growth.ts`) can state its contract
from the module-top paragraph alone; no comment in `src/` cites a plan number except
the ≤10 justified survivors (each with a reason).
**STOP:** any sweep edit that changes emitted bytes or test behavior — revert that
file and flag it; it means a comment was load-bearing (it wasn't a comment).

## 030-B — Test pyramid rebalance: gates shrink to a smoke set (wave 4)

**Prereqs:** 029 §6 (invariant helper + metric bands) DONE; playground shipped.

**Goal.** The expensive live tier covers only what headless tiers cannot: that the
plugin actually boots, paints, and round-trips the vault inside Obsidian.

1. **Headless perceptual goldens.** A `scripts/perceptual.ts` runner renders pinned
   (algorithm, preset, seed, region) tuples through the playground's renderer in
   node (OffscreenCanvas or a tiny node canvas shim) to PNGs under `shots/perceptual/`,
   pixel-diffed with a small tolerance. These are *approved images*: re-accepted
   explicitly alongside a 029 version bump, reviewed by eye at acceptance time. This
   replaces per-feature live screenshots as the visual net. (The docs/04 screenshot
   test itself stays — it is a release judgment, not a per-commit gate.)
2. **Gate audit → smoke set.** Inventory `scripts/gates/*` (~30). For each: (a) name
   what it uniquely proves; (b) if a unit/metric/perceptual assertion now proves it,
   **seed the failure it guards against, watch the replacement catch it, then delete
   the gate** (prove-by-breaking, per gate, recorded in the commit message); (c) what
   remains merges into ≤6 smoke gates: boot+style-load, reconcile round-trip,
   sketch→region→generate→replay (one algorithm), explicit-only (pan generates
   nothing), migration/adoption, exports-write-files.
3. **Board simplification.** With ≤6 gates the health-probe/relaunch machinery mostly
   retires; `npm run board` becomes prologue + smoke set (<5 min target). The
   flake-logging rule survives for the smoke set. `coverage.json`/`gates:changed`
   shrink accordingly.
4. **Tier doc rewrite** (docs/05): T0 unit+tsc · T1 +build+bands+perceptual · T3
   plan-end board (smoke). The playground becomes the documented first stop for any
   visual procgen work.

**Gate (T1 per slice; T3 at end):** the new board green in a fresh process; every
deleted gate has a prove-by-breaking record.
**Exit test:** full board wall-clock <5 min; a deliberately broken generator (bad
containment) is caught at T0/T1 by invariants or bands, never needing a live gate.
**STOP:** any gate whose unique coverage cannot be reproduced headlessly stays —
shrinking is the goal, not zero.

## 030-C — Operators + data: the standing convention (continuous, starts at 030-A)

Not a wave — a ratchet, enforced from the sweep onward:

1. **Rule (goes into CLAUDE.md at 030-A):** a new preset of an existing algorithm
   must be expressible as `params` + existing operators; adding a new operator is
   fine; adding a preset-conditional branch inside a generator stage is not
   (`profile`/`variety`-keyed *data tables* are data, not branches).
2. **City first (it's already 80% there):** finish hoisting the per-profile special
   cases in `citynet/` into the operator + `profiles.ts`-data shape as they are next
   touched — opportunistically, never as a big-bang refactor. Candidate seams the
   axial/rings work already proved: post-growth graph operators
   (`insertPolyline`-based), pre-growth seeding operators, faces-stage ring
   operators (chamfer).
3. **Cross-algorithm library.** When a second algorithm needs an operator the city
   owns (e.g. path insertion for parks), it moves to `src/gen/operators/` with its
   tests; generators import from there. No speculative extraction — move on second
   consumer only.
4. **Registry boilerplate dedup** rides along when next touched: the 7× repeated
   theme→default mapping collapses to one
   `themeDefault({ fantasy: id, clean: id })` helper.

**Exit test (standing):** the next new city-pattern request (there will be one) ships
as a preset whose diff is params/data + at most one new operator file + tests — zero
edits inside grown/faces/parcels stage internals.

## 030-D — Declarative paint: the style contract (wave 5)

**Goal.** A new algorithm (or bucket) needs ZERO per-theme work, and the
silent-gid-drop trap becomes structurally impossible.

1. **Contract type** (pure, next to the registry): per algorithm, one
   `styleContract: BucketStyle[]` where
   `BucketStyle = { gid, mark: "fill"|"line"|"point"|"fill+outline", role:
   SemanticRole, widthFromProp?, dashed?, z: number within the generated group }`.
   `SemanticRole` is a small fixed vocabulary (`water`, `water-edge`, `ground`,
   `vegetation`, `vegetation-deep`, `built`, `built-accent`, `route`, `route-minor`,
   `boundary`, `relief`, `accent`, …) — extending it is a deliberate act, not a
   per-theme color pick.
2. **Themes shrink to role→value maps** (an extension of today's `ThemeTokens`).
   `map/themes/generated/*` per-algorithm layer builders are REPLACED by one generic
   builder: contract × role-map → MapLibre layers, slotted into the `generated`
   z-group in contract order. Hand-written layers survive only for effects the
   contract can't express (neon-sprawl glow casings get an explicit per-theme
   `override(gid)` escape hatch — bounded, enumerable).
3. **One manifest, three consumers:** `tileGeneratorIds` derives from the contract
   (`contract.map(b => b.gid)`), the paint layers derive from it, and a unit test
   asserts every gid a generator can emit appears in it (kills the silent-drop bug
   class). The playground's paint shim is deleted; it renders the contract with a
   canvas interpreter of the same role vocabulary.
4. **Migration proof:** per theme, style JSON before/after must be semantically
   identical for all existing buckets (byte-compare where the builder output is
   stable; else a layer-by-layer property diff script). Pixel spot-checks on the
   preset gallery for parchment + neon-sprawl (the two most hand-crafted).

**Gate (T1 per phase; plan-end T3):** style-diff proof per theme + gallery
screenshots eyeballed + full suite.
**Exit test:** add a dummy `test-bucket` gid to one algorithm's contract with role
`accent`: it paints correctly in all five themes and the playground with a one-line
diff (plus feature emission), and deleting it is equally one-line.
**STOP:** if >3 per-theme overrides are needed for any single algorithm, the role
vocabulary is wrong — stop and redesign the roles rather than accreting escapes.

## 030-E — Documentation reconciliation (final phase, gates the arc's close)

**Goal.** Every document agrees with what the arc actually shipped — measured against
the code, not against the plans' intentions. This phase is deliberately LAST so it
reconciles reality once, after all behavior changes have landed (each wave carries its
own doc touches; E is the closer that catches drift between them).

1. **ARCHITECTURE.md** — re-verify section by section against the code: §5 rewritten
   for versioned determinism (029 as-built, incl. the §5 invariant carve-out), §8 for
   the style contract (030-D — role vocabulary, generic builder, override escape
   hatch), §9 for the new tier table and smoke board, §10's "portability map" updated
   for the contract-driven paint (the renderer contract section changes), §12
   invariants list updated (additive-params law out, version-pin + gid-derivation
   invariants in), playground documented as the standard tuning surface.
2. **CLAUDE.md** — locked-decisions and conventions blocks match the new reality:
   determinism wording (029 §1), gate cadence for the ≤6-gate board, the 030-C
   operators+data rule, the playground in the iteration-loop section. Keep it short;
   link out per 030-A's single-home rule.
3. **docs/** — docs/05 (workflow/tiers/board) rewritten as-built; docs/04 quality bar
   re-pointed at perceptual goldens + metric bands where it referenced live
   screenshots; any doc statement made false by the arc is fixed or deleted, found by
   a full read-through of `docs/*.md`, not by memory.
4. **plans/README.md** — status rows for 029/030 flipped to DONE with commit hashes;
   the superseded-by pointers added where the arc retired older plan machinery
   (e.g. 021's board runner scope → 030-B's smoke board).
5. **DECISIONS.md / PROGRESS.md** — a closing entry per plan (what shipped vs. what
   the plan said, deltas called out); HEARTBEAT checklist updated/retired.
6. **Playground usage note** — a short `playground/README.md` (run, controls, what the
   shim is, how 030-D replaced it) so the tool survives its authors.

**Gate (T1):** no code changes in this phase (docs-only diff); a full read-through
checklist in the commit message listing each doc visited with "changed | verified
current". **Exit test:** a cold-start agent onboarding from ARCHITECTURE.md + CLAUDE.md
alone follows the documented tuning loop (playground → bump → re-golden → bands →
smoke board) end to end without hitting a single stale instruction.
**STOP:** if reconciliation uncovers a behavior/doc conflict that needs a code change,
the code change goes back to its owning wave's follow-up — never smuggled into E.

## §Done criteria for the whole arc

- Tuning loop: playground knob → judgment in <1 s; shipping a retune = version bump +
  re-golden + bands green (no byte-neutrality analysis) — 029 §9.
- New algorithm checklist = generator + registry entry (schema/presets/contract) +
  tests; zero theme edits, zero new gates, zero lifecycle code — verified by the next
  real algorithm added after 030-D.
- Full board <5 min; `src/` comment volume roughly halved with zero behavior change.
- 030-E complete: every doc reconciled against the as-built code (the arc is not done
  when the last feature lands — it is done when the documentation says what shipped).

# Plan 038 — Coupling edges wave 2: flavor & quality couplings

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §2 (Jonah 2026-07-14).

**Depends:** 037 (wave-1 wiring + payload), 036 (terrain field, for the terrain-reading items).
**Read first:** research report §2 — this plan is its remaining [N] rows; items are independent
of each other and may land in any order, each behind its own algorithm version bump (029 policy).

## 0. Context for a cold-start implementer

Wave 1 (037) fixed correctness; this wave buys legibility — the "one world, not independent
stamps" reads. Every item follows the same recipe: read an upstream (channel SDF / terrain field /
settlement payload / sketch adjacency), version-bump the consumer, re-golden, prove byte-identity
when the upstream is absent, keep 033's harness green. Playground-first judgment (`npm run
playground`, contact sheets); Obsidian only for final paint sanity.

## 1. Scope (independent items, suggested order by payoff)

1. **Waterfront cities:** bank-tangent street alignment near the channel (blend the bank tangent
   into the tensor field, `fabricAngleSampler` precedent, falloff ~100–200 m) + building-only bank
   setback (streets/quays still hug the bank). City bump.
2. **Riverine farmland:** long-lot strips perpendicular to the bank within ~1–2 field depths
   (Quebec rang / arpent pattern); water-meadow tag in the riparian band (theme paints it).
   Farmland bump.
3. **Tributary rank:** deterministic Strahler-ish rank from spine topology (sketch-only, same-stage
   legal): tributary mouth width ≤ main local width, main width step-up below junctions,
   junction-angle nudge toward 45–75°. River bump.
4. **Terrain-reading vegetation/agriculture (needs 036):** forest relative-elevation timberline +
   conifer-upslope variety bias + contour-sag canopy; farmland slope-gating (steep ⇒
   untilled/pasture) + contour-oriented strips on moderate slopes; park pond anchored at the local
   low point. Forest/farmland/park bumps.
5. **Road-sketch promotion in cities:** in-region sketched-road segments become arterials with
   frontage/ribbon lots; road×inset-ring crossings force gates (extend the existing
   gate-at-crossing hit set). City bump.
6. **Adjacent districts (same-stage, hashed agreement):** where two district rings share an edge
   within ε, both sides independently hash the shared-edge geometry to derive 1–3 matching
   arterial-grade stubs/gates meeting bit-exactly on the edge. City bump.
7. **Forest ↔ farmland/park sketch adjacency (symmetric):** shared-boundary hedgerow/woodland-bank
   line, canopy-rim fade against farmland, hedging bias; park↔forest canopy continuity. Forest/
   farmland/park bumps (can share #2/#4 bumps if co-landed).
8. **Wall water refinements:** moat-end snap to the bank (leat junction), water-gate feature where
   the spine crosses a channel/canal (consumes 037's payload `canalLines`). Wall bump.

Deferred beyond this plan (report [?] rows): `river-mouth` harbor wards, city→world-route gate-stub
termination, typed location pins (plan 039), city grading default-on.

## 2. Verification (per item, headless — NO live gates, per Jonah 2026-07-14)

Fixture goldens + metric bands per bumped algorithm (e.g. street-angle-vs-bank-tangent correlation;
strip-orientation-vs-bank; junction width monotonicity; timberline-density-vs-relative-elevation);
no-upstream byte-identity; 033 harness green; hashed-agreement items get the seam-style test (both
regions computed independently ⇒ stub endpoints bit-equal). Playground contact sheet per item — no
live checks.

## 3. STOP conditions / risks

- Any item that tempts a reverse or same-stage OUTPUT edge is out — the §2 standing rejections are
  the boundary (no vegetation←settlement, no river→lake mutation, no whole-network solve).
- Items are independent by design: if one stalls, ship the rest; do not serialize the plan on its
  hardest item.

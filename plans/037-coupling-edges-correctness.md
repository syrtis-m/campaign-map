# Plan 037 — Coupling edges wave 1: wire the declared/correctness edges

**Status:** TODO. Ratified via `plans/research-generation-pipeline.md` §2 (Jonah 2026-07-14).

**Depends:** 034 (upstream threading through the unified pass), 035 (stage positions; the
`settlement` payload consumers). 036 NOT required. **Read first:** research report §2 (the matrix —
this plan is its [W] column plus the correctness-class [N] rows); `src/gen/upstream.ts`;
`src/gen/citynet/skeleton.ts` (`SkeletonOutput.ring/gates`).

## 0. Context for a cold-start implementer

The registry has declared consumption the generators never wired (forest/park "consume water",
wall "consumes settlement") — visible wrongness follows: turn up a river's windiness and trees
stand in the new meander; a wall around a generated city has gates only where the GM happened to
sketch a road. This plan wires the edges whose absence is a *correctness* problem. Each edge is a
generator change ⇒ its own algorithm version bump + goldens (029 policy); consumers must stay
byte-identical when the upstream is absent (the 23-E no-field discipline). Update `consumesSketch`/
`consumes` declarations in lockstep — 033's harness enforces honesty.

## 1. Scope (each item: edge · currency · behavior)

1. **river → forest/park (channel exclusion + riparian):** consume `upstream.water` channel rings
   via the existing rebuild path — no tree/canopy/path/lawn geometry inside the channel; riparian
   density ramp within ~4–6 channel widths (forest); pond placement avoids the channel (park).
   Forest + park version bumps.
2. **river → farmland (channel exclusion):** add `water` to farmland's consumes — no field/lane
   geometry across a channel. (Long-lot orientation is wave 2 flavor — plan 038.)
3. **vegetation → city (growth cost):** wire the declared edge — canopy distance as a street
   growth-cost multiplier + parcel rejection in dense canopy. NEVER clip canopy (standing
   rejection: the town reads as a clearing via paint order). City version bump.
4. **city → wall (`settlement` payload):** define and emit the payload from citynet —
   `{ ring, gates[], arterialCrossings: {point,bearing,class}[], canalLines[], stubs[] }` (all
   already computed in `skeleton.ts`) — and consume it in the wall: gates where generated streets
   actually cross the spine (min-spacing merge, street-class precedence), gatehouse axis = crossing
   street's bearing, towers face outboard, moat side = away from the town interior; moat/masonry
   gap over water (sketched water + generated channel — the river-is-the-moat case). Wall version
   bump.
5. **nested region → outer city (hole-with-frontage):** the outer city treats any CONTAINED
   region's sketch ring as a hole — no streets/blocks/parcels inside, perimeter frontage street
   allowed, entrance points hashed on the inner ring (tile-seam pattern). Sketch currency,
   uniform for park-in-city and district-in-district; never read the inner region's OUTPUT.
   `blockedByWater`-shaped predicate in `fabricConstraints.ts`. City version bump (can share #3's).

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

- **37-A (river → vegetation/farmland):** windiness-bump fixture ⇒ zero trees/fields intersect the
  new channel; riparian ramp visible in playground + metric band (density-vs-bank-distance
  monotone); no-upstream byte-identity per consumer.
- **37-B (vegetation → city):** street density inside canopy < outside (metric band); no canopy
  vertex moved by any city run (assert forest output untouched).
- **37-C (settlement payload → wall):** wall around a generated city gains gates exactly at
  arterial crossings (fixture assertion on positions/bearings); wall with no settlement in reach
  byte-identical to today; moat gaps over channel.
- **37-D (nested holes):** park-in-district fixture ⇒ zero city geometry inside the inner ring,
  frontage street present, entrances deterministic under re-runs; citadel (district-in-district)
  same rule — proves the same-stage case needs no output read.
- All: goldens re-accepted per bumped algorithm; 033 harness green against updated declarations;
  playground contact sheets for the visual judgment (no Obsidian, no live checks).

## 3. STOP conditions / risks

- An edge whose consumer cannot stay byte-identical with the upstream absent is mis-designed —
  stop and rework (this is what keeps adoption optional per 029).
- The nested-hole rule must not regress the outskirts suppression ("ring = land claim") — farmland/
  forest rings suppress, contained rings hole; both are sketch reads, keep them distinct.
- Resist adding flavor extensions mid-plan (bank-tangent streets, long-lots, tributary ranks) —
  they are plan 038, sequenced after so wave 1 stays reviewable.

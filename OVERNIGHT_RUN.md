# OVERNIGHT RUN — pipeline arc 031→039 (2026-07-14)

Autonomous run per Jonah's goal: implement plans 031–039, parallelize with opus subagents,
build a new overlap-focused test map, commit+push continuously. Everything needing Jonah's
eyes lands HERE. Newest items at the top of each section.

## Ground rules in force
- **NO live Obsidian gates** (Jonah 2026-07-14) — all verification headless (Vitest, FakeHost
  counters, goldens, metric bands, fuzz); visual judgment via playground contact sheets.
- Commits per green phase on fast suite + tsc + build (+fuzz when generator behavior changed);
  explicit-path staging only (shared checkout — a parallel session has
  `review/v29-needs-adoption-panel.png` modified; untouched by this run).
- Vespergate untouched; the new test map is its own campaign (`dev-vault/Campaigns/Overlap`).

## Scope interpretations (flag if wrong)
1. **Plan 039**: the plan file says FUTURE ("do not schedule without a fresh ruling"), but the
   goal explicitly says "031 through 039" — I'm treating the goal as the fresh ruling and
   shipping **§1.1 only** (market-pin → plaza snap), per the plan's own "ship §1.1 first and
   alone". Temple/gate variants stay deferred.

## NEEDS JONAH'S EYES
- **Overlap campaign eyeball pass**: open `dev-vault/Campaigns/Overlap` in Obsidian (or view in
  the playground) and judge the generated result on the 8 overlap scenarios. Regenerate the
  campaign any time with `npx tsx scripts/emit-overlap-campaign.ts` — never hand-edit.
- **Wall-on-ring design call** (Overlap S2): the test wall traces the district ring exactly
  (offset 0) because any outward offset would cut the adjacent district / farmland shared edges;
  along the shared south edge the wall coincides with Newquarter's north boundary (old-wall/
  faubourg reading). Flag if plan-037 gate work wants a cleaner separation fixture instead.

## Landed
- **Overlap test map** (`41f5790`): `src/gen/testkit/overlapMap.ts` — 9 deterministic scenario
  builders (S1 river×district, S2 wall-on-ring, S3 forest×river, S4 farmland shared-edge +
  downstream river, S5 park-in-district, S6 ε=0 adjacent districts, S7 mountain/farmland/river
  litmus, S8 typed `market` pin + untyped boundary pins) with premise-asserting tests (17) +
  emitted `dev-vault/Campaigns/Overlap` campaign. Seeds = `hashSeed(7341, featureId)`; procgen
  versions read from registry `currentVersion` at build time (a future bump changes emitted
  bytes visibly — re-emit + eyeball is the intended response).

## Deviations / STOP conditions hit
_(none yet)_

## Flakes / environment notes
_(none yet)_

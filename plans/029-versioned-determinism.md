# Plan 029 — Versioned determinism: freedom between versions, byte-stability within

**Status:** POLICY RATIFIED (Jonah, 2026-07-14). Mechanics (§3–§6) execute as wave 3 of
the rearchitecture arc — after plan 030 phase A (the comment/doc sweep) and after the
in-flight 026–028 HEARTBEAT waves complete. Do not start §3+ before then.

## §0 Cold start — intent, and the pitfalls that shaped this plan

**Intent.** "Determinism is sacred" has been interpreted as *byte-eternity*: every code
change must leave every existing region byte-identical (the additive-params rule, the
frozen `world/heightmap.ts` noise, golden tests that break on a reassociated float
add — the 23-A lesson). That discipline made the cache design trustworthy, but it taxes
exactly the activity we most want to speed up: **tuning**. Retuning a meander curve or
a growth constant today requires proving byte-neutrality or accepting that every
existing campaign silently re-rolls.

The product requirement is narrower than the implementation: **a GM's existing regions
must not visibly change without consent.** This plan replaces implicit byte-eternity
with an explicit, per-region **version pin** and a consent gate:

> Same `(seed, params, algorithm version)` ⇒ same bytes, forever (per machine).
> Between versions, generator authors are free. A region renders at its pinned
> version until the GM adopts the new one.

**What this plan is NOT.** It does not weaken within-version determinism (D1–D6 stay
binding — they are what make *any* version reproducible). It does not add per-version
code forks that live forever (§4 — the code implements the current version only; old
bytes survive via cache + consent, not via legacy code paths). It does not touch the
world tier in v1 (§7).

**Pitfalls for a cold-start agent:**
- `procgen.version` already exists in `ProcgenBlockSchema` (`model/fabric.ts`) but has
  meant "params schema version." §3 redefines it as the **generator contract version**
  (params semantics + output bytes, one number). All persisted blocks today say `1`,
  and every algorithm's current contract is defined as version 1 — so the redefinition
  is a no-op on existing data. Do not add a second version field.
- The fingerprint (`gen/cache/fingerprint.ts`) already folds in `version` via the
  procgen block — verify, don't re-add.
- "Deleting `.mapcache/` is harmless" (CLAUDE.md) gets a precise carve-out (§5). Do
  not silently drop the invariant; re-state it in CLAUDE.md as part of §6.
- `dev-vault/Campaigns/Vespergate` is Jonah's real campaign. The migration/adoption UX
  gates (§8) must leave it byte-intact unless the gate explicitly exercises adoption
  on a name-tagged fixture region.

## §1 The policy (ratified — this section is the ruling)

1. **Within a version: byte-determinism, D1–D6 binding, unchanged.** Same durable
   inputs ⇒ same bytes on the same machine, forever.
2. **Between versions: freedom.** A generator change that alters output bytes for the
   same `(seed, params)` MUST bump that algorithm's version — and then needs no
   byte-neutrality argument, no additive-default contortions, no golden archaeology.
3. **Prefer params over versions when cheap.** If a change is naturally expressible as
   a new param whose absence reproduces old behavior, ship it as a param (old rule,
   now a preference instead of a law). Version bumps are for retunes and algorithmic
   changes where byte-neutral defaults would distort the design.
4. **Regions pin their version.** `procgen.version` is written at creation from the
   algorithm's `currentVersion` and never changes implicitly. Vertex edits, param
   edits, re-rolls: version keeps its pinned value (they regenerate at the pinned
   version *if supported*, see §4).
5. **Adoption is explicit GM consent.** Upgrading the plugin never visibly changes an
   existing region on its own. The GM adopts per region (or campaign-wide) via an
   explicit action, which rewrites `version` and regenerates.
6. **The additive-params LAW is repealed; goldens become per-version.** Structural
   invariants + metric bands become the primary regression net (§6); byte-goldens
   assert only "current version, same bytes."

## §2 What this buys (why the tax was worth removing)

- Tuning a generator = edit + bump + re-golden. No byte-safety essay, no DECISIONS
  argument about reassociated adds, no `?? legacy` default threading.
- The playground (shipped 2026-07-14, `playground/`) becomes a *shipping* tool, not
  just an exploration tool: what you tune there can land.
- ~Half the defensive comments and a large class of DECISIONS entries become
  mechanical ("bumped river to v3") — feeds plan 030 phase A's sweep.

## §3 Mechanics — the version plumbing

- **Registry:** each `ProcgenAlgorithm` gains `currentVersion: number` (all start at
  1, matching every persisted block today). `generate` keeps its signature; the
  version is host-side routing data, never a generator input (D6 — a generator never
  branches on version; the *code* is the version).
- **Creation:** the host writes `version: algorithm.currentVersion` into new procgen
  blocks (today it hardcodes the schema default 1).
- **Fingerprint:** already includes the block (verify with a test: two records
  differing only in `version` ⇒ different fingerprints).
- **Params schema evolution** rides the same number: a version bump MAY change param
  semantics/defaults together with output. The registry entry documents, per bump, a
  pure `migrateParams(oldVersion, params) => params` used at adoption time (identity
  when nothing changed). Zod schemas validate the CURRENT shape only; a pinned
  older region's params are parsed leniently (unknown keys pass through — they only
  feed the pinned cache's fingerprint, never current code).

## §4 Mechanics — rendering pinned regions without legacy code forks

The code implements ONLY `currentVersion`. A region pinned to an older version:

- **Cache hit (the normal case):** its cached bytes render as-is. The fingerprint
  matches (version is part of it), so replay serves them untouched. A pinned region is
  effectively *frozen output* — which is exactly the consent semantics we want.
- **Regeneration demanded** (cache deleted, vertex/param edit, constraint edit,
  cascade invalidation) **while pinned below `currentVersion`:** the host prompts —
  "This region was generated by an older version of the ⟨river⟩ generator. Editing it
  will re-render it under the current version." Proceed ⇒ adopt (migrate params, set
  `version = currentVersion`, regenerate, log `sketch-procgen-set` with before/after).
  Decline ⇒ the edit is cancelled, cached bytes keep rendering.
- **Cache missing AND the GM declines** (fresh machine + old region, the rare corner):
  render nothing for that region + a persistent badge "needs adoption" — never
  silently regenerate at a different version. (Cache never syncs, so a second machine
  hits this on first open of a shared campaign with pinned-old regions; the badge
  makes the state visible instead of wrong.)
- **Adopt-all:** one campaign-level action ("Update all regions to current
  generators") for the GM who just wants the new look.

This is the load-bearing simplification: **consent is enforced by the cache + a
prompt, not by maintaining old generator code.** No version forks accumulate.

## §5 The invariant carve-out (CLAUDE.md edit, part of §6)

"Deleting `.mapcache/` is harmless" becomes: *deleting `.mapcache/` is harmless for
every region at `currentVersion` (byte-identical regeneration, per machine). Regions
pinned to older versions require adoption before they can re-render — the map makes
that visible (badge/prompt); it never silently substitutes different bytes.*

## §6 Test-net conversion (the other half of the mechanics)

- **Structural invariants** (survive any version): containment inside ring/corridor,
  planarity, closed rings, mm quantization, canonical sort order, determinism
  (generate twice ⇒ identical), 2×2 seam identity via clip. Extract into a shared
  `expectGeneratorInvariants(features, region)` helper every generator suite calls.
- **Metric bands** (survive tuning, catch regressions): generalize the
  `citynet/metrics.ts` pattern — each algorithm gets a small pure metrics module +
  banded assertions (already exists for city; add river sinuosity/width, forest
  cover/clearing fraction, park path/land shares, wall tower spacing). Bands are the
  tunable safety net; bytes are not.
- **Byte-goldens shrink to one per algorithm** ("current version reproduces the
  committed fixture") and are *expected* to be re-accepted on a version bump via an
  explicit `npm run goldens:accept -- <algorithm>` script that regenerates fixtures
  and prints a diffstat (never auto-accepted in CI/board).
- CLAUDE.md + docs/05: replace the additive-params rule text with the §1 policy;
  document the bump/re-golden/adopt flow as the standard tuning loop.

## §7 Scope cuts (v1)

- **World tier stays frozen.** `world/heightmap.ts` and the per-tile world generators
  have no procgen block to pin a version on; versioning them needs a manifest-side
  pin and is deferred until world-tier work resumes. The freeze note stands.
- No per-version code paths, ever (see §4) — if a future need genuinely requires
  reproducing old bytes from code, that is a new plan, not a loosening of this one.
- No UI beyond the prompt + badge + adopt-all.

## §8 Phases + gates (execute as wave 3; T1 per phase, board at plan end per cadence)

- **29-A — plumbing + fingerprint proof.** `currentVersion`, creation-time write,
  fingerprint version test, lenient parse of pinned params. Unit-only. Gate: fast
  suite + a new `version-pin` unit family.
- **29-B — adoption lifecycle.** Prompt-on-edit, decline-cancels, adopt-all command,
  needs-adoption badge, mutation-log entries, headless test-API twins
  (`adoptRegionForTest`, `adoptAllForTest`). Live gate (`scripts/gates/version29.ts`):
  seed a fixture region, simulate a bump (test-only `currentVersion` override), edit ⇒
  prompt path adopts + regenerates; decline path keeps bytes; cache-delete + decline
  shows badge, paints nothing for that region; Vespergate byte-intact.
- **29-C — test-net conversion.** Invariant helper, metrics modules + bands for
  river/forest/park/wall/farmland/mountain, golden shrink + `goldens:accept` script,
  CLAUDE.md/docs edits. Gate: full fast+fuzz suite green; a deliberate dummy retune of
  one constant behind a version bump goes through the whole loop (bump → re-golden →
  bands still green → adoption gate passes) and is then reverted.

**STOP conditions:** any ambiguity about whether a change is params-vs-bump territory
in a real case → flag to Jonah with the concrete diff, don't guess. Any need to keep
old generator code → STOP (violates §7).

## §9 Exit test

Retune a river constant (any visible meander change): commit it with a version bump in
one sitting — no byte-neutrality analysis. An existing campaign opens unchanged
(cached bytes, no prompt). Editing that river prompts; adopting regenerates under v2
deterministically (delete cache ⇒ same v2 bytes). Declining keeps the old look.
`npm test` green throughout without touching any unrelated golden.

# Tier B — phase3 canonize gate checks are racy (test hygiene)

**Status:** known flaky TEST checks, not a product bug. Background task filed.

Two checks in `scripts/gates/phase3.ts` fail intermittently (pass on a fresh run,
fail on reruns in the same session):
- "canonize-nearest-generated … strips from cache+view" — races the Phase-4
  viewport dispatcher, which continuously re-fetches generated tiles from cache
  after the canonize strip.
- "regenerate-city-here after canonize … canon survives" — the previous check's
  async canonize note-creation (vault change → debounced rescan → index update)
  lands during this check's baseline read, misattributing the +1 to regenerate.

Both are render-independent (confirmed: they fail regardless of the constant-dot
change). The canonize logic itself is correct; the checks need to quiesce the
dispatcher, settle the index baseline, and clean up the canon notes they create
(they currently accumulate `<Name> 2.md` duplicates in the Ashfall dev-vault).

**Awaiting:** the filed hardening task (quiesce dispatcher + settle baseline +
cleanup) → phase3 should be a stable 14/14.

# phase3 canonize gate checks — RESOLVED (2026-07-10)

**Status:** RESOLVED. Phase 3 is a stable 14/14.

The two phase3 canonize checks were flaky (12/14 on reruns). Root-caused with a
discriminating live test rather than assumed: generated world fabric, captured a
specific settlement's feature id + name, canonized it, and verified — canonize
returned true, the index grew by 1 (note created), and the specific feature **id
was stripped** from the generated fabric. So the canonize LOGIC is correct; the
checks were unsound:

1. The "still present" check filtered by **name**, but generation is
   deterministic and the Phase-4 dispatcher continuously loads other tiles'
   settlements (which can share a name) into the global `generated` getter during
   the async window. Fixed: assert the strip by feature **id**.
2. The check jumped to **zoom 8** to canonize — but zoom 8 is the *city* band, so
   the viewport dispatcher evicted the world settlement before the canonize
   command ran. Fixed: canonize at the settlement's own world band (zoom 5).
3. The regenerate check's index baseline was read while the previous check's
   async note-creation was still landing, misattributing the +1 to regenerate.
   Fixed: `settleIndexSize()` polls until the index is stable before both checks.

No plugin code changed — the fixes are all in `scripts/gates/phase3.ts`.

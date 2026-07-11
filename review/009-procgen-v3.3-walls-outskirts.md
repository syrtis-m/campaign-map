# v3.3 — cityness, outskirts, walls/gates (Tier B review)

**Screenshots:** `review/v3.3-vespergate-walls-outskirts.png` (city framed),
`review/v3.3-vespergate-ribbon.png` (southern rim close-up).

**Tier A:** 11/11 live (`scripts/gates/procgen33.ts`) + Vitest: ring closed
exactly with 5 gates each within 0.02 m of both ring and arterial; density
bands monotonic (0.0548 → 0.0027); ribbon footprints only within 40 m of
arterials beyond the growth extent; fields beyond them; fuzz (walls +
outskirts on) zero-throw; pipeline ~198 ms; delete-cache replay
byte-identical live.

**What to look at:** the generated wall ring hugs the dense core *inside*
your sketched city wall — two walls read as "old town wall + outer
earthworks", which I find plausible, but it's your city: if a domain
founded inside a sketched wall should SKIP its own generated wall, that's
a one-line profile/constraint rule — say the word.

**Other questions:**
1. Gate dots (stone hue, 3 px) — enough presence, or want gatehouse
   footprints?
2. Farm-field wash (park hue at 0.12 opacity) — read as farmland?
3. Cities now end with countryside rather than a hard rim — the `edge`
   thresholds were raised for it (DECISIONS); eyeball whether the core
   feels too small at radius 900.

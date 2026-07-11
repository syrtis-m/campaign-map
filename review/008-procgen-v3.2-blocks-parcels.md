# v3.2 — faces → parcels → footprints + wards (Tier B review)

**Screenshots:** `review/v3.2-vespergate-blocks.png` (whole city framed —
the money shot), `review/v3.2-vespergate-parcels.png` (20 m scale: lot
hairlines + street-facing footprints).

**Tier A:** 12/12 (`scripts/gates/procgen32.ts`) + Vitest gates: quad share
63% (<70%), footprint-frontage alignment 0.07° (<15°), 200-domain fuzz
zero-throw with Stage C on, delete-cache replay byte-identical, "clip-only
neighbor tile = 0 generator executions" (proves the legacy cutoff AND
one-network-per-domain), pipeline ~160 ms at radius 900.

**Product-level change made from screenshot review (DECISIONS 2026-07-11):**
founding a domain now generates the WHOLE disc (every overlapping tile) in
one click — the earlier one-tile paint read as a rectangular window into a
city. Undo still steps tile-by-tile.

**Questions for Jonah:**
1. **Genre test:** blocks-framed shot — medieval city in 3 s? (My eye: yes.)
2. **Building-detail LOD:** footprints reveal at overview+4, parcels at
   overview+5 (relative, like label focus). If your "everything visible at
   every zoom" ruling should extend to generated building detail, say so —
   it's two `setLayerZoomRange` calls to remove, at a paint-perf cost
   (~12 k tiny polygons per city).
3. **Contrast at street zoom:** parcel hairlines + footprint fills on
   ink-soot are subtle (deliberate — lot lines shouldn't shout). Enough?
4. ~13 small unfilled pockets per city where faces wrap dead-end spurs
   (counted, skipped). Visible only if you hunt; fix queued behind v3.3's
   court-capping if it bothers.

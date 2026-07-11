# v3.0 — domain skeleton (Tier B review)

**Screenshot:** `review/v3.0-vespergate-skeleton.png` (Vespergate, ink-soot,
euro-medieval domain radius 900 m founded at [0, 2]).

**What to look for (design §9 v3.0 gate e):** the town should read as
*shaped* — radial arterial spokes converging on a plaza, the River Vesper
*crossed* at discrete bridge points rather than smeared along, waterfront
quays hugging the bank. All present in the shot. Tier A was 13/13
(`scripts/gates/procgen30.ts`), including delete-`.mapcache/`-replay
byte-determinism, live.

**Questions for Jonah (none blocking):**
1. Arterial contrast at overview zoom — arterials render via the fabricRoad
   hue with a 1.8× width step; at the domain-framing zoom they're visible
   but quiet against ink-soot. Enough, or should `arterial` get its own
   theme token when the class→width ramps get their real pass (v3.4)?
2. The plaza polygon at the center is small (~40 m) and reads as a green
   patch only when zoomed to street level. Fine for now?

**Known cosmetic item (deferred to v3.1):** `clipNetworkToTile` can emit
zero-length street parts at tile corners (a 2-point LineString with
identical quantized coords). Harmless — invisible, deterministic — but
noise in the cache; a min-length filter lands with the v3.1 clip touch.

**Deviation of note (also in DECISIONS.md):** the cost field samples
`heightAt` with the *citySeed*, not the campaign seed (the pure network
contract doesn't carry the campaign seed) — deterministic, but slope
penalties won't correlate with the world-tier heightmap's visible terrain.
Terrain-aware growth beyond `heightAt` is parked by design §10; revisit if
domain terrain alignment ever matters.

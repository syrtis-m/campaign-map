# World-band overview shows biomes — wrong for city-scale campaigns (Nightreach)

**Status:** open finding, content/model question — deliberately NOT paint-fixed. Awaiting a product call.

**Symptom (user-reported):** on Nightreach (neon-sprawl), zooming out across a
narrow range makes the map "disappear messily" — streets at the 2 m scale, near-black
void at 10 m.

**Diagnosed (measured on a freshly-restarted, non-degraded renderer):**
- Nightreach's tiny `scaleMetersPerUnit` puts meter-scale scale-bars at *low* zoom:
  z9 ≈ "2 m" (city band), z7 ≈ "10 m" (world band). The two views **straddle the
  z8 world/city band boundary** (`CITY_BAND_MIN_ZOOM`).
- Below z8 the dispatcher evicts the city tier (streets/districts) and loads the
  world tier. At z7 near the campaign's locations the world tier is **9 polygons,
  all `plains` biome** — one flat blob of `#0d0d11` (neon-sprawl land) on a
  `#0d0d11` page. It renders, but there's nothing to see: no coastline, no biome
  variation, no routes generated near those dots.

**Why it's not a paint tweak:** the world band is doing biome cartography (land/
ocean/coast + settlements + routes) — correct for a **fantasy world** like Ashfall,
but a **city-scale** campaign (Nightreach, London) has no meaningful "biome
overview." Its zoomed-out view should be something else — the city's district
massing, an arterial road skeleton, or simply not zooming out past the city extent
at all. A neon edge-stroke on plains|plains boundaries would just draw noise.

**What WAS fixed this session (layer-only, low-risk, verified clean):**
- City-street `line-width` now has a ~1px floor (was interpolating to 0.5px at z10,
  going sub-pixel and vanishing on the dark base as you zoomed out).
- City-district `fill-opacity` 0.05 → 0.09 so districts read as a persistent city
  fabric when streets get small. (Kept flat/low — a heavier/outlined version washed
  the whole viewport purple when zoomed into a block.)
These make the **city band** continuous. They do NOT and cannot fix the world-band
emptiness above.

**Options for the real fix (needs a product decision, likely a spike):**
1. Per-campaign "kind" (world vs city): city campaigns get a city-appropriate
   zoomed-out overview (district massing / road skeleton) instead of biomes, and/or
   clamp how far out they zoom.
2. A soft band-handoff in `dispatchViewportTiles` (keep the coarse tier resident +
   cross-fade) — but this is optional polish and only helps if the world tier has
   something worth showing; on its own it just delays the void by one zoom notch.
   Deliberately NOT attempted here (load-bearing eviction logic; high regression risk).

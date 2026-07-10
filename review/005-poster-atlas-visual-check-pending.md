# Poster/atlas render — content bug found + fixed (2026-07-10)

**Status:** RESOLVED for poster; atlas uses the same fixed render path.

Initial live export produced a title cartouche over a BLANK map — the offscreen
`renderPoster` map was built from a style with empty geojson sources and never
received the campaign's data. Fixed with `MapView.buildExportStyle()`, which
bakes the current canon / generated / connection FeatureCollections into the
style's `sources[*].data` before the offscreen render. Re-exported and
eyeballed: the poster now shows all canon dots (constant size), labels, and the
point-crawl connection line. The Phase 5 gate's file-write check passed even
while blank, so it was too weak — visual inspection caught it.

**Still worth Jonah's eyes (not blocking):**
- Atlas PDF cover uses the same (now-fixed) render; the multi-page gazetteer
  layout (pdf-lib text pages) hasn't been visually reviewed in a PDF viewer.
- Poster/atlas over a handcrafted theme + a real-city (London) basemap not yet
  eyeballed.
- The Phase 5 gate should be strengthened to assert export *content*, not just
  that a file was written (e.g. a minimum byte size, or an offscreen feature
  count) — noted as a gate-hardening follow-up.

# Arc 021–028 — morning-read digest (2026-07-14)

**The whole HEARTBEAT checklist is done**: plans 021–025 + the 026–028 visual
overhaul, 30 boxes, every phase committed on a green T1 gate, four plan boards
run (022: 16/16 flake-adjusted · 023: 25/27 → all standalone-green + one gate
fixed · wave-2: 26/30 → all standalone-green · 024: 33/33 effective · 025:
30/33, the three known flake classes). Fast suite grew 314 → 832 tests.
`.lastgreenboard` = the plan-024 board commit (the 025 board's three fails are
the documented flake classes; you called the visual close live).

## Look at these first
- `review/gallery/_contact-sheet.png` — the 12-preset street-pattern catalog
  (euro-medieval / continental / na-grid / na-suburb / superblock / tartan /
  ward-grid / eixample / haussmann / baroque-axial / canal-rings / radial-star).
- `review/vo-w2-canopy-*.png` + `review/vo-w2-glyphs-*.png` — the forest
  before/after story (organic canopy + real tree glyphs).
- `review/vo27-park-japanese.png` — organic pond, circuit, lanterns, raked court.
- `review/v4.12-terrain-3d.png` — pitched 3D terrain over a sketched mountain.
- `review/cascade24b-before/after.png` + `review/c24c-straight/windy.png` —
  the cascade working (mountain edit → terraces; river windiness → city adapts).

## Decisions that need your eyes (full detail in DECISIONS.md, same dates)
1. **River `slopeSensitivity` defaults ON** (23-E): legacy rivers crossing a
   sketched mountain adapt on their next regenerate. Flip to 0-default if that
   surprises anyone.
2. **28-B amplitude saturates** once the R_c≥2W clamp binds (~windiness 0.5):
   the slider's top half now adds skew, not amplitude. Suggested fix if wide
   rivers should wind more: width-relative lens amplitude.
3. **Canon still excluded from cache fingerprints** (24-A; plan-024 OQ#3 —
   your call whether canon edits should invalidate fabric).
4. **Preset dropdown kept flat at 12 presets** (025 OQ#2) — grouping/thumbnail
   UX reserved for you.
5. **Contour text labels deferred** (23-C OQ#1 — props emitted, paint-only add).
6. **Aesthetic flags**: confluence gusset reads blocky at close zoom (numerically
   exact); eixample chaflán is low-contrast on unfilled obsidian-native blocks
   (a block-filling theme would fix it); dark-theme mountain relief is subtle
   (parchment reads classic); farm stack paints below city (deliberate).
7. **Perf owed**: Surface-Pro CPU-throttled numbers for the SDF glyph symbol
   layers (26-C measured ~52 fps p95 on the unthrottled dev machine) and the
   DEM tile fill (default-OFF feature).

## Open repair chip
- **procgen48 fixture seed** (task chip): the farmland gate's city fixture
  derives its seed from a timestamp id, so runs occasionally grow too few
  outskirt fields to test suppression. This one class caused most of the
  arc's gate noise (also procgen49 (c)/(g)); pinning fixture seeds is the
  single highest-leverage gate-infra fix. (procgen46's chip was fixed in
  77c3bdb — gate rot, not a regression.)

## Real bugs found & fixed along the way
- `rebuildTheme` missed `refreshGeneratedSource` — a css-change under
  obsidian-native blanked ALL generated fabric (found by 27-C's new gate check).
- `clipNetworkToTile` had no MultiPolygon branch and dropped polygon holes
  (26-B canopy would have silently vanished from tiles).
- 23-B field scale: region-derived scale broke edit-locality to 13% — caught
  live, fixed to absolute-world constants.
- 23-E rcCap pinning: λ-stretch was cancelling slope damping (caught twice).
- maplibre 4.7.1 misrenders hillshade+terrain-mesh together → pitch-adaptive
  toggle (23-D); revisit on MapLibre upgrade.

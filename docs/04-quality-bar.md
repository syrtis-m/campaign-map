# Quality Bar: Why This Will Look Bad, and What Makes It First-Class

*Red-team pass, July 2026. The premise: "yes-and" tools drift toward mess. A map accreted over 30 sessions in 5-second bursts will look like a corkboard, not a Google Maps / atlas artifact — unless the system itself enforces craft. These are the failure modes and the countermeasures. Treat this doc as acceptance criteria.*

## Failure modes (the red team)

### F1. The corkboard problem
Thirty sessions of quick-adds = 200 pins of equal size, colliding labels, a tavern rendered as prominently as a nation. Nothing says "amateur tool" faster than label soup.

**Countermeasure — the map curates itself:**
- Every feature type has an **importance rank**; label size, halo, and collision priority derive from it. GM never sets font sizes.
- **Zoom ranges auto-assigned by type** (nation z2–7, city z5–12, tavern z14+), overridable but never required. The 5-second flow stays 5 seconds; the cartographic discipline is defaults.
- Density governor: past N visible POIs in a viewport, lower-importance labels decay to dots. Google Maps feels calm because it *hides* things; so must we.

### F2. Provenance seams
Sketched fabric and generated fabric of the same kind read as two different tools: a hand-drawn road in one hue and weight, a generated street in another; a sketched lake and a generated ocean in clashing blues. The eye instantly reads "layers of software," not "a map." (The old clause about canon-vs-generated *pins* is obsolete — plan 019's two-layer model means locations are always notes; there is no generated pin to disguise.)

**Countermeasure — one legend per kind, provenance invisible:**
- Sketched and generated fabric of the same kind share the same per-kind theme tokens (`fabricRoad`, `fabricWater`, `fabricDistrict`, …) — a generated road and a sketched road differ in provenance, not legend. Enforced in `generatedLayers.ts`/`fabricLayers.ts` sharing `tokens.ts`.
- Generation is *reactive to* the GM's hand: sketched water/roads/walls/districts feed every generator run as constraints, so generated streets stop at sketched shorelines and align to sketched avenues instead of crossing them at odd angles.
- Generators consume theme palettes and the same feature schema, so generated and manual content are *indistinguishable in render*. Generators must never emit colors or styles — only typed features (already locked in CLAUDE.md; this is why).
- Locations always render above all fabric (the z-order invariant, `layerOrder.ts`) — a pin can never sink under a fill.

### F3. Tile seams and LOD pops
Per-tile deterministic generation is famously prone to streets that dead-end at tile boundaries and biomes that snap at edges; zoom transitions that pop content in look broken.

**Countermeasure:**
- Generate with **halo overlap** (tile + margin, clip to tile) and **hierarchical seeding**: parent tile output (arterial roads, district boundaries) is passed as constraints to child tiles. Streets cross seams because the arterial that spawned them was decided one level up.
- Cross-fade layers on zoom transitions (MapLibre supports per-layer opacity ramps); never hard-pop a detail band in.
- **Snapshot-test seams explicitly**: fixture that renders 2×2 adjacent tiles and asserts edge-touching geometry connects.

### F4. Blank-void mid-zoom
Ungenerated fictional space = empty parchment. Reads as "broken," not "unexplored."

**Countermeasure:** unexplored space is an **aesthetic**, not an absence — per-theme treatments (sepia wash + sparse hatching on `parchment`; smog gradient on `ink-soot`; light gray on `modern-clean`). Base terrain band (coarse landmass/water) generates eagerly for the whole campaign box at creation, so there is *never* a truly empty viewport.

### F5. Name mishmash
Seeded name generators without a shared culture model produce "Grimhold" next to "Zyx'thara" next to "Steve's Tavern." GM-typed names in a hurry make it worse.

**Countermeasure:** **naming cultures as regions** (Azgaar's proven model): each region carries a phoneme/style profile; all generators in that region draw from it. The quick-add flow *offers* three culture-consistent name suggestions (tab to accept) — faster than typing, and cohesion becomes the path of least resistance.

### F6. Programmer-art themes
The biggest risk to "premium feel." A parchment-colored background with default fonts is a Google Maps clone in a costume.

**Countermeasure — where the craft budget goes:**
- **Typography is 80% of map feel.** Per-theme font stacks with real cartographic conventions: letter-spaced small-caps for regions, italic serif for water, weight-by-importance. Open fonts with glyph ranges pre-built for MapLibre (e.g. EB Garamond/Alegreya for `parchment`, Inter/IBM Plex for `modern-clean`, a grotesque + stencil accent for `ink-soot`).
- **Texture and edge treatments:** paper-grain background tile, coastline double-stroke with inner glow (classic atlas), rivers tapering by flow order, `ink-soot` building fills with subtle hatch pattern fills.
- **Map furniture:** compass rose, scale bar, neatline frame, optional graticule — per theme. Furniture is what makes a screenshot look like *a map* rather than *an app*.
- **Color tokens per theme** (≤8 semantic colors); everything — UI chrome included — draws from them. The detail popup in `ink-soot` looks like a case file, not a Material card.
- Accept the ceiling honestly: MapLibre gives "fine stylized vector," not Inkarnate. Within that, typography + texture + furniture carry it.

### F7. Vault pollution (added rev 2 — Obsidian pivot)
The tool now writes into Jonah's actual campaign vault. Failure mode: frontmatter bloat on human notes, orphan geometry sidecars, `.mapcache/` noise in search results, templates/other plugins mangling geometry fields.

**Countermeasure:** frontmatter stays minimal (geometry, type, map, aliases — overrides only on GM insistence); complex geometry in sidecars; `.mapcache/` is regenerable and safe to sync-exclude and search-exclude; Zod validation at reconcile with visible warning badges, never silent drops; the note body is the human's — the plugin never writes below the frontmatter fence.

### F8. Update jank
Naive `setData` refreshes on every edit cause label flicker and re-layout churn — death by a thousand blinks during a session.

**Countermeasure:** stable feature ids + incremental source updates (`updateData`/feature-state where possible); debounce log→source materialization; keep generation and DB in workers (already planned) so the map thread never stutters. `flyTo` with tuned easing for search — motion quality is felt quality.

## The keepsake: "the campaign looked like THIS"

Jonah's actual bar is *the output after a campaign*. That's a product feature, not a style tweak — and the mutation log already contains everything needed:

1. **Poster export.** High-res (300dpi) render of any viewport via offscreen tiled rendering, with map furniture, campaign title cartouche, and optional numbered gazetteer margin. This is the thing that gets framed. (Technique: render map in tiles to canvas at scale, stitch; `preserveDrawingBuffer` for single-screen grabs.)
2. **Campaign replay.** Scrub the mutation log: watch the map grow session by session. Exportable as a short video/GIF. Emotionally, this is the campaign's highlight reel.
3. **Atlas export.** PDF booklet: overview map + per-region spreads + gazetteer (every canonized location with notes, artist PNGs, sigils, session-invented-in). With an artist-heavy table, this becomes the group's shared artifact.
4. **Session paths.** Optional travel-line layer per session (party route), styled per theme — dotted red Indiana-Jones line on `parchment`.

## Acceptance bar (screenshot test)

A cold screenshot of any campaign at any zoom should pass: no colliding labels; no visible tile seams; no blank voids; no default-font text anywhere; unexplored space looks intentional; a stranger can identify the genre from the map alone in 3 seconds.

## Roadmap deltas

- Phase 1: importance ranks + auto zoom-ranges + name suggestions land *with* the quick-add flow (defaults are the discipline).
- Phase 2: theme craft budget (typography/texture/furniture) is explicit scope, not polish; blank-void treatments ship with themes.
- Phase 3: stitching-on-add + halo/hierarchical seeding are generator requirements, snapshot seam tests mandatory.
- Phase 5: poster export moves up to the front of Phase 5; replay + atlas follow.

# Plan 019 — Two-layer model: background things vs. Locations (delete canonization, explicit-only generation)

**Priority:** P0 · **Effort:** L · **Depends on:** none (013–018 merged) · **Model:** any capable

## The correction (user's words)

> "the existing procedural generation loop is crap, and it's a UX issue. the whole
> procedural→canonization is bad and needs to be deleted. instead we need things to
> either be a 'thing on the background' — effectively the way shapes in powerpoint
> work — or a 'Location' which are backed by notes, and can be linked to other
> locations. the locations layer should always be above the 'things on the map'
> layer, and they're separate — things on the map never promote to being locations."

The new core loop (replaces README §"The core loop"):

1. Open a campaign's map (ribbon icon, or *Open map* command).
2. Click empty ground → dropped pin → **+ Add location here** → name it, pick a
   type, done. It's a note in the vault and a pin on the map.
3. Need the surrounding city to look like a city? **Generate fabric here** paints
   procedural streets/districts/coastline around your canon — **only when asked**,
   and reactive to any existing hand-placed things-on-the-map.
4. Want a specific road/river/etc, or to steer what generation does somewhere?
   **Sketch it by hand.**

## Target model

Two content classes, hard-separated:

| | **Things on the map** ("fabric") | **Locations** |
|---|---|---|
| What | Background geometry: roads, walls, rivers, water, districts, parks, blocks, regions, coastline | Note-backed places; linkable (wikilinks, connections) |
| Backing | Sketched → `Fabric.geojson` (durable, synced). Generated → `.mapcache/generated.jsonl` (regenerable) + a durable **generation manifest** | Markdown notes with `map:` frontmatter (+ optional `.geojson` sidecar) |
| Created by | Sketch mode (hand) or *Generate fabric here* (explicit, never automatic) | Quick-add, import, populate-area — always directly as notes |
| Promotion | **Never.** No canonize, no promote-to-note | n/a — they're born as notes |
| Z-order | Below | **Always above** fabric (pins, labels, connections) |

Generation semantics ("PowerPoint shapes, but painted for you"):
- Generation runs **only** on explicit request (toolbar/menu/command). No
  viewport-dispatch, no generate-on-pan. Ever.
- Generated output stays deterministic + regenerable (locked decisions survive:
  `hash(campaignSeed, tileX, tileY, zoom, generatorId)`, JSONL cache, no SQLite).
- What becomes durable is the **request**, not the output: a small manifest of
  "areas the GM asked to generate" lives in the campaign folder (synced). On map
  open, the manifest replays → cache hit or deterministic regenerate → painted.
  Deleting `.mapcache/` stays harmless (release-blocker invariant intact).
- Constraints into every generator run = canon location geometry **+ all sketched
  fabric** (today only canon feeds in; sketch feeds only via the separate
  generate-from-sketch path). Sketch a river, hit regenerate → streets respect it.

## Current state (read before touching)

- **Auto-generation to delete:** `src/view/MapView.ts` `scheduleDispatch()` /
  `dispatchViewportTiles()` (~line 973–1073) — debounced moveend/zoomend viewport
  dispatcher for fictional campaigns, with band-transition eviction, `wantedTiles`
  / `loadedTiles` / `pendingTiles` machinery, and `loadTile()` (~1075).
- **Canonization to delete:**
  - `src/map/generation/generationService.ts` — `canonizeFeature()`,
    `LocationCreator`, `featureAnchorPoint()` (keep `generateTile` /
    `regenerateTile` / `TileGenerator` / `GenerationContext`).
  - `src/view/MapView.ts` — `canonizeGeneratedNear()` (~1150),
    `canonizeNearestHere()` (~534).
  - `src/main.ts` — `canonize-nearest-generated` command (~277).
  - `src/view/CampaignControlModal.ts` — canonize row (~68).
- **Fabric→note promotion to delete** ("things never promote"):
  - `src/vault/fabricStore.ts` — `promoteFabricToNote()`, `FABRIC_KIND_NOTE_TYPE`.
  - `src/view/MapView.ts` — the promote `FuzzySuggestModal` (~line 95) and its
    callers; `src/main.ts` `promote-fabric-feature` command (~310).
  - `src/model/fabric.ts` header comment ("can be promoted…") — rewrite.
- **Explicit generation that survives (reshaped):** `MapView.generateCityHere()` /
  `generateWorldHere()` (~1107/1127), `generateFabricHere()` toolbar action
  (~522), `generate-from-sketch` (plan 014 corridors) + sketch feed-mode toggle.
- **Constraints plumbing:** `MapView.generationContext()` (~907) builds
  `canonFeatures` from the location index only; `GenerationConstraints`
  (`src/gen/types.ts`) has `canonFeatures`, `worldBounds`, naming fields.
- **Layer order** (`src/map/themes/index.ts` `buildThemeStyle`): background →
  basemap → **generated** → connections → session-path → **fabric** → **canon**.
  Canon already tops the stack — phase 4 makes this an asserted invariant rather
  than a happenstance of array order.
- **Named generated POIs:** `src/gen/world/settlements.ts` emits named settlement
  points — the thing that made canonization tempting. See decision D2.

## Decisions (made here; flag to Jonah only if a STOP triggers)

- **D1 — persistence shape:** generation requests → durable manifest
  `<campaign>/Generated.json` (zod-validated, Vault adapter only). Entries:
  `{ id, tier: "world"|"city", tileX, tileY, createdAt }`. Feature output stays in
  `.mapcache/generated.jsonl`. Rationale: keeps "cache is deletable/regenerable"
  and "sync-conflict-immune" locked decisions; the manifest is tiny and
  merge-friendly. (Rejected: writing generated features into `Fabric.geojson` —
  bloats a hand-edited canon file with thousands of regenerable features.)
- **D2 — no more named generated POIs:** drop `world-settlement` from the
  explicit-generate set. Towns/villages are Locations the GM places (that's the
  whole point of the new loop). Regions, routes, coastline/heightmap, streets,
  districts, blocks stay. The settlements generator + naming cultures code stays
  in-tree (populate-area still uses naming), just unwired from generate-here.
- **D3 — populate-area survives:** it creates real notes directly (no promotion
  step), which is exactly the new model. Untouched.
- **D4 — "tweak generated output" = sketch + regenerate**, per the user's own
  framing. No per-feature select/delete of generated shapes in this plan (a
  suppressed-ids overlay can be a follow-up if it's ever missed). What ships:
  *Regenerate here* (re-run against current constraints) and *Clear generated
  fabric here / all* (remove manifest entries + cache records).
- **D5 — terminology:** internal name for things-on-the-map stays **fabric**
  (docs/plans already use it), with two provenances: *sketched* and *generated*.
  User-facing copy says "background"/"fabric", never "canon vs generated".

## Phases

### Phase 1 — Delete canonization & promotion (pure removal)

1. Remove the items in "Canonization to delete" and "Fabric→note promotion to
   delete" above, including: `LocationCreator` plumbing through `main.ts`
   (`createLocationFromFeature` — check for other callers first; quick-add may
   share it), canonize/promote tests in `generationService.test.ts` and
   `locationOps.test.ts`, the promote modal, both commands, the control-modal row.
2. `tileCache.ts`: delete the now-unused "canonize strips feature from cache"
   pathway if nothing else appends partial tiles (keep append/read/clear).
3. Update inline docstrings that cite "docs/02 §5 canonize amendment".

**Gate:** `npm run typecheck` + `npm test` green; `grep -ri canoniz src/` → 0 hits;
`grep -rn promoteFabric src/` → 0 hits.

### Phase 2 — Explicit-only generation with durable manifest

1. New `src/model/generatedManifest.ts` (zod schema, pure) +
   `src/vault/generatedManifestStore.ts` (load/save/add/remove, Vault adapter,
   per-feature-salvage parse like `parseFabric`). Path: `<campaign>/Generated.json`.
2. Delete `scheduleDispatch` / `dispatchViewportTiles` / band-eviction /
   `wantedTiles` and the moveend/zoomend hooks that call them. Keep `loadedTiles`
   as the render store, now fed only by (a) manifest replay on campaign open,
   (b) explicit generate actions.
3. Unify `generateCityHere`/`generateWorldHere` behind one zoom-aware
   `generateFabricHere(point?)` (world tier at overview zooms, city tier closer —
   reuse `bandForZoom`), which: runs generators (worker path preserved), appends
   manifest entry, appends mutation-log entry (`generate-area`), paints.
4. On `setCampaign`/open: load manifest → for each entry `generateTile()` (cache
   hit or deterministic regenerate) → paint. LOD now comes from layer zoom ranges
   (like fabric's `FABRIC_REVEAL_OFFSET`), **not** eviction — world- and city-tier
   content coexist; verify `generatedLayers.ts` zoom ranges make world tiles fade
   as city detail appears, and add ranges if the old band-eviction was doing that
   job.
5. Add *Regenerate fabric here* (force re-run current constraints, same manifest
   entry) and *Clear generated fabric here / Clear all generated* (drop manifest
   entries + cache records + repaint; log `clear-area` for undo/replay).
   Wire into: right-click menu, CampaignControlModal, command palette. Toolbar
   stays declutter-compliant per plan 018 (no new top-level buttons).
6. Drop `world-settlement` from the generate set (D2).

**Gate:** open a fictional campaign, pan/zoom aggressively → **zero** generator
calls (assert via test API counter); *Generate fabric here* → painted; close/reopen
vault → still painted; delete `.mapcache/` → reopen → repainted identically
(snapshot compare); *Clear* → gone and stays gone after reopen.

### Phase 3 — Generation reactive to sketched fabric + locations

1. Extend `GenerationConstraints` (`src/gen/types.ts`) with
   `fabricFeatures: FabricFeature[]` (pure model import — allowed, fabric.ts is a
   zod-only leaf). `MapView.generationContext()` passes the loaded
   `fabricCollection` (transformed to meters).
2. Wire constraints into generators incrementally, per kind, all seam-tested:
   - sketched `water`/`river` → streets/blocks/districts avoid + coastline snaps
     (reuse `clip.ts`);
   - sketched `road` → street network connects/aligns (generalize plan 014's
     corridor elaboration — the `mode: "generate"` special path folds into this:
     every sketched road is a constraint; `mode` field can then be deprecated);
   - sketched `wall`/`district` → generated districts respect boundaries;
   - canon location points already flow via `canonFeatures` — verify streets
     still avoid/serve them.
3. Sketch commit in an area that's in the manifest → prompt-less debounced
   *regenerate affected tiles* (reuse `sketchAutoBuildTimer` pattern from 016) so
   "sketch a river, streets adapt" is one gesture. Only regenerates tiles already
   in the manifest — sketching never triggers first-time generation.

**Gate:** 2×2 adjacent-tile seam tests with a fabric constraint crossing the seam
(mandatory per CLAUDE.md); live: sketch water across a generated district →
regenerated streets stop at the shoreline; determinism: same seed + same fabric →
identical output (snapshot fixture).

### Phase 4 — Z-order invariant + visual coherence

1. Assert layer order in `buildThemeStyle` (and the obsidian-native runtime
   builder in `src/map/theme.ts`): background < basemap < generated-fabric <
   sketched-fabric < connections < session-path < canon/locations < labels. Add a
   unit test over every theme's emitted layer array so a future theme edit can't
   sink pins under fabric.
2. Generated + sketched features of the same kind should read as the same class
   of thing (a generated road and a sketched road differ in provenance, not
   legend). Align `generatedLayers.ts` paint with plan 017's per-kind fabric
   palette via shared tokens; keep the two sources/modules separate.
3. Rewrite quality-bar F2 (docs/04): "provenance invisible" now means
   *sketched vs generated fabric* look alike — locations are always notes, so the
   old canon-vs-generated-pin clause is obsolete.

**Gate:** style-order unit test green across all 5 themes + obsidian-native;
screenshot test per docs/04 on Ashfall + Kanto.

### Phase 5 — Docs, naming, migration

1. **CLAUDE.md locked decisions** (Jonah has re-litigated these himself — this
   plan is the authorization): replace the "Canonizing a generated feature =
   creating its note" clause with the two-layer model; add "generation is
   explicit-only"; add "fabric never promotes to Location". Determinism/cache/
   no-SQLite/themes clauses unchanged.
2. README core loop → the 4-step loop above; remove canonize/promote command
   rows, "Batch canonization" from future-work; docs/02 §3/§5 (delete the
   canonization amendment, document manifest + two-layer model), docs/03 exit
   tests, docs/07 if it mentions canonize.
3. Migration: none required. Existing canonized notes are just notes (fine).
   Existing `.mapcache/generated.jsonl` content is ignored until a manifest
   references those tiles — existing campaigns visually lose auto-generated
   sprawl until the GM explicitly generates, which is the intended behavior
   change. Say so in the README changelog. Dev-vault fixtures (Ashfall, Kanto):
   run one *Generate fabric here* on each to seed manifests for the screenshot
   gates.
4. Remove/repoint any MiniSearch-over-generated-names surface if present
   (`LocationSearchModal` should already be canon-only — verify).

**Gate:** `grep -ri canoniz README.md docs/ CLAUDE.md` → 0 hits (except
plans/ history); full test suite; live loop-test: fresh campaign → add location →
generate → sketch river → auto-adapt → reopen vault → identical map.

## STOP conditions

- STOP if `createLocationFromFeature` removal would break quick-add or import
  paths — untangle callers first, don't fork the write path.
- STOP if generator determinism can't hold with fabric constraints (e.g. a
  generator needs random tie-breaking against constraint geometry) — that's a
  design problem to surface, not to hack around with `Math.random`.
- STOP if manifest replay on open exceeds ~1s for a 20-area campaign on the dev
  box — the worker path or lazy replay needs design, don't ship a frozen open.
- Phases land in order; 1 and 2 may share a branch, 3+ each get their own.

## Status

Track in plans/README.md. Update the row when each phase merges.

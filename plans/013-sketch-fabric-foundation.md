# Plan 013: Sketch mode — fabric store + LOD-aware rendering + draw tools (Phase 6)

> **Executor**: follow step by step, run every verification, honor STOP conditions, update `plans/README.md` row when done.
> **Drift check**: `git diff --stat 400e0ef..HEAD -- src/view/MapView.ts src/main.ts src/map/theme.ts src/map/themes/index.ts src/model/mutationLog.ts` — locate by symbol name.

## Status
- **Priority**: P1 (new user direction: GUI tools to sketch non-location city fabric)
- **Effort**: L
- **Risk**: MED (new canon store type + a draw controller; touches hot files MapView/main/themes)
- **Depends on**: none new (models on the connection/session-path rendering + quick-add flows)
- **Category**: direction (Phase 6 — sketch/landscaping)
- **Planned at**: commit `400e0ef`, 2026-07-10

## Why this matters (user's words)
"I don't have time to do lots of map-level detailing, especially if they change given LOD — I want a GUI-based set of tools that can help me effectively sketch all the non-location parts of the city." Decisions taken (this session):
- **Storage**: ONE promotable per-campaign `Fabric.geojson` (no note-per-feature clutter) + a "promote to location note" action for the few features that deserve lore. → this plan.
- **Procedural relationship**: sketches will *feed* the generator ("a la Sims landscaping") — that's **plan 014**, built on this foundation. This plan (013) delivers the shared core: durable, LOD-consistent, directly-drawn fabric that renders across every theme and zoom.

The load-bearing constraint (advisor): **sketched fabric must be LOD-disciplined from day one** — a road network drawn at z14 must not become an unreadable tangle at z7, or we've recreated the exact complaint. Per-kind min-zoom + geojson simplification are core, not polish.

## Current state (patterns to model on)
- **Canon-geometry storage today** (`src/model/locationNote.ts`): a note's `geometry` may be a point `[x,y]` OR a string path to a sidecar `.geojson`. Fabric is NOT note-bound — it's a single campaign-level FeatureCollection. New store.
- **Theme layer registration** (`src/map/theme.ts` `obsidianNativeStyle` + `src/map/themes/index.ts` `buildThemeStyle`): register a source `{type:"geojson", data: emptyFC}` and spread `xxxLayers({tokens})`. `connections`/`session-path` are the exact templates. Both builders must get the new `fabric` source + `fabricLayers(...)`.
- **Reconcile → source** (`src/view/MapView.ts`): `refreshConnections()`/`refreshSessionPath()` set a source's data and are re-applied inside `refreshSource()` (survives a theme `setStyle`). Model `refreshFabric()` identically.
- **Draw-free interaction today**: `handleClick` (`pickFeatureNear`), `openQuickAdd`, the toolbar `buildToolbar` (add/generate/canonize/search/theme/image/settings buttons). Add a "sketch" toggle button.
- **Mutation log** (`src/model/mutationLog.ts`): `LogEntrySchema.type = enum(["create","move"])`, note-oriented. Extend with sketch add/remove for undo (Step 6).
- **Tokens** (`src/map/themes/tokens.ts`): `land, water, roadMajor, roadMinor, roadMajorCasing?, labelMajor, labelMinor, accent, poi`. Fabric kinds map to these (no new tokens needed for v1; add a `wall`/`green` fallback via existing tokens).

## Scope
**In scope (v1 = draw + delete + promote; NO vertex re-edit, NO snapping — explicitly deferred):**
- `src/model/fabric.ts` (new) — Zod `FabricFeature`/`FabricCollection`, `FABRIC_KINDS`, load/save/validate helpers (pure where possible).
- `src/model/fabric.test.ts` (new).
- `src/vault/fabricStore.ts` (new) — read/write `<campaign>/Fabric.geojson` via the Vault adapter; append/remove a feature; `promoteToNote(featureId)` (creates a location note from a fabric feature, mirroring canonize).
- `src/map/themes/fabricLayers.ts` (new) — per-kind line/fill layers with **per-kind `minzoom`** and theme tokens.
- `src/map/theme.ts` + `src/map/themes/index.ts` — register `fabric` source (with `tolerance` for simplification) + `...fabricLayers(...)` in BOTH builders, right after `sessionPathLayers`.
- `src/view/SketchController.ts` (new) — the hand-rolled draw controller (click-to-add-vertex line/polygon, live preview via a temp `fabric-draft` source, finish on double-click/Enter, cancel on Esc).
- `src/view/SketchPaletteModal.ts` (new) OR an inline toolbar sub-bar — kind picker (road/wall/river/water/district/park).
- `src/view/MapView.ts` — `toggleSketchMode()`, `refreshFabric()` (in `refreshSource`), wire the controller, a sketch toolbar button, delete-selected-fabric.
- `src/main.ts` — commands `toggle-sketch-mode`, `promote-fabric-feature`.
- `src/model/mutationLog.ts` — extend `type` enum with `"sketch-add"|"sketch-remove"`; undo handling in MapView's undo path.
- `styles.css` — sketch-mode toolbar/palette styles.

**Out of scope (→ 014 or later):** any generator interaction (sketch→procedural is 014), vertex re-editing, snapping to roads/pins, freehand/brush strokes, curve smoothing. Ship v1 as straight-segment line + polygon.

## Commands / verification
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass (+ new fabric tests) |
| Build | `npm run build` | exit 0 |
| Live gate (env) | drive via `obsidian` CLI on dev-vault | draw a road/district → renders, persists in Fabric.geojson, survives reload + theme switch, hidden appropriately when zoomed out |

## Data model (fabric.ts)
```ts
export const FABRIC_KINDS = ["road", "wall", "river", "water", "district", "park"] as const;
export type FabricKind = (typeof FABRIC_KINDS)[number];
// line kinds: road, wall, river ; polygon kinds: water, district, park
export const FabricFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string(),                       // stable id (nanoid/hash) for select/delete/undo
  geometry: z.union([LineStringGeom, PolygonGeom]),
  properties: z.object({
    kind: z.enum(FABRIC_KINDS),
    name: z.string().optional(),
    minZoom: z.number().optional(),     // per-feature override; else per-kind default
  }),
});
export const FabricCollectionSchema = z.object({ type: z.literal("FeatureCollection"), features: z.array(FabricFeatureSchema) });
```
Per-kind default min-zoom (LOD discipline): major roads/rivers/water/district visible earlier (lower z), minor walls/parks later. E.g. `{ river: 4, water: 4, district: 6, road: 8, park: 10, wall: 11 }` — tune live. Store `<campaign>/Fabric.geojson` (NOT under `.mapcache/` — this is canon, durable, synced).

## Steps
1. **fabric.ts** model + Zod + `FABRIC_KINDS` + `defaultMinZoomFor(kind)` + `emptyFabric()`. Unit-test validation + `defaultMinZoomFor`. **Verify** typecheck + test.
2. **fabricStore.ts**: `loadFabric(app, campaign)`, `saveFabric(...)`, `addFeature`, `removeFeature(id)`, `promoteToNote(app, campaign, id)` (reuse `createLocationNoteWithSidecar` from `locationOps.ts` — write the geometry as the note's sidecar). Vault adapter only. **Verify** typecheck.
3. **fabricLayers.ts**: for each kind, a line or fill layer on source `fabric`, filtered `["==",["get","kind"],<kind>]`, with `minzoom` = per-kind default, themed color (road→roadMajor, wall→labelMinor, river/water→water, district→poi fill low-opacity, park→a green-ish token or roadMinor). Register `fabric` source (`{type:"geojson", tolerance:2, data:emptyFC}`) + spread in BOTH `theme.ts` and `themes/index.ts`. **Verify** typecheck + build.
4. **SketchController.ts**: given the map + a chosen kind, enter draw: on map click add a vertex to a working coords array; render a live `fabric-draft` source (line or polygon-so-far); double-click / Enter finalizes → callback with the geometry; Esc cancels; a moving "rubber-band" segment to the cursor is a nice-to-have (skip if fiddly). Disable normal click handlers while drawing. **Verify** typecheck.
5. **MapView wiring**: `toggleSketchMode()` shows a kind palette + activates the controller; on finalize → `addFeature` → `saveFabric` → `refreshFabric()` (re-render) → mutation-log `sketch-add`. `refreshFabric()` sets the `fabric` source from the store; call it in `refreshSource()` (theme-switch safe) and on campaign switch. Sketch toolbar button (`buildToolbar`). Click a fabric feature in sketch mode → select → Delete key / a delete action → `removeFeature` + log `sketch-remove`. **Verify** typecheck + build.
6. **Undo**: extend `LogEntrySchema.type` enum with `"sketch-add"|"sketch-remove"`; in MapView's `undoLastEdit`, handle these (add→remove the feature, remove→re-add from `data`). **Verify** typecheck + test.
7. **Commands + styles**: `toggle-sketch-mode`, `promote-fabric-feature` in `main.ts`; `.campaign-map-sketch-*` styles in `styles.css`. **Verify** full: typecheck + test + build.

## Done criteria
- [ ] `npm run typecheck` 0 · `npm test` pass incl. new fabric tests · `npm run build` 0
- [ ] `grep -rn "fabricLayers" src/map` → both `theme.ts` + `themes/index.ts`; `grep -n "refreshFabric\|toggleSketchMode" src/view/MapView.ts` matches
- [ ] `grep -rn "from \"fs\"\|require('fs')" src/model/fabric.ts src/vault/fabricStore.ts` → nothing
- [ ] Per-kind `minzoom` present in `fabricLayers.ts` (grep `minzoom`)
- [ ] No files outside scope modified; `plans/README.md` not edited by the agent

## STOP conditions
- The connection/session-path source+layer wiring in `theme.ts`/`themes/index.ts` isn't shaped as described → re-locate, match the real pattern.
- `createLocationNoteWithSidecar` signature differs → match it (or write the sidecar note directly, matching `locationNote.ts`'s validator).
- The hand-rolled draw controller can't cleanly suspend the existing `handleClick`/drag handlers → report the conflict; don't half-wire it.
- A verification fails twice after a reasonable fix.

## Maintenance notes
- v1 ships **straight-segment line + polygon, draw + delete, no re-edit, no snapping** — say so in the PR. Follow-ups: vertex editing, snapping (road↔road, road↔pin), curve smoothing, freehand brush, per-feature min-zoom UI.
- Reviewer: the LOD check is the important one — draw a dense road set at high zoom, zoom out, confirm minor kinds drop out (min-zoom) and lines simplify (`tolerance`) rather than becoming a tangle.
- 014 (sketch→procedural) reads `Fabric.geojson` as generator constraints; keep the store + feature schema stable and generator-friendly (kinds map to generator intents).

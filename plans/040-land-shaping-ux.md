# Plan 040 — Land-shaping UX: click-out safety + drag-to-extrude terrain

**Priority:** P1 · **Effort:** M · **Depends on:** 036 (relief/landform stamp kinds), 034 (drag preview mode) · **Model:** Opus 4.8

## 0. Context for a cold-start implementer

Jonah, verbatim: *"when im editing a shape and click out, it just deletes the shape. that's
bad ux. also defining the height of a relief or landform is really unintuitive — i want to
define it visually, not by guessing/checking a number. give me effectively the extrusion
mechanic of 3d modeling software."*

Two problems, one theme — **land shaping should be direct manipulation, not form-filling.**

### 0.1 What exists today (read before touching anything)
- **Sketch edit state machine:** `src/view/SketchController.ts` (draw + PowerPoint-style select
  tool: vertex / midpoint / generation-center handles; drag owns its own mousedown/move/up dance
  with `dragPan` disabled; a `fabric-draft` geojson source paints the highlight + handles).
  Routing lives in `src/view/MapView.ts` (`handleSketchClick`, `sketchKeydown`, `setSketchTool`,
  `toggleSketchMode`, `buildSelectionPanel`, `buildProcgenSection`).
- **Terrain stamp kinds (plan 036):** `relief` (LINE — ridge/valley add-stamp) and `landform`
  (POLYGON — plateau/basin/sea replace-stamp). Both carry a procgen block; **both emit NO
  per-region tile fabric** (`tileGeneratorIds: []`, `generate()=>[]`) — their visible form is the
  *composed global terrain field* (contours + hillshade, plan 036-C), and their arithmetic effect
  flows through `terrainAt`. Param schemas (`src/gen/procgen/registry.ts`):
  - `relief`: `polarity` (ridge|valley), **`height`** (m, >0, ≤4000 — the extrude magnitude),
    `halfWidth` (m, the cross-profile reach), `apron` (m, optional foothill skirt).
  - `landform`: `mode` (plateau|basin|sea), **`target`** (m, signed, optional — absent ⇒ mode
    default), `band` (m, the transition edge), `priority` (int, overlap last-wins knob).
- **How params are edited today:** the selection panel renders schema-derived numeric inputs
  (`src/view/paramControls.ts` → `renderParamControls`), each committing through
  `MapView.setRegionParams` → `MapController.setRegionParams` (validate → `sketch-procgen-set`
  log → cascade regen). **This is the durable, deterministic path — the new UX SETS the SAME
  params through the SAME call.** Determinism (D1–D6) is untouched: a drag just chooses a number.
- **Preview machinery (plan 034-D):** `SketchController.onGeometryPreview` fires per drag pause →
  `MapController.previewRegionGeometry(featureId, geometry)` paints an EPHEMERAL root-only regen
  (no cache, no fingerprint, no downstream); the full forward pass runs once on release via
  `onGeometryEdit` → `commitGeometryEdit`. `cancelRegionPreview` re-serves the durable cache.
  **Cost note:** that ephemeral path swaps a region's `region:<id>:` render tiles. relief/landform
  have no such tiles — their preview is a *global terrain-field re-composition + re-contour*, which
  is the heavier "full DEM refresh" the perf doctrine says belongs on **release**, not per-frame.

### 0.2 Research synthesis — what direct-manipulation land shaping does right
- **3D modeling (SketchUp Push/Pull, Blender extrude, Fusion press-pull):** click the thing, drag,
  see the result *in real time*; the drag axis IS the parameter; a live on-screen **numeric readout**
  shows the exact value while you drag; you can **type a number mid-drag** to snap to an exact value;
  **release commits once**. The magic is that the handle is ON the object and the feedback is
  immediate — no distant form.
- **Terraforming games (Cities: Skylines, From Dust, Black & White):** immediate tactile feedback,
  a visible **brush/affected-band outline**, size and strength as first-class adjustables, low
  strength for fine control. The *reach* of the effect is always drawn, never guessed.
- **What we TAKE vs. what we can't:** we take the modeling world's **on-object handle + live readout
  + type-to-refine + commit-on-release**, and the games' **draw-the-affected-band**. We CANNOT take
  the games' free-paint heightmap model — our terrain is param-backed deterministic stamps, so a
  drag must resolve to a *param value* (`height`/`target`/`band`), never a per-pixel brush. That is
  the whole trick: **map a direct drag onto an existing zod param, and determinism/undo/cascade come
  for free.**

### 0.3 Design principles for OUR constraints
1. The handle lives on the map, on the selected stamp — not in a panel.
2. Vertical screen-drag = magnitude (up = higher / raise; down = lower). Top-down MapLibre has no
   spatial Z, so screen-Y is the natural "taller" axis (the same convention as a modeling gizmo's
   projected axis).
3. Cheap live feedback = a **ghost cross-section bar + numeric readout** that tracks the drag with
   zero regen. The expensive terrain re-composition is deferred to **release** (`setRegionParams`).
4. Release commits exactly once, through the existing param path → undo, cascade, and adoption
   prompts all just work. Nothing new touches `.mapcache/` or determinism.
5. Every draggable also accepts **typed refinement** (a number entry that sets the exact value),
   preserving the current numeric control as the precision fallback.

## 1. Scope

**Phase 0 — click-out safety (LANDED, commit `67a0450`).** Root cause: a finishable draw draft
(≥ min vertices) was silently discarded via `cancel()` on every implicit "click out" — switching to
the Select tool, switching kind, or hitting ✕ done — because finishing required an obscure
double-click/Enter. The *select-tool* click-out path (`deselectFabric`) was already safe and never
deleted a persisted shape. Fix: those transitions route through the new
`SketchController.commitDraftIfAny()`, which finishes+persists a finishable draft (new
`onDraftCommit` handler → `MapView.persistSketchDraft`, the same `sketch-add` + procgen-offer path)
and only discards genuinely too-short drafts; `Esc` stays the one deliberate discard. Undo semantics
unchanged. Headless twin: `src/view/SketchController.test.ts` (mock-map idiom; 8 tests).

**Phase 1 — drag-to-extrude height handle (the core).** A selected `relief`/`landform` grows a
distinct **height handle** on the map (at the geometry midpoint/centroid, drawn UNLIKE a vertex —
an "extrude" grip). Dragging it vertically changes the magnitude param live:
- `relief` → `height` (and, past the zero-crossing, flips `polarity` ridge↔valley — the C:S
  raise/lower-with-one-tool feel; **decision to confirm with Jonah**, §4).
- `landform` → `target` (signed; no polarity).
On-map feedback while dragging: a **ghost cross-section bar** scaled to the value + a **numeric
readout** ("height 300 m"), both view-only (no regen). On release: one
`setRegionParams({ ...live, [key]: value })` (validate → log → cascade). A too-small drag (below a
noise threshold) is a no-op, not a commit.

**Phase 2 — visual band editing.** While a `relief`/`landform` is selected, render its reach as
**ghost outlines**: `relief` → the `halfWidth` (+ `apron` skirt) corridor around the spine;
`landform` → the `band` transition ring outside the polygon. A **band handle** on that outline drags
to resize → `setRegionParams` on release. Read-only viz is the floor; the draggable handle is the
goal for this phase.

**Phase 3 — live readout + type-to-refine.** The drag readout is a first-class HUD element (value +
unit, updates every move). While a handle is armed, **typing digits** sets the exact value (Enter
commits, Esc reverts) — the modeling-software "type during transform" convention. The existing panel
number input stays as the precision fallback and mirrors live.

**Deferred (with rationale, §3):** pitched-3D direct drag; live terrain preview *during* the drag.

## 2. Phases & verification (headless — NO live gates, per Jonah 2026-07-14)

Every interaction gets a **headless twin** in `src/view/SketchController.test.ts` (the mock-map
idiom established in Phase 0 — modals/real drags hang the CLI, so pointer sequences are fired
through the controller's own handlers; the draft geojson source is inspected via the mock's captured
`setData`). Param math (screen-Y → meters, type-to-refine parsing) is extracted as **pure functions**
and unit-tested directly. The orchestrator eyeballs the on-map look/feel in-app after each phase.

- **Phase 0 (done):** deselect-is-safe (no `onGeometryEdit`), commit-on-tool-switch,
  commit-on-kind-switch, too-short-discard, ✕-done commit, `Esc`-discard, vertex-drag single-commit.
- **Phase 1:** `mousedown` on the height handle → `mousemove` (Δy) → assert the reported live value
  matches the pure screen-Y→meters map; `mouseup` → exactly ONE `onHeightCommit(featureId, value)`
  (wired to `setRegionParams`); clamped to the schema's min/max; sub-threshold drag → no commit;
  polarity-flip at the zero crossing (relief) asserted numerically. Ghost cross-section + readout
  present in the draft source features. `MapController` param-commit path already covered by
  `MapController.test.ts`; add a `setRegionParams` round-trip assertion for a `relief.height` edit
  (params persisted, undo restores).
- **Phase 2:** band-viz features present in the draft source for a selected relief (corridor) and
  landform (ring) with the right dimensions; band handle drag → one `setRegionParams` on release,
  clamped.
- **Phase 3:** pure type-to-refine parser tests (valid/invalid/clamped/empty); readout formatter
  tests (unit + sign + rounding); armed-handle keypress → value set, Enter commits once, Esc reverts
  to the pre-arm value (no commit).

Fast suite + `tsc` + `build` green per phase; fuzz untouched (UX only — no generator change). Commit
per green phase, explicit pathspecs.

## 3. STOP conditions / risks

- **Determinism is the axe.** The UX may only WRITE existing zod params through the existing
  `setRegionParams` path. If any phase is tempted to write geometry-derived floats, a per-drag cache
  entry, or a new generator branch, STOP — that breaks D1–D6 / the operators-are-data convention.
- **No touching the forward-pass / deletion / drop internals** (`runForwardPass`,
  `deleteFabricFeature`, drop/unpaint) — a parallel agent owns those. Params flow through
  `setRegionParams`; previews (if ever added) through `previewRegionGeometry`. Shared checkout:
  pathspec commits, never `git add -A`.
- **Live terrain preview during the drag is DEFERRED.** relief/landform emit no per-region tiles;
  previewing a height change means re-composing the *global* terrain field + re-contouring — the
  heavy DEM path, correctly deferred to release (perf doctrine). During the drag we show only the
  cheap ghost cross-section + readout. Revisiting this needs a *cheap* incremental-contour path
  (out of scope; would touch worker internals).
- **Pitched-3D direct drag is DEFERRED.** MapLibre top-down is the primary surface; screen-Y already
  reads as "taller" without a pitched camera. A true 3D drag (screen-Y → meters projected onto the
  terrain DEM under a pitched camera) needs DEM raycasting and terrain-exaggeration coupling — high
  cost, worker-adjacent, low marginal UX over the ghost+readout. Note it, don't build it.
- **Scope discipline (Jonah's sanity-check):** land Phase 1 *well* (the core visual extrude with
  live readout and clean commit) before widening. Phase 2/3 are additive; drop them rather than ship
  a rough Phase 1.

## 4. Needs Jonah's eyes (UX judgment calls)
- **Drag sensitivity:** default meters-per-pixel and whether **Shift = fine** (smaller m/px, the C:S
  low-strength convention). Proposed: a coarse default with Shift-fine.
- **Polarity flip at zero (relief):** dragging `height` down through 0 flipping ridge→valley is
  elegant (one-tool raise/lower) but changes a second param implicitly — confirm, or keep `height` a
  pure magnitude and leave polarity to the panel.
- **Readout format:** `"height 300 m"` vs. `"+300 m"` vs. a signed delta during the drag.
- **Handle glyph/placement:** an "extrude" grip at the centroid (distinct from the vertex/center
  dots) — the exact icon is an eyeball call.
- **Auto-commit on tool/kind switch (Phase 0, already landed):** switching kind now COMMITS the
  old-kind draft instead of discarding it (you keep the road, start a river). Confirm that's the
  wanted behavior; the alternative is commit only on Select/✕-done and keep kind-switch a discard.

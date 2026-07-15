# Plan 041 — Map-recreation enablers: reference underlay + island-from-coastline

**Priority:** P1 · **Effort:** M · **Depends on:** 036 (relief/landform stamp kinds), 020 (sketch tools) · **Model:** Opus 4.8

## 0. Context for a cold-start implementer — the Cradle exercise friction

Jonah asked us to recreate a published reference map (Deathmatch Island — the
"Cradle") as a campaign. Building it by hand surfaced three concrete points of
friction, and Jonah's ask was: *"if it's too hard to build the cradle map, think
about and figure out what would make it easier."* This plan ships the two
highest-leverage answers.

### 0.1 The friction, named
1. **Blind coordinate authoring.** Recreating a real reference means transcribing
   its shapes into `Fabric.geojson` vertex-by-vertex, eyeballing where a coastline
   or ridge sits in the fake lng/lat box with nothing to trace against. Every
   vertex is a guess; there is no way to lay the reference picture down and draw on
   top of it. This is the single biggest recreation tax — the sketch tools are
   good, but they draw into a void.
2. **The sea-donut trick.** The Cradle is an island. To make "everything around
   the island is ocean" today, a GM must draw the *sea polygon itself* — i.e. author
   a ring that covers the whole box with a hole where the land is, by hand. The
   natural gesture is the opposite: draw the **coast** and mean "outside is sea".
   The `landform` `sea` mode only fills the drawn ring's *interior*, so an island
   is authored inside-out.
3. **No underlay at all.** Neither the config nor the renderer had any concept of a
   positioned reference image beneath the fabric — so even a GM willing to trace
   had nothing to trace onto.

### 0.2 What exists today (read before touching anything)
- **Campaign config** — `src/model/campaignConfig.ts`: a zod-validated frontmatter
  block on the `*.map.md` note. The optional `terrain` block (036-D) is the model
  to copy: an optional object, normalized so an all-default block is *omitted*
  (frontmatter stays minimal), edited behind an explicit Apply in the settings
  modal, with a headless twin on `MapView`.
- **Style builders** — `src/map/theme.ts` (`obsidianNativeStyle`) and
  `src/map/themes/index.ts` (`buildThemeStyle`). Both take optional `basemap` /
  `dem` descriptors and splice a source + layer into a z-ordered stack that
  `assertOrdered` (→ `layerOrder.ts`) validates on every build. **This is exactly
  the seam the underlay rides**: a new optional descriptor, a new source, a new
  layer, a new z-order group.
- **Vault-resource URLs** — `src/map/glyphs.ts` uses
  `app.vault.adapter.getResourcePath(vaultPath)` to hand MapLibre a directly-
  loadable URL for a vault file, synchronously, through the DataAdapter (never Node
  `fs`). The underlay reuses this rather than an async binary-read + object-URL
  dance: the style builders are pure and synchronous, and `getResourcePath` keeps
  them that way with no object-URL lifecycle to leak.
- **Terrain field** — `src/gen/fields/terrain.ts`: `terrainAt` composes the campaign
  elevation surface from durable sketch stamps. A `landform` `sea` stamp lerps the
  interior of its ring toward the sea datum via `ringMaskField` (mask 0 at the rim,
  1 deep inside). `terrainStampSupport` reports each stamp's variable invalidation
  reach (relief → halfWidth+apron, mountain/landform → 0) consumed by three sites:
  the per-tile DEM digest (`perTileTerrainDigest`), the DAG source→region edge
  (`dag.ts` `supportMargin`), and the fingerprint constraint scoping
  (`cache/fingerprint.ts`).
- **Fabric paint mirror** — `MapView.refreshFabric` builds the display feature
  collection from the durable fabric, lifting mirror-only paint props
  (`landformMode`) and even swapping display *geometry* (rural road smoothing)
  without touching persisted bytes; selection reads the RAW feature. This is the
  seam the sea-donut display polygon rides.

## 1. Scope

**A. Reference-image underlay (trace mode).** A GM drops an image into the vault,
attaches it as a positioned raster **underlay** below all fabric (above the
background), sets opacity + visibility, and traces coastline/ridges/regions with
the existing sketch tools.

**B. Island-from-coastline (auto sea donut).** A `landform` `sea` stamp gains an
optional `invert` param: draw the **coast** (the land boundary) and the effective
sea is the ring's *exterior*, bounded by the campaign box.

**Out of scope / deferred:** a create-campaign-modal "attach reference now"
checkbox (noted in `CreateCampaignModal`, deferred); georeferencing/warping the
image (two-corner affine placement only); trace-assist (edge detection).

## 2. Phase A — reference-image underlay

1. **Config** (`campaignConfig.ts`): optional `underlay` block —
   `{ image: string (vault path), sw: [x,y], ne: [x,y], opacity: 0..1 default 1,
   visible: boolean default true }`. Two anchor corners (south-west, north-east) in
   display units; the four image corners derive from them.
2. **Style** (`underlayLayer.ts` + both builders + `layerOrder.ts`): a MapLibre
   `image` source (url via `getResourcePath`, coordinates from sw/ne) and a
   `raster` layer `underlay`, in a new z-group **between `background` and
   `basemap`** — above the background fill, below every basemap/hillshade/generated/
   fabric/location layer. `assertOrdered` enforces it.
3. **View** (`MapView.ts`): `buildStyle` passes the underlay descriptor when the
   config carries a visible block; `setCampaign` treats an underlay change like a
   theme change (setStyle rebuild — rare GM action, reuses the asserted order);
   `applyUnderlay(block)` persists to frontmatter; `setUnderlayOpacityLive(v)` /
   `toggleUnderlay()` give instant feedback via `setPaintProperty` /
   `setLayoutProperty`; `setUnderlayForTest` is the headless twin.
4. **GUI** (`CampaignControlModal.ts`): a "Reference underlay" section — image
   vault-path text field (validated: must exist in the vault), SW/NE corner number
   fields, a **live** opacity slider (display-only, no regen), a visibility toggle,
   and an Apply. Plus a "Toggle reference underlay" command (`main.ts`).

## 3. Phase B — island-from-coastline (invert)

1. **Schema** (`registry.ts`): `landform` gains `invert: z.boolean().optional()`
   (absent ⇒ false ⇒ byte-identical) + an `island` preset (`mode: sea, invert:
   true`).
2. **Field** (`terrain.ts`): a `sea` stamp with `invert: true` uses the ring's
   **exterior** mask (`1 − ringMask`: 1 outside the ring / full sea, fading across
   `band` *inward* from the coast to 0 deep inland), so the sea replace-stamp
   applies outside the drawn coast. The far-field reject flips accordingly (outside
   the ring bbox ⇒ *inside* the sea ⇒ mask 1, byte-exact, no nearest-spiral).
   `terrainStampSupport` returns **∞ (global)** for an inverted sea — its support is
   the whole campaign box, so it is campaign-wide dirty (like the base params): the
   DEM digest always folds it in, the DAG edge reaches every terrain consumer, the
   fingerprint scoping always includes it. Every other landform stays reach-0.
3. **Paint** (`MapView.refreshFabric`): the fabric mirror emits an inverted sea's
   *display* geometry as a **bounds-donut** (outer ring = campaign box, hole = the
   drawn coast), so the existing `landformMode==="sea"` water fill + selection just
   work. Persisted geometry stays the drawn coast ring.

**Byte-exactness:** `invert` absent ⇒ every path is the pre-041 computation ⇒ no
`currentVersion` bump (029 absent-param-reproduces-old-bytes). The exterior mask,
the ∞ support, and the donut are reached ONLY when `mode==="sea" && invert===true`.

## 4. Verification — headless only

Per the arc standing rule (no live gates): everything proves through Vitest + tsc +
build (+ the terrain fuzz suite for the `terrain.ts` change).
- `underlayLayer.test.ts` — corner derivation, source/layer spec, `assertLayerOrder`
  on a synthetic stack with the underlay in place.
- `campaignConfig.test.ts` — underlay parse (valid / clamped / rejected).
- `layerOrder.test.ts` — the underlay group classifies and orders.
- `terrain.test.ts` — inverted-sea exterior mask (sea outside the ring, land deep
  inside), byte-identity when `invert` absent, `terrainStampSupport` ∞ for inverted
  sea / 0 otherwise.
- `test:fuzz` (terrain) — the compact-support / far-field-reject invariants still
  hold with the exterior branch present.
- The `setUnderlayForTest` twin exists for the Obsidian CLI loop, but live
  screenshot verification is a Jonah-eyeball follow-up (not a gate here).

## 5. STOP conditions
- **Do NOT** bump any generator `currentVersion` — a version bump here means the
  byte-identity discipline broke; find the leak instead.
- **Do NOT** read vault files with Node `fs` — DataAdapter/`getResourcePath` only.
- **Do NOT** put the underlay above any fabric/location layer, or let it regen
  anything — it is display-only, below the fabric the GM traces onto.
- **Do NOT** overwrite an inverted sea's persisted coast ring with the donut — the
  donut is a paint-time mirror only.
- **Do NOT** run the live board (arc rule) — headless verification only.
- **Do NOT** touch the parallel agents' files (`scripts/emit-cradle*`,
  `dev-vault/Cradle`, `regionLabels.ts`, `farmland.ts`, MapView TERRAIN/DEM
  sections) — stage explicit paths only.

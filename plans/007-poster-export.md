# Plan 007: Poster export (Phase 5 keepsake) — v1 high-resolution PNG

> **Executor instructions**: Follow step by step; run every verification; honor
> STOP conditions; update the row in `plans/README.md`.
>
> **Drift check**: `git diff --stat 3783bf9..HEAD -- src/main.ts src/view/MapView.ts`
> (locate methods by symbol name — plans 001/003 also edit these files).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (additive; a separate offscreen map, no change to the live
  map's behavior)
- **Depends on**: none (merge after 001/003 for `MapView.ts`/`main.ts` overlap)
- **Category**: direction (Phase 5 roadmap: "Poster export first")
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

docs/03 Phase 5 leads with **poster export** — a keepsake render of the campaign
map. None exists. This plan ships a v1: export the **current map view** at
high resolution to a PNG saved in the vault, with a title cartouche. It's the
foundation the fuller roadmap item (300dpi tiled render, gazetteer margin,
cartouche furniture) builds on — deliberately scoped to "one screen, high-res,
titled" so it's shippable and verifiable now.

## Current state

- `src/view/MapView.ts` — holds the live `map` (MapLibre instance), `campaign`
  (`ParsedCampaign`), and `buildStyle(campaign)` (private, ~line 216) which
  returns the `StyleSpecification` for the campaign. The live map is created
  **without** `preserveDrawingBuffer` (onOpen, ~line 256), so its own canvas
  can't be reliably captured — the export must build its own offscreen map.
- `src/main.ts` — commands are registered in `onload` via `this.addCommand({...})`
  with `checkCallback` using `this.activeMapView()` (line 99). Model the export
  command on the existing `search-locations` command (lines ~132).
- Writing files: architecture mandates **Vault/DataAdapter APIs only, never Node
  `fs`**. Use `this.app.vault.adapter.writeBinary(path, arrayBuffer)` and
  `this.app.vault.adapter.mkdir(dir)` (see `src/model/mutationLog.ts` for the
  adapter write pattern already used in this repo).
- Glyphs/transform: `glyphsUrlTemplate()` and `createTransformRequest(this.app)`
  (imported in MapView) are needed so the offscreen map resolves fonts + the
  vault PMTiles protocol identically to the live map.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |

## Scope

**In scope:**
- `src/map/posterExport.ts` (create) — the offscreen-render + compositing logic.
- `src/view/MapView.ts` — a public `exportPoster()` method that gathers
  style+camera and calls the module.
- `src/main.ts` — an "Export map poster" command (+ optional ribbon icon).

**Out of scope:** 300dpi tiled multi-canvas stitching; gazetteer/location-list
margin; decorative cartouche furniture beyond a title bar; PDF/atlas export
(separate roadmap item). Keep the composite to map image + title strip.

## Git workflow

- Branch: `advisor/007-poster-export`. Conventional commits ending with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push; no merge.

## Steps

### Step 1: Offscreen render module

Create `src/map/posterExport.ts` exporting:
```ts
export interface PosterOptions {
  style: StyleSpecification;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  widthPx: number;      // output width, e.g. 2000
  heightPx: number;     // output height, preserve view aspect
  title: string;
  transformRequest: maplibregl.RequestTransformFunction;
}
export async function renderPoster(opts: PosterOptions): Promise<ArrayBuffer> { ... }
```
Implementation:
1. Create a detached container `div` sized `widthPx × heightPx`, appended to
   `document.body` but positioned off-screen (`position:absolute; left:-99999px`).
2. `new maplibregl.Map({ container, style, center, zoom, bearing, pitch,
   preserveDrawingBuffer: true, attributionControl: false, interactive: false,
   transformRequest, fadeDuration: 0 })`.
3. `await once(map, "idle")` (all tiles/labels settled). Guard with a timeout
   (e.g. 15s) → reject if it never idles.
4. Composite: create a 2D canvas `widthPx × (heightPx + titleBarPx)`; draw
   `map.getCanvas()` at (0, titleBarPx); draw a title bar (filled rect + the
   `title` text, and a small "Campaign Map" attribution) at the top.
5. `const blob = await canvas.convertToBlob()` (or `toBlob`); return
   `await blob.arrayBuffer()`.
6. `finally`: `map.remove()` and remove the container from the DOM (no leaks).

Use theme-neutral title-bar colors passed in, or read them from the style's
`background` layer paint; keep it simple.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: `exportPoster()` on the view

Add to `MapView`:
```ts
async exportPoster(): Promise<void> {
  if (!this.map || !this.campaign) { new Notice("Campaign Map: open a campaign first"); return; }
  const c = this.map.getCenter();
  const canvas = this.map.getCanvas();
  const aspect = canvas.height / canvas.width;
  const widthPx = 2000;
  const buf = await renderPoster({
    style: this.buildStyle(this.campaign),
    center: [c.lng, c.lat],
    zoom: this.map.getZoom(),
    bearing: this.map.getBearing(),
    pitch: this.map.getPitch(),
    widthPx, heightPx: Math.round(widthPx * aspect),
    title: this.campaign.name,
    transformRequest: createTransformRequest(this.app),
  });
  const dir = `${this.campaign.path.slice(0, this.campaign.path.lastIndexOf("/"))}/Exports`;
  await this.app.vault.adapter.mkdir(dir).catch(() => {});
  const path = `${dir}/${this.campaign.name}-${Date.now()}.png`;
  await this.app.vault.adapter.writeBinary(path, buf);
  new Notice(`Campaign Map: poster exported → ${path}`);
}
```
`buildStyle` is currently `private` — either make it accessible to
`exportPoster` (same class, fine) or keep private and call it directly (it's a
method on `this`, so private is OK). Import `renderPoster`.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Command in main.ts

Add an `export-map-poster` command modeled on `search-locations`
(checkCallback + `activeMapView()`), calling `void view.exportPoster()`.
Optionally an `image` ribbon icon.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass.

## Test plan

- **Unit**: the offscreen render is DOM/WebGL-heavy and not unit-testable without
  a headless GL context — do **not** fake it. Instead unit-test any pure helper
  you extract (e.g. output-dimension math: `posterDimensions(canvasW, canvasH,
  targetW)` → `{width,height}`), and rely on the manual check for the render.
- **Manual (required before calling it done, if the app is drivable)**: run the
  command on Ashfall; confirm a PNG lands in `Campaigns/Ashfall/Exports/`, opens,
  shows the map at higher resolution than the screen with a title bar. Try a
  handcrafted theme and a real-city (London) campaign too.
- If the app/CLI is unavailable in your environment, ship the code
  typecheck-clean + unit-green and note in your report that the render was not
  manually verified (STOP-condition-adjacent, but this is a genuinely
  environment-gated visual feature).

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (+ the dimension-math unit test if extracted)
- [ ] `src/map/posterExport.ts` exists and `renderPoster` uses
      `preserveDrawingBuffer: true` and cleans up the map + container in `finally`
- [ ] `grep -n "exportPoster" src/view/MapView.ts` and
      `grep -n "export-map-poster" src/main.ts` both match
- [ ] Writes go through `this.app.vault.adapter.writeBinary` — `grep -rn "require('fs')\|from \"fs\"" src/map/posterExport.ts` returns nothing (no Node fs)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

- The offscreen map never fires `idle` (blank/timeout export) after a reasonable
  attempt — STOP and report; the tile/font loading in a detached map may need the
  same `transformRequest` the live map uses (double-check it's passed).
- `convertToBlob`/`toBlob` returns null or a 0-byte buffer — report the WebGL
  context/`preserveDrawingBuffer` state.
- Writing to the vault adapter fails (path/permission) — report; do NOT fall back
  to Node `fs` (architecture forbids it).
- A verification fails twice after a reasonable fix.

## Maintenance notes

- Follow-ups (the full roadmap item): tiled 300dpi render (render N map tiles at
  high zoom offscreen and stitch — the reason this v1 keeps the offscreen-map
  abstraction), a gazetteer margin built from the campaign's location notes (the
  notes ARE the gazetteer — docs/03 Phase 5), and cartouche furniture per theme.
- Reviewer: confirm the detached map is always removed (memory/WebGL-context
  leak is the main risk — every open map holds a GL context, and the "multiple
  WebGL contexts" risk is called out in docs/02 §6).
- The `Exports/` folder should probably be sync-included (it's a keepsake, unlike
  `.mapcache/`) — fine as plain vault files.

# Plan 008: Atlas export — PDF of maps + location gazetteer (Phase 5)

> **Executor**: follow step by step, run every verification, honor STOP conditions, update `plans/README.md` row when done.
> **Drift check**: `git diff --stat 04d3d45..HEAD -- src/map/posterExport.ts src/view/MapView.ts src/main.ts` — locate methods by symbol name (`renderPoster`, `exportPoster`, `activeMapView`, the `addCommand` block, the toolbar `buildToolbar`).

## Status
- **Priority**: P1 (Phase 5 roadmap: "Atlas export")
- **Effort**: L
- **Risk**: MED (new dep `pdf-lib`; offscreen render reuse)
- **Depends on**: 007 (reuses `renderPoster`) — already merged to `main`
- **Category**: direction (Phase 5)
- **Planned at**: commit `04d3d45`, 2026-07-09

## Why this matters
docs/03 Phase 5: "Atlas export: PDF from maps + location notes + artist images — the notes ARE the gazetteer now." Ship a v1: a multi-page PDF with a cover map render (via 007's `renderPoster` offscreen pipeline) plus one gazetteer section listing every canon location (name, type, coordinates, and the note's first lines). Saved to the vault via the DataAdapter (never Node `fs`).

## Current state
- `src/map/posterExport.ts` — `renderPoster(opts): Promise<ArrayBuffer>` returns PNG bytes of an offscreen high-res map render; `posterDimensions(...)` pure helper. **Reuse `renderPoster` for the atlas cover image.**
- `src/view/MapView.ts` — `exportPoster()` (model the atlas method on it): gathers `this.buildStyle(campaign)`, camera, `createTransformRequest(this.app)`, then writes via `this.app.vault.adapter.writeBinary`/`mkdir`. Has `this.campaign` (ParsedCampaign) and `this.plugin.getCampaignState(id).index.all()` → `ParsedLocation[]` (fields: `name`, `type`, `point`, `path`, `importance`).
- `src/main.ts` — commands registered in `onload` via `addCommand({ id, name, checkCallback })` using `this.activeMapView()`. Model an `export-map-atlas` command on `export-map-poster`.
- Location note bodies: read with `this.app.vault.cachedRead(file)` then strip frontmatter (`content.replace(/^---\n[\s\S]*?\n---\n?/, "")`) — see `showPlaceCard` in MapView for the exact strip regex.
- **Vault writes only** — `app.vault.adapter.writeBinary(path, arrayBuffer)`, `adapter.mkdir(dir)`. No Node `fs` (CLAUDE.md).

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Install dep | `npm install pdf-lib` | adds to package.json |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass (+ new) |
| Build | `npm run build` | exit 0 |

## Scope
**In scope:** `package.json`/`package-lock.json` (add `pdf-lib`), `src/map/atlasExport.ts` (new — PDF composition), `src/map/atlasExport.test.ts` (new — pure helpers), `src/view/MapView.ts` (`exportAtlas()` method + toolbar button optional), `src/main.ts` (`export-map-atlas` command).
**Out of scope:** artist-image embedding beyond the note's first inline image (defer), per-theme cartouche furniture, `src/gen/**`.

## Git workflow
- Branch `advisor/008-atlas-pdf-export`. Conventional commits ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push branch; do not merge/touch `main`; do not edit `plans/README.md`.

## Steps
### Step 1: Add pdf-lib
`npm install pdf-lib`. Verify it imports: `import { PDFDocument, StandardFonts, rgb } from "pdf-lib";`
**Verify**: `npm run typecheck` → exit 0.

### Step 2: Atlas composition module
Create `src/map/atlasExport.ts` exporting:
```ts
export interface AtlasLocation { name: string; type: string; point: [number, number] | null; body: string; }
export interface AtlasOptions { title: string; coverPng: ArrayBuffer; coverWidth: number; coverHeight: number; locations: AtlasLocation[]; }
export async function buildAtlasPdf(opts: AtlasOptions): Promise<ArrayBuffer>;
```
Implementation with pdf-lib:
1. `const doc = await PDFDocument.create();`
2. Cover page (A4 landscape ~842×595pt): embed `coverPng` (`await doc.embedPng(opts.coverPng)`), scale to fit with margin, draw `opts.title` large at top (StandardFonts.HelveticaBold).
3. Gazetteer pages (A4 portrait 595×842pt): for each location, draw `name` (bold), a line `type · (x, y)`, then up to ~4 wrapped lines of `body`. Paginate: track y-cursor, `doc.addPage()` when it drops below the bottom margin. Extract a **pure** helper `wrapText(text, maxChars): string[]` and unit-test it.
4. `const bytes = await doc.save();` return `bytes.buffer` (Uint8Array → ArrayBuffer).

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Unit-test the pure helpers
Create `src/map/atlasExport.test.ts`: test `wrapText` (short string → 1 line; long string → wraps at maxChars without splitting mid-word; empty → []). Model on `src/map/posterExport.test.ts`.
**Verify**: `npm test` → all pass incl. new.

### Step 4: `exportAtlas()` on MapView
```ts
async exportAtlas(): Promise<void> {
  if (!this.map || !this.campaign) { new Notice("Campaign Map: open a campaign first"); return; }
  const c = this.map.getCenter();
  const canvas = this.map.getCanvas();
  const coverW = 1600, coverH = Math.round(coverW * (canvas.height / canvas.width));
  const coverPng = await renderPoster({ style: this.buildStyle(this.campaign), center: [c.lng, c.lat], zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch(), widthPx: coverW, heightPx: coverH, title: this.campaign.name, transformRequest: createTransformRequest(this.app) });
  const locs = this.plugin.getCampaignState(this.campaign.id).index.all();
  const atlasLocs = await Promise.all(locs.map(async (l) => {
    const file = this.app.vault.getAbstractFileByPath(l.path);
    let body = "";
    if (file instanceof TFile) body = (await this.app.vault.cachedRead(file)).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    return { name: l.name, type: l.type, point: l.point, body };
  }));
  const pdf = await buildAtlasPdf({ title: this.campaign.name, coverPng, coverWidth: coverW, coverHeight: coverH, locations: atlasLocs });
  const dir = `${this.campaign.path.slice(0, this.campaign.path.lastIndexOf("/"))}/Exports`;
  await this.app.vault.adapter.mkdir(dir).catch(() => {});
  const path = `${dir}/${this.campaign.name}-atlas-${Date.now()}.pdf`;
  await this.app.vault.adapter.writeBinary(path, pdf);
  new Notice(`Campaign Map: atlas exported → ${path}`);
}
```
Import `renderPoster` from `../map/posterExport`, `buildAtlasPdf` from `../map/atlasExport`. `TFile`, `Notice`, `createTransformRequest` already imported in MapView.
**Verify**: `npm run typecheck` → exit 0.

### Step 5: Command
In `main.ts`, add `export-map-atlas` command (model on `export-map-poster`) calling `void view.exportAtlas()`.
**Verify**: `npm run typecheck` → exit 0; `npm test` → pass; `npm run build` → exit 0.

## Test plan
- Unit: `wrapText` cases (Step 3). The PDF/WebGL path is not unit-testable headless — do NOT fake it.
- Manual (env-gated, note if unavailable): run `export-map-atlas` on Ashfall → a `.pdf` lands in `Campaigns/Ashfall/Exports/`, opens, cover map + gazetteer pages present.

## Done criteria
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 incl. new `atlasExport` tests
- [ ] `grep -n "buildAtlasPdf" src/map/atlasExport.ts` and `grep -n "exportAtlas" src/view/MapView.ts` and `grep -n "export-map-atlas" src/main.ts` all match
- [ ] `grep -rn "from \"fs\"\|require('fs')" src/map/atlasExport.ts` → nothing (no Node fs)
- [ ] `npm run build` exits 0
- [ ] No files outside scope modified; `plans/README.md` not edited

## STOP conditions
- `pdf-lib` fails to install or import → report; do not substitute a different PDF lib without noting it.
- `renderPoster` signature changed from 007 → re-check and adapt.
- `embedPng` rejects the poster bytes → report the error (PNG format issue).
- A verification fails twice after a reasonable fix.

## Maintenance notes
- Follow-ups: inline artist images per location, tiled 300dpi cover (007's deferred item), per-theme PDF styling, table-of-contents page.
- Reviewer: confirm the offscreen map is cleaned up (renderPoster already does) and the PDF opens in a standard reader.

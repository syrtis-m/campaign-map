# Plan 011: Import external maps (GeoJSON / Azgaar / Watabou) → notes (Phase 5)

> **Executor**: follow step by step, run every verification, honor STOP conditions, update `plans/README.md` row when done.
> **Drift check**: `git diff --stat 04d3d45..HEAD -- src/main.ts src/vault/locationOps.ts src/model/locationNote.ts` — locate by symbol name.

## Status
- **Priority**: P2 (Phase 5 roadmap: "Azgaar/Watabou import")
- **Effort**: M
- **Risk**: LOW (new module, low blast radius)
- **Depends on**: none
- **Category**: direction (Phase 5)
- **Planned at**: commit `04d3d45`, 2026-07-09

## Why this matters
docs/03 Phase 5: "Azgaar/Watabou import." Both Azgaar's Fantasy Map Generator and Watabou's generators can export **GeoJSON**. A generic GeoJSON importer covers both and anything else: Point features → location notes; Line/Polygon features → notes with a sidecar `.geojson` (the plugin already supports sidecar geometry, see `locationNote.ts`). This lands external worlds into the vault's canon-as-notes model.

## Current state
- `src/model/locationNote.ts` — frontmatter is `map`, `geometry: [x,y]` (point) **or** a string path to a sidecar `.geojson` (for lines/polygons), `type`, optional `aliases`. `LOCATION_TYPES` lists valid types. `parseLocationNote` is the reconcile validator. Point geometry is `[lng, lat]` / campaign units.
- `this.plugin.createLocation(campaignId, point, name, type)` — creates a point note (reuse for Point features).
- For non-point geometry: write the note with `geometry: <sidecarPath>` frontmatter + a sidecar `.geojson` file. Writes via `app.vault.create(path, content)` / `app.vault.adapter.write`.
- `src/main.ts` — command registration pattern; `activeMapView()` for the current campaign.
- Import source: a `.geojson`/`.json` file already in the vault (no network, no Node fs) — user drops the export into the vault, picks it in a suggester.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass (+ new) |
| Build | `npm run build` | exit 0 |

## Scope
**In scope:** `src/model/importGeojson.ts` (new — pure: FeatureCollection → note specs), `src/model/importGeojson.test.ts` (new), `src/vault/importOps.ts` (new — writes notes + sidecars for a campaign), `src/view/MapView.ts` (`importGeojson()` — pick a vault `.geojson`/`.json`, run import, Notice count), `src/main.ts` (`import-geojson` command).
**Out of scope:** Azgaar's native `.map` binary format, coordinate reprojection (assume the GeoJSON coords are already in the campaign's space — document this), network fetch, `src/gen/**`.

## Git workflow
- Branch `advisor/011-map-import`. Conventional commits ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push; no merge; don't edit `plans/README.md`.

## Steps
### Step 1: Pure importer
Create `src/model/importGeojson.ts`:
```ts
export interface ImportedNote { name: string; type: string; point: [number, number] | null; geojson: GeoJSON.Feature | null; }
/** Map a FeatureCollection to note specs. Point → point note; Line/Polygon →
 * sidecar-geojson note. Name from properties.name/title/id (fallback "Imported N").
 * type from properties.type if it's a known type, else a default per geometry. */
export function importGeojson(fc: unknown, knownTypes: string[]): ImportedNote[] {
  const out: ImportedNote[] = [];
  const feats = (fc as any)?.type === "FeatureCollection" && Array.isArray((fc as any).features) ? (fc as any).features : [];
  let n = 0;
  for (const f of feats) {
    n++;
    const props = f?.properties ?? {};
    const name = String(props.name ?? props.title ?? props.id ?? `Imported ${n}`).trim() || `Imported ${n}`;
    const g = f?.geometry;
    if (!g) continue;
    const rawType = typeof props.type === "string" ? props.type : "";
    if (g.type === "Point") {
      out.push({ name, type: knownTypes.includes(rawType) ? rawType : "landmark", point: g.coordinates as [number, number], geojson: null });
    } else if (g.type === "LineString" || g.type === "MultiLineString") {
      out.push({ name, type: knownTypes.includes(rawType) ? rawType : "route", point: null, geojson: f });
    } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      out.push({ name, type: knownTypes.includes(rawType) ? rawType : "district", point: null, geojson: f });
    }
  }
  return out;
}
export function sanitizeNoteName(name: string): string { return name.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Imported"; }
```
**Verify**: `npm run typecheck` → exit 0.

### Step 2: Unit-test
`src/model/importGeojson.test.ts`: point→point note (type mapped/defaulted); linestring→route sidecar note; polygon→district sidecar note; missing name→"Imported N"; non-FeatureCollection→[]; `sanitizeNoteName` strips illegal chars. Model on `connections.test.ts`.
**Verify**: `npm test` → pass incl. new.

### Step 3: Vault import op
`src/vault/importOps.ts`: `async importNotes(app, campaign, notes: ImportedNote[]): Promise<number>` — for each note: point notes via the existing create-a-point-note path (frontmatter `map`, `geometry:[x,y]`, `type`); sidecar notes: write `<campaign>/Locations/<sanitized>.geojson` (the feature) + a note `<campaign>/Locations/<sanitized>.md` with frontmatter `map`, `geometry: <relative sidecar path>`, `type`. Skip a note whose target `.md` already exists (idempotent). Return count created. Use `app.vault.create`; if it throws on a dup name, skip. No Node fs.
**Verify**: `npm run typecheck` → exit 0.

### Step 4: MapView + command
`MapView.importGeojson()`: suggester over vault files with extension `geojson` or `json`; read + `JSON.parse`; `importGeojson(parsed, LOCATION_TYPES)`; `await importNotes(...)`; `new Notice` with count (and a warning if 0). `main.ts`: `import-geojson` command → `void view.importGeojson()`.
**Verify**: `npm run typecheck` → exit 0; `npm test` → pass; `npm run build` → exit 0.

## Test plan
- Unit: `importGeojson` + `sanitizeNoteName` (Step 2).
- Manual (env-gated): drop a small GeoJSON FeatureCollection (a couple Points + a Polygon) into the vault, run `import-geojson` → notes created, points appear as pins, polygon note has a sidecar.

## Done criteria
- [ ] `npm run typecheck` exits 0; `npm test` passes incl. new `importGeojson` tests; `npm run build` exits 0
- [ ] `grep -n "importGeojson" src/model/importGeojson.ts src/view/MapView.ts` matches; `grep -n "import-geojson" src/main.ts` matches; `grep -n "importNotes" src/vault/importOps.ts` matches
- [ ] `grep -rn "from \"fs\"\|require('fs')" src/model/importGeojson.ts src/vault/importOps.ts` → nothing
- [ ] No files outside scope modified; `plans/README.md` not edited

## STOP conditions
- The point-note creation path (`createLocation` or equivalent) signature differs → match the real one.
- Sidecar-geometry frontmatter shape differs from `locationNote.ts`'s expectation → match the validator.
- A verification fails twice after a reasonable fix.

## Maintenance notes
- Follow-ups: Azgaar `.map` native parser, coordinate reprojection to campaign space, a preview/confirm step before creating N notes, dedup by proximity.
- Reviewer: confirm imported notes validate (no warning badges) and sidecar-geometry notes render.

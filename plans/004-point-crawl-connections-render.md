# Plan 004: Point-crawl connections — data model + rendering

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update this plan's status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3783bf9..HEAD -- src/model/locationNote.ts src/map/themes/index.ts src/map/theme.ts src/view/MapView.ts`
> Note: plans 001 and 003 also modify `src/view/MapView.ts`. If they have merged,
> the line numbers below will have shifted — locate the methods by name, not
> line number, and confirm the surrounding code still matches before editing.

## Status

- **Priority**: P1 (explicit feature request: point-crawl games)
- **Effort**: M
- **Risk**: LOW-MED (adds a source/layer + a schema field; existing render paths
  unchanged)
- **Depends on**: none functionally, but **merge after 001 and 003** (shared
  file `src/view/MapView.ts`) to avoid conflicts.
- **Category**: direction (feature)
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

Point-crawl / hex-crawl tabletop play is built on **explicit travel connections
between locations** — "you can go from the Brine Cathedral to Wrenhaven Docks."
The plugin has locations (points) but no way to express or show the *edges*
between them. This plan adds connections as a first-class, canon-native concept:
a `connections:` list in a location note's frontmatter (canon = notes), resolved
at reconcile time into line features and drawn as a themed layer that works
across **all five map styles** (each theme owns the paint, exactly like canon
pins). Straight lines between location points in v1; the plan is structured so
curved/waypointed paths and edge labels are cheap follow-ons.

This plan is **data + rendering only** — it makes connections declared in
frontmatter appear on the map. Creating/editing them from the UI is plan 005.

## Current state

- `src/model/locationNote.ts` — the Zod frontmatter schema
  (`LocationFrontmatterSchema`, lines 37-45), the `ParsedLocation` interface
  (49-62), `parseLocationNote` (70-111), and `locationToFeature` (113-129). This
  is where a `connections` field is added and parsed. Excerpt of the schema:
  ```ts
  export const LocationFrontmatterSchema = z.object({
    map: z.string().min(1),
    geometry: z.union([PointGeometry, z.string().min(1)]),
    type: z.string().min(1).default("custom"),
    aliases: z.array(z.string()).optional(),
    importance: z.number().int().min(1).max(9).optional(),
    "zoom-range": z.tuple([z.number(), z.number()]).optional(),
    icon: z.string().optional(),
  });
  ```
- `src/map/themes/index.ts:19-48` — `buildThemeStyle(...)` for the four
  handcrafted themes. Sources include `canon` and `generated` geojson sources
  (lines 28-34); layers are `background`, basemap, `generatedLayers(tokens)`,
  `canonLayers({...})` (lines 35-46).
- `src/map/theme.ts:64-92` — `obsidianNativeStyle(...)`. **Identical** source and
  layer structure to `buildThemeStyle`. Both must get the new source + layer.
- `src/view/MapView.ts`:
  - `refreshSource()` (around line 669) sets the `canon` source data from
    `this.plugin.getCampaignState(this.campaign.id).index.toFeatureCollection()`.
    A parallel `refreshConnections()` goes next to it.
  - `onIndexUpdated()` (around line 308) calls `refreshSource()` on vault
    rescans — the connection refresh hooks in here too.
  - `setCampaign()` (around line 193) rebuilds the style and, on `styledata`,
    calls `refreshSource()` — add the connection refresh there so connections
    survive a theme switch.
- `src/map/locationIndex.ts` — the per-campaign `LocationIndex`; `index.all()`
  returns every `ParsedLocation`. Use this to build connection features.

**Conventions to match:**
- Shared layer builders live in `src/map/themes/` and take an options object of
  resolved token strings — see `canonLayers.ts` (each theme calls it with its
  own tokens; the schema/logic is identical across themes). **Model
  `connectionLayers` on `canonLayers`.**
- Pure, testable model logic lives in `src/model/` with a colocated
  `*.test.ts` (Vitest) — see `src/model/locationNote.test.ts`.
- Layers are object literals cast `as unknown as LayerSpecification`.
- Feature `id`s use `hashStringToId(string)` (exported from `locationNote.ts`)
  for stable numeric ids.

## Commands you will need

| Purpose    | Command                            | Expected            |
|------------|------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                | exit 0              |
| Unit tests | `npm test`                         | all pass (+ new)    |
| Run 1 file | `npm test -- connections`          | the new test passes |
| Phase-1 gate | `npx tsx scripts/gates/phase1.ts` | writes-only here; see env note |

> Live gates need a running Obsidian + the `obsidian` CLI. If unavailable, still
> write the gate additions; hard-gate on typecheck + unit tests.

## Scope

**In scope:**
- `src/model/locationNote.ts` — add `connections` to schema + `ParsedLocation` +
  parse it.
- `src/model/connections.ts` (create) — pure `buildConnectionFeatures(...)`.
- `src/model/connections.test.ts` (create) — its unit tests.
- `src/map/themes/connectionLayers.ts` (create) — shared connection layer.
- `src/map/themes/index.ts` — add `connections` source + `connectionLayers` call.
- `src/map/theme.ts` — same additions to `obsidianNativeStyle`.
- `src/view/MapView.ts` — `refreshConnections()` + wire it into the refresh path.
- `dev-vault/Campaigns/Ashfall/Locations/*.md` — add `connections:` to 2 notes
  for a visible demo (see Step 6).
- `scripts/gates/phase1.ts` — add a connection-render check (write only).

**Out of scope (do NOT touch):**
- Any UI for *creating* connections — that's plan 005. This plan only renders
  what's declared in frontmatter.
- `src/gen/**` — connections are canon, not generated.
- Sidecar-geojson / curved paths / arrowheads / edge labels — deferred
  (v1 draws straight undirected lines between point locations).

## Git workflow

- Branch: `advisor/004-point-crawl-connections-render`
- Conventional commits; end each message with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Push the branch; do not merge to main.

## Steps

### Step 1: Extend the frontmatter schema + ParsedLocation

In `src/model/locationNote.ts`, add a connection sub-schema and field. Accept
either a bare string (target ref) or an object with optional metadata, so
frontmatter stays minimal but is forward-compatible with plan 005's labels:

```ts
const ConnectionSchema = z.union([
  z.string().min(1),
  z.object({ to: z.string().min(1), type: z.string().optional(), label: z.string().optional() }),
]);
```
Add to `LocationFrontmatterSchema`: `connections: z.array(ConnectionSchema).optional(),`.

Add to `ParsedLocation`:
```ts
connections: { to: string; type: string | null; label: string | null }[];
```
And populate it in `parseLocationNote`'s returned object:
```ts
connections: (fm.connections ?? []).map((c) =>
  typeof c === "string" ? { to: c, type: null, label: null } : { to: c.to, type: c.type ?? null, label: c.label ?? null }
),
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Pure connection-feature builder

Create `src/model/connections.ts`. It resolves each location's `connections`
targets to other locations and emits deduped `LineString` features. Target
resolution handles wikilink form `[[Name]]`, a vault path, a basename, or an
alias — in that priority:

```ts
import type { ParsedLocation } from "./locationNote";
import { hashStringToId } from "./locationNote";

function normalizeRef(ref: string): string {
  // strip [[ ]] and any |alias or #heading, keep the target
  const m = ref.match(/^\[\[([^\]|#]+)/);
  return (m ? m[1] : ref).trim();
}

function resolveTarget(ref: string, byPath: Map<string, ParsedLocation>, byName: Map<string, ParsedLocation>): ParsedLocation | null {
  const raw = ref.trim();
  if (byPath.has(raw)) return byPath.get(raw)!;
  const n = normalizeRef(raw);
  return byName.get(n) ?? byPath.get(n) ?? null;
}

/** Straight undirected line features for every resolvable connection between
 * two point locations. Deduped by unordered id pair (A→B and B→A collapse). */
export function buildConnectionFeatures(locations: ParsedLocation[]): GeoJSON.Feature[] {
  const byPath = new Map(locations.map((l) => [l.path, l]));
  const byName = new Map<string, ParsedLocation>();
  for (const l of locations) {
    byName.set(l.name, l);
    for (const a of l.aliases) byName.set(a, l);
  }
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const src of locations) {
    if (!src.point) continue;
    for (const conn of src.connections) {
      const tgt = resolveTarget(conn.to, byPath, byName);
      if (!tgt || !tgt.point || tgt.path === src.path) continue;
      const key = [src.path, tgt.path].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        id: hashStringToId(key),
        geometry: { type: "LineString", coordinates: [src.point, tgt.point] },
        properties: { id: key, from: src.path, to: tgt.path, type: conn.type, label: conn.label },
      });
    }
  }
  return features;
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Unit-test the builder

Create `src/model/connections.test.ts`, modeled on
`src/model/locationNote.test.ts`. Cover: (a) a resolvable pair produces one
LineString; (b) A→B and B→A dedupe to a single feature; (c) a connection to a
name that doesn't exist is skipped (no throw); (d) a connection to a
sidecar-only location (`point: null`) is skipped; (e) wikilink form `[[Name]]`
resolves; (f) alias resolves. Build `ParsedLocation` fixtures inline.

**Verify**: `npm test -- connections` → the new test passes; `npm test` → all
pass.

### Step 4: Shared connection layer

Create `src/map/themes/connectionLayers.ts`, modeled on `canonLayers.ts`:

```ts
import type { LayerSpecification } from "maplibre-gl";

/** Point-crawl travel connections — one dashed line layer, themed via tokens so
 * it reads consistently across every map style (parchment → neon-sprawl). Drawn
 * above terrain/basemap, below canon pins/labels. */
export function connectionLayers(opts: { lineColor: string }): LayerSpecification[] {
  return [
    {
      id: "connection-line",
      type: "line",
      source: "connections",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": opts.lineColor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 14, 2.5],
        "line-dasharray": [2, 2],
        "line-opacity": 0.8,
      },
    } as unknown as LayerSpecification,
  ];
}
```

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Register the source + layer in both style builders

In **`src/map/themes/index.ts`**: import `connectionLayers`; add to `sources`:
```ts
connections: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
```
and insert into `layers` **between** `...generatedLayers(tokens)` and
`...canonLayers({...})`:
```ts
...connectionLayers({ lineColor: tokens.accent }),
```

In **`src/map/theme.ts`** `obsidianNativeStyle`: the exact same two additions
(import `connectionLayers`, add the `connections` source, insert
`...connectionLayers({ lineColor: t.accent })` between generated and canon
layers).

Placing the layer before `canonLayers` ensures lines draw **under** pins/labels
(you click the place, not the string). Using `accent` gives a visible, themed
color in all five themes (obsidian-native's `accent` = `--interactive-accent`).

**Verify**: `npm run typecheck` → exit 0.

### Step 6: Feed the source from the index + seed a demo

In `src/view/MapView.ts`, add next to `refreshSource()`:
```ts
private refreshConnections(): void {
  if (!this.map || !this.campaign) return;
  const source = this.map.getSource("connections") as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  const locations = this.plugin.getCampaignState(this.campaign.id).index.all();
  source.setData({ type: "FeatureCollection", features: buildConnectionFeatures(locations) });
}
```
Import `buildConnectionFeatures` from `../model/connections`. Call
`this.refreshConnections()`:
- at the end of `refreshSource()` (so every index update refreshes lines), **or**
  in `onIndexUpdated()` right after `refreshSource()`;
- in `setCampaign()`'s `styledata` callback right after `this.refreshSource()`
  (so a theme/basemap switch re-adds the lines to the new style);
- in the `map.on("load", ...)` handler after `refreshSource()`.

Then seed a visible demo: pick two existing Ashfall location notes under
`dev-vault/Campaigns/Ashfall/Locations/` that both have point `geometry`, and
add to one of them a frontmatter line:
```yaml
connections: [OtherLocationBasename]
```
(use the other note's exact basename). This gives the gate + a human something
to see.

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass.

### Step 7: Gate check (write only)

In `scripts/gates/phase1.ts`, after Ashfall is open and reconciled, add an
`evalJs` check following the file's idiom:
```js
var map = app.plugins.plugins['campaign-map'].map;
var src = map.getSource('connections');
var data = src ? src._data : null;   // the FeatureCollection last set
JSON.stringify({ hasLayer: !!map.getLayer('connection-line'), lineCount: data ? data.features.length : 0 });
```
Assert `hasLayer` is true and `lineCount >= 1` (from the Step 6 seed).

**Verify (if app available)**: `npx tsx scripts/gates/phase1.ts` → passes incl.
the new check. If not available, leave it written and unrun.

## Test plan

- **Unit (required)**: `src/model/connections.test.ts` — the 6 cases in Step 3.
  This is the real regression test; it must pass and would fail against a broken
  resolver/dedup.
- **Schema**: confirm `parseLocationNote` still succeeds for notes *without*
  `connections` (optional field) — add one assertion to
  `locationNote.test.ts` or cover it in the connections test via
  `parseLocationNote`.
- **App gate**: the Step 7 check proves the layer exists and the seeded
  connection renders.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 including the new `connections` test (≥6 new cases)
- [ ] `grep -rn "connection-line" src/map` shows the layer in
      `connectionLayers.ts` and is wired via both style builders
      (`grep -rn "connectionLayers" src/map` → matches in `themes/index.ts` and
      `theme.ts`)
- [ ] `grep -n "refreshConnections" src/view/MapView.ts` → defined and called
- [ ] A note under `dev-vault/Campaigns/Ashfall/Locations/` has a `connections:`
      frontmatter entry (`grep -rn "^connections:" dev-vault/Campaigns/Ashfall`)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

- The schema / `ParsedLocation` / style-builder excerpts don't match the live
  code (drift, or 001/003 refactored `refreshSource`/`MapView` differently than
  expected) — re-locate by symbol name; if the structure is materially
  different, STOP and report.
- `index.all()` no longer exists or no longer returns `ParsedLocation[]`.
- Adding the `connections` source breaks an existing gate/style assertion — STOP
  and report the exact failure.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Plan 005 (interaction) writes these frontmatter `connections` and will add
  edge labels/types — the `type`/`label` properties are already carried on the
  line feature, so 005 only adds a symbol layer + write UI.
- Follow-ups deferred here: curved/waypointed paths (sidecar geojson, like
  complex canon geometry), directional arrowheads (one-way passages), travel-time
  edge labels, and per-connection-type styling (road vs. river vs. secret
  tunnel) — all extend `connectionLayers` and the feature `properties`.
- A reviewer should confirm connections re-render after a theme switch (the
  `styledata` wiring in Step 6) and after rename/delete of a linked note (the
  `onIndexUpdated` wiring) — a deleted endpoint should make its lines vanish.

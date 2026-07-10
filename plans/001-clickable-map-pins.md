# Plan 001: Make map pins reliably clickable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3783bf9..HEAD -- src/view/MapView.ts src/map/themes/canonLayers.ts`
> If `src/view/MapView.ts` changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

The map dots are 3–7px radius circles (`canonLayers.ts:39`), and the click
handler hit-tests a **single exact pixel** with no tolerance
(`MapView.ts:706`). Missing a 6px target by one pixel silently drops you into
the "add a new location here" flow instead of opening the place you were aiming
at — the single most-reported daily annoyance. Two worse sub-cases exist:

1. When zoomed out past a location's `minZoom`, only the small
   `canon-point-far` dot renders — but the click handler only queries the
   `canon-point` layer, so **clicking a visible dot does literally nothing**.
2. Generated settlement dots (`generated-point` / `generated-point-far`) are not
   hit-tested at all, so a GM cannot click a generated town to do anything with
   it.

The fix is an invisible hit *tolerance* (a small query box) plus querying the
far/label layers — **not** enlarging the visible dots, which would fight the
product's cartographic-discipline bar (label collisions). After this, clicking
"on or near" any dot — canon or generated, at any zoom — does the right thing.

## Current state

- `src/view/MapView.ts` — the map ItemView. Relevant methods:
  - `handleClick(e)` at **lines 704–712** — the exact-pixel query:
    ```ts
    private handleClick(e: MapMouseEvent): void {
      if (!this.map || !this.campaign) return;
      const features = this.map.queryRenderedFeatures(e.point, { layers: ["canon-point"] });
      if (features.length > 0) {
        this.showPlaceCard(features[0]);
      } else {
        this.showDroppedPin(e.lngLat);
      }
    }
    ```
  - `showPlaceCard(feature)` at **lines 809–849** — builds the canon place-card
    popup; requires a Point feature whose `properties.id` resolves to a location
    in the index. Note it early-returns unless `feature.geometry.type === "Point"`
    (so a `canon-label` symbol feature, which shares the same Point geometry, is
    fine to pass).
  - `handleDragStart(e)` at **lines 762–807** — also does an exact
    `queryRenderedFeatures(e.point, { layers: ["canon-point"] })` at line 764.
  - `canonizeGeneratedNear(point?, maxDistanceMeters?)` at **lines 591–630** —
    already exists; finds the nearest loaded generated Point feature to a
    display-space point and canonizes it (creates the note). Returns
    `Promise<boolean>` (false if nothing within range). This is the action a
    generated-dot click should offer.
- `src/map/themes/canonLayers.ts` — defines layer ids `canon-point-far`,
  `canon-point`, `canon-label`. `canon-point-far` is filtered to
  `["<", ["zoom"], ["get", "minZoom"]]` (only shows when zoomed out past
  minZoom); `canon-point`/`canon-label` show within the type's zoom range.
- `src/map/themes/generatedLayers.ts` — defines `generated-point-far`,
  `generated-point`, `generated-label` for `world-settlement` features on the
  `"generated"` source.

**Repo conventions to match:**
- Interaction code lives in `MapView.ts` as `private handle*` / `private show*`
  methods; DOM popups are built with `document.createElement` + Obsidian's
  `.addClass`/`.createEl`/`.createDiv` helpers (see `showPlaceCard`,
  `showDroppedPin`). Follow that exact style for any new popup.
- Test API is exposed at `app.plugins.plugins['campaign-map']` (docs/05,
  `src/main.ts:54`). Gates drive the live app through `evalJs(...)` strings that
  reach into that object and into `.map` (the MapLibre instance). Anything you
  need a gate to verify must be reachable from there.
- MapLibre's `queryRenderedFeatures` accepts either a point `[x,y]` **or a
  bounding box `[[x0,y0],[x1,y1]]`** in screen pixels; the bbox form is the
  tolerance mechanism. `map.project(lngLat)` → screen point,
  `map.unproject([x,y])` → lngLat.

## Commands you will need

| Purpose   | Command                     | Expected on success |
|-----------|-----------------------------|---------------------|
| Typecheck | `npm run typecheck`         | exit 0, no errors   |
| Unit tests| `npm test`                  | all pass            |
| App gate  | `npx tsx scripts/gates/phase1.ts` | all checks pass (13/13) — this is the gate that asserts the click→place-card and click-empty→add flows |

> The app gate drives a live Obsidian instance via the official CLI. If the
> environment has no running dev-vault Obsidian / CLI (`obsidian` command
> unavailable), you cannot run it — see STOP conditions. Typecheck + unit tests
> must still pass regardless.

## Scope

**In scope** (the only files you should modify):
- `src/view/MapView.ts`
- `scripts/gates/phase1.ts` — *add* one hit-tolerance check (do not remove or
  weaken existing checks).

**Out of scope** (do NOT touch):
- `src/map/themes/canonLayers.ts` and `generatedLayers.ts` — do **not** change
  `circle-radius` or any paint. Enlarging dots is explicitly rejected; the fix
  is tolerance in the query, not bigger targets.
- The naming/generation pipeline, `src/gen/**` — untouched.
- The place-card popup content/actions (`showPlaceCard` body) beyond what's
  needed to accept a feature picked with tolerance.

## Git workflow

- Branch: `advisor/001-clickable-map-pins`
- Commit per logical step; message style matches `git log` (conventional,
  lowercase prefix): e.g. `fix: hit-test map pins with a pixel tolerance so
  small dots are clickable`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add a tolerance-based feature picker

In `MapView.ts`, add a private helper that queries a small screen-space box
around a click point across a given set of layers and returns the single
feature whose projected location is closest to the click (so overlapping dots
resolve deterministically to the nearest one):

```ts
/** Hit-test with a pixel tolerance (default 8px) instead of an exact point,
 * so 3–7px dots are clickable when the cursor is merely near them. Returns the
 * candidate whose projected position is closest to `screenPoint`, or null. */
private pickFeatureNear(
  screenPoint: maplibregl.Point,
  layers: string[],
  radius = 8
): MapGeoJSONFeature | null {
  if (!this.map) return null;
  const existing = layers.filter((l) => this.map!.getLayer(l));
  if (existing.length === 0) return null;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [screenPoint.x - radius, screenPoint.y - radius],
    [screenPoint.x + radius, screenPoint.y + radius],
  ];
  const candidates = this.map.queryRenderedFeatures(box, { layers: existing });
  let best: MapGeoJSONFeature | null = null;
  let bestDist = Infinity;
  for (const f of candidates) {
    if (f.geometry.type !== "Point") continue;
    const p = this.map.project(f.geometry.coordinates as [number, number]);
    const d = Math.hypot(p.x - screenPoint.x, p.y - screenPoint.y);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}
```

Note `map.getLayer(l)` guards against querying a layer that doesn't exist in the
current style (e.g. `generated-*` layers only exist once a `generated` source is
present) — `queryRenderedFeatures` throws on an unknown layer id, so filtering
first is required.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Route clicks through the picker (canon first, then generated)

Rewrite `handleClick` so it:
1. Tries canon layers **including the far dot and the label**, with tolerance.
2. If none, tries generated settlement layers with tolerance.
3. Only if both miss, falls through to the dropped-pin "add here" flow.

```ts
private handleClick(e: MapMouseEvent): void {
  if (!this.map || !this.campaign) return;
  const canon = this.pickFeatureNear(e.point, ["canon-point", "canon-point-far", "canon-label"]);
  if (canon) {
    this.showPlaceCard(canon);
    return;
  }
  const generated = this.pickFeatureNear(e.point, ["generated-point", "generated-point-far", "generated-label"]);
  if (generated) {
    this.showGeneratedCard(generated, e.lngLat);
    return;
  }
  this.showDroppedPin(e.lngLat);
}
```

`showPlaceCard` already accepts a Point feature and resolves it via
`properties.id`; a feature picked from `canon-label` has the same Point geometry
and the same `id` property, so it works unchanged.

**Verify**: `npm run typecheck` → exit 0 (will still fail to compile until
Step 3 adds `showGeneratedCard`; that's expected — proceed to Step 3, then
verify).

### Step 3: Add a minimal card for generated-settlement clicks

Generated features are not canon, so `showPlaceCard` (which looks them up in the
canon index) does not apply. Add a small popup offering the one meaningful
action — turn it into canon — reusing the existing `canonizeGeneratedNear`
path. Model the DOM on `showDroppedPin` (lines 851–876):

```ts
private showGeneratedCard(feature: MapGeoJSONFeature, lngLat: maplibregl.LngLat): void {
  if (!this.map || !this.campaign || feature.geometry.type !== "Point") return;
  this.droppedPinPopup?.remove();
  this.placeCardPopup?.remove();

  const name = String(feature.properties?.name ?? "Unnamed");
  const type = String(feature.properties?.type ?? "settlement");

  const el = document.createElement("div");
  el.addClass("campaign-map-place-card");
  el.createEl("h4", { text: name });
  el.createDiv({ cls: "campaign-map-place-card-preview", text: `Generated ${type} — not yet canon.` });

  const actions = el.createDiv({ cls: "campaign-map-place-card-actions" });
  const at = feature.geometry.coordinates as [number, number];
  actions.createEl("button", { text: "Add to canon" }).onclick = () => {
    void this.canonizeGeneratedNear(at).then((ok) => {
      this.placeCardPopup?.remove();
      new Notice(ok ? `Campaign Map: "${name}" is now canon` : "Campaign Map: could not canonize");
    });
  };

  this.placeCardPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "campaign-map-place-card-popup" })
    .setLngLat(feature.geometry.coordinates as [number, number])
    .setDOMContent(el)
    .addTo(this.map);
}
```

`Notice` is already imported at the top of `MapView.ts` (line 1). `canonizeGeneratedNear`
takes a display-space point and defaults `maxDistanceMeters` to 40; passing the
clicked feature's own coordinates guarantees it resolves to that feature.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Widen the drag-start hit test too

In `handleDragStart` (line ~764), replace the exact query with the tolerant
picker so a drag that starts a pixel off the dot still grabs it:

```ts
const feature = this.pickFeatureNear(e.point, ["canon-point", "canon-point-far", "canon-label"]);
if (!feature) return;
```

Leave the rest of `handleDragStart` unchanged. (The `mousedown` is still
registered on the `canon-point` layer, so this only fires when the pointer is
already on/near a canon dot — the tolerance just makes the subsequent pick
robust.)

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass.

### Step 5: Add a hit-tolerance regression check to the phase-1 gate

Open `scripts/gates/phase1.ts`. It already opens the Ashfall campaign, has at
least one known canon location, and drives the live map via `evalJs`. Add one
check that proves a *near-miss* click resolves to the location. Follow the
existing `evalJs` idiom in that file. The check should:

1. Pick a known canon location's screen position via
   `app.plugins.plugins['campaign-map'].map.project([lng,lat])`.
2. Call the view's picker at an offset a few pixels away from center, and assert
   it returns that location's feature (non-null), whereas the old exact
   `queryRenderedFeatures(point,...)` at the same offset would return empty.

To make the picker reachable from a gate, expose it via a thin test method on
the view (add to `MapView.ts`, near the other public methods like
`generated`):

```ts
/** Test surface (docs/05): does a tolerant hit-test at a screen point find a
 * canon feature? Returns the location id or null. */
hitTestCanonAt(x: number, y: number): string | null {
  const f = this.pickFeatureNear(new maplibregl.Point(x, y), ["canon-point", "canon-point-far", "canon-label"]);
  return (f?.properties?.id as string | undefined) ?? null;
}
```

Then the gate check (adapt variable names / the exact known location to what
`phase1.ts` already sets up — do not hardcode a new campaign):

```js
// hit tolerance: a click 6px off a dot still resolves to it
var view = app.workspace.getLeavesOfType('campaign-map-view')[0].view;
var loc = app.plugins.plugins['campaign-map'].getCampaignState(CAMPAIGN).index.all().find(function(l){return l.point;});
var sp = view.map.project(loc.point);
var hit = view.hitTestCanonAt(sp.x + 6, sp.y + 6);   // near-miss
var exact = view.map.queryRenderedFeatures([sp.x + 6, sp.y + 6], {layers:['canon-point']}).length;
JSON.stringify({ hit: hit, exactMissed: exact === 0 });
```

Assert `hit` is non-null (tolerant pick succeeds) **and** `exactMissed` is true
(demonstrating the old behavior would have missed). If the location's dot is
large enough at the gate's zoom that even the exact query hits, increase the
offset until `exactMissed` is true, so the check genuinely exercises tolerance.

**Test-validity caveat**: the picked location must actually *render* a
`canon-point` / `canon-point-far` dot at the gate's current zoom (that depends
on its `minZoom`/`maxZoom`). If `view.hitTestCanonAt` at the dot's own center
returns null, the dot isn't on screen at this zoom — pick a different location
(or `flyTo` a zoom inside its range) rather than reading the null as a failure
of the fix.

**Verify**: `npx tsx scripts/gates/phase1.ts` → all checks pass, including the
new one. (If the app/CLI isn't available in this environment, see STOP
conditions — do not delete the check to make the suite "pass".)

## Test plan

- **Unit**: no new pure-logic unit test is required (the change is
  MapLibre-interaction glue with no branch-heavy pure function). Existing
  `npm test` must stay green.
- **App gate**: the new `phase1.ts` check above is the regression test — it
  encodes exactly the bug (near-miss click) and proves the fix. It must fail
  against the pre-fix `handleClick` and pass after.
- **Manual smoke (if a human/agent can drive the app)**: at a zoom *below* a
  location's `minZoom` (so only `canon-point-far` shows), click the small dot —
  the place card must open (previously it did nothing). Click a generated
  settlement dot — the "Add to canon" card must open.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (existing suite unchanged, still green)
- [ ] `npx tsx scripts/gates/phase1.ts` passes including the new hit-tolerance
      check (or, if the app/CLI is unavailable, this is a STOP condition — do
      not skip it silently)
- [ ] `grep -n 'queryRenderedFeatures(e.point, { layers: \["canon-point"\] })' src/view/MapView.ts`
      returns **no matches** (both the click and drag exact-point queries are
      gone)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `handleClick` / `handleDragStart` code at the cited lines does not match
  the "Current state" excerpts (the file drifted since 3783bf9).
- `canonizeGeneratedNear` no longer exists or its signature changed — Step 3
  depends on it.
- The app gate cannot run because the dev-vault Obsidian / official CLI is not
  available in this environment. Report that typecheck + unit tests pass and the
  gate check is written but unrun, and hand back for a human to run the gate —
  do **not** weaken or delete the gate check to make things green.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The tolerance radius (8px) is a single constant in `pickFeatureNear`. If dots
  are ever restyled larger/smaller, revisit it, but the tolerance should remain
  ≥ the visible radius so "near" always works.
- If a future plan makes generated features draggable or adds more generated
  point types, extend the layer lists passed to `pickFeatureNear` accordingly
  (keep the `getLayer` guard — querying a nonexistent layer throws).
- Reviewer should scrutinize: that `showGeneratedCard` and `showPlaceCard`
  correctly `.remove()` each other's popups (no two cards open at once), and
  that the `getLayer` filter prevents a throw when the `generated` source is
  absent (fresh campaign with no generation yet).

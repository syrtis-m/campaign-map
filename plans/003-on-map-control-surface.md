# Plan 003: On-map control surface (visible toolbar over the map)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3783bf9..HEAD -- src/view/MapView.ts src/main.ts styles.css`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive UI overlay; no change to existing behavior)
- **Depends on**: none
- **Category**: direction / dx (UX)
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

Every builder action beyond click-to-add is **invisible** — buried in the
command palette: "Generate world fabric here", "Generate city fabric here",
"Canonize nearest generated feature", "Search locations", "Switch map theme",
"Campaign settings" (`src/main.ts:113-219`). A new user opens a campaign to a
map with only a scale bar and has no on-screen way to discover that they can
generate a world, add a place, or reskin the map. This is the core of the "lack
of a full UX" pain point: the capability exists, the *surface* doesn't.

This plan adds a small **DOM toolbar overlaid on the map canvas** that surfaces
the highest-value actions as visible, clickable buttons wired to the methods
that already exist. Deliberately DOM-based, not Obsidian's native `Menu`:
PROGRESS.md records that native `Menu.showAtPosition()` is **not verifiable under
CLI automation** (5 failed attempts), whereas DOM controls following the
existing place-card pattern *are* verifiable — which the plan's done-criteria
require. No new backend, no new generation logic; this is pure surfacing.

## Current state

- `src/view/MapView.ts` — the map ItemView. Every action the toolbar needs is
  **already a method here** and already guards on `this.campaign`:
  - `generateCityHere(point?, force?)` (line 548) and
    `generateWorldHere(point?, force?)` (line 568) — return `Promise<Feature[]>`.
  - `canonizeGeneratedNear(point?, maxDistanceMeters?)` (line 591) — `Promise<boolean>`.
  - `openSearch()` (line 312), `switchTheme()` (line 204),
    `openQuickAdd(point)` (line 345) — all public.
  - `onOpen()` (line 243) already builds DOM overlays via
    `container.createDiv({ cls: ... })` — the scale bar, warning badge, and
    loading indicator (lines 248-254). **Follow this exact pattern** for the
    toolbar.
  - `bandForZoom` is already imported (line 14) — use it to make one "Generate
    here" button do the right thing for the current zoom (world tier below zoom
    8, city tier at/above).
  - `this.map!.getCenter()` gives the current center as `{lng, lat}`.
- `src/main.ts`:
  - `activeMapView()` (line 99) — how the plugin finds the current view.
  - `openControlPanel()` (line 468) is **`private`** — the toolbar's Settings
    button needs it public. This is the only `main.ts` change.
- `styles.css` (197 lines) — overlay styling convention. The loading indicator
  (lines 78-93) is the pattern to copy: `position: absolute`, a `z-index`,
  themed with Obsidian CSS vars (`var(--background-secondary)`,
  `var(--text-muted)`, `var(--font-text)`), rounded corners. The map canvas
  (`.campaign-map-canvas`) is the positioned ancestor.

**Repo conventions to match:**
- Build DOM with Obsidian helpers: `container.createDiv({ cls })`,
  `el.createEl("button", { text })`, and `setIcon(el, "lucide-name")` from the
  `obsidian` module for icons. Import `setIcon` alongside the existing
  `obsidian` imports at the top of `MapView.ts` (line 1).
- User feedback uses `new Notice("Campaign Map: ...")` (already imported).
- CSS classes are prefixed `campaign-map-`.
- Test API is `app.plugins.plugins['campaign-map']`; gates reach the view via
  `app.workspace.getLeavesOfType('campaign-map-view')[0].view` and its
  `contentEl`. Anything a gate must verify has to be in that DOM.

## Commands you will need

| Purpose    | Command                              | Expected on success |
|------------|--------------------------------------|---------------------|
| Typecheck  | `npm run typecheck`                  | exit 0              |
| Unit tests | `npm test`                           | all pass            |
| Phase-3 gate | `npx tsx scripts/gates/phase3.ts`  | all pass (asserts generation works — the toolbar's generate button drives the same path) |

> Gates need the live dev-vault Obsidian + official CLI. If unavailable,
> typecheck + unit tests must still pass; see STOP conditions.

## Scope

**In scope** (the only files you should modify):
- `src/view/MapView.ts` — add the toolbar overlay + its handlers.
- `src/main.ts` — change `private openControlPanel()` to `openControlPanel()`
  (make public). Nothing else in this file.
- `styles.css` — add `.campaign-map-toolbar` styling.
- `scripts/gates/phase3.ts` — *add* a toolbar-presence check (don't weaken
  existing checks). Optional but recommended.

**Out of scope** (do NOT touch):
- The generation methods themselves and `src/gen/**` / `src/map/generation/**` —
  the toolbar only *calls* existing methods; it changes none of them.
- The command palette registrations in `main.ts` (lines 113-219) — leave them;
  the toolbar is *additive*, power users keep the commands.
- Native Obsidian `Menu` — do not use it (unverifiable under CLI). DOM only.
- Any change to `QuickAddModal` / `CampaignControlModal` / `ThemeSwitcherModal`.

## Git workflow

- Branch: `advisor/003-on-map-toolbar`
- Commit message style (conventional, per `git log`): e.g.
  `feat: add an on-map toolbar surfacing generate/add/canonize/search/settings`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Make `openControlPanel` public in `main.ts`

Change the declaration at `src/main.ts:468` from `private openControlPanel()`
to `openControlPanel()`. No other change.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Build the toolbar in `MapView.onOpen()`

Import `setIcon`:
```ts
import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, MarkdownRenderer, Notice, TFile, setIcon } from "obsidian";
```

Add a field near the other overlay fields (around line 114):
```ts
private toolbarEl!: HTMLDivElement;
```

In `onOpen()`, after the loading indicator is created (line ~254), build the
toolbar. Each button is icon + tooltip; clicking runs the matching method:

```ts
this.toolbarEl = container.createDiv({ cls: "campaign-map-toolbar" });
this.buildToolbar();
```

Add the builder method (place it near the other `private` UI methods):
```ts
private buildToolbar(): void {
  this.toolbarEl.empty();
  const btn = (icon: string, label: string, onClick: () => void): void => {
    const b = this.toolbarEl.createEl("button", { cls: "campaign-map-toolbar-btn", attr: { "aria-label": label, title: label } });
    setIcon(b, icon);
    b.onclick = onClick;
  };

  btn("plus", "Add location at center", () => {
    if (!this.map) return;
    const c = this.map.getCenter();
    this.openQuickAdd([c.lng, c.lat]);
  });

  // One "Generate here" that picks the tier from the current zoom, so the GM
  // doesn't have to know the world/city band distinction.
  btn("wand-2", "Generate fabric here", () => {
    if (!this.map) return;
    const band = bandForZoom(this.map.getZoom());
    const run = band === "world" ? this.generateWorldHere() : this.generateCityHere();
    void run.then((f) => new Notice(`Campaign Map: generated ${f.length} ${band} feature${f.length === 1 ? "" : "s"}`));
  });

  btn("stamp", "Canonize nearest generated feature", () => {
    void this.canonizeGeneratedNear().then((ok) =>
      new Notice(ok ? "Campaign Map: canonized nearest feature" : "Campaign Map: nothing generated nearby to canonize")
    );
  });

  btn("search", "Search locations", () => this.openSearch());
  btn("palette", "Switch map theme", () => this.switchTheme());
  btn("settings", "Campaign settings", () => this.plugin.openControlPanel());
}
```

`bandForZoom` returns `"world" | "city"` (`src/gen/cache/tileGrid.ts`). All the
called methods already no-op safely when there's no campaign or the campaign is
real-city (generation is fictional-only), so the buttons are safe to always show.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Rebuild the toolbar when the campaign changes (title/state refresh)

`setCampaign()` (line 181) already refreshes the header title. The toolbar is
static (same buttons for any campaign), so it does **not** need rebuilding on
campaign switch — build once in `onOpen()` and leave it. Do **not** add a
`buildToolbar()` call to `setCampaign()`; that would needlessly rebuild DOM on
every location rescan.

(This step is a deliberate no-op confirmation — recorded so you don't add churn.)

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Style the toolbar in `styles.css`

Append a block modeled on `.campaign-map-loading-indicator` (top-**left** so it
doesn't collide with the top-right loading indicator):

```css
.campaign-map-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 6;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--background-secondary, #222);
  border: 1px solid var(--background-modifier-border, #3a3a3a);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.campaign-map-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #aaa);
  cursor: pointer;
}

.campaign-map-toolbar-btn:hover {
  background: var(--background-modifier-hover, #333);
  color: var(--text-normal, #ddd);
}
```

**Verify**: `npm run typecheck` → exit 0 (CSS isn't typechecked, but confirm the
build still compiles). `npm test` → all pass.

### Step 5: Add a toolbar-presence + wiring check to the phase-3 gate

In `scripts/gates/phase3.ts`, after a fictional campaign (Ashfall) is open, add
a check following the file's `evalJs` idiom:

```js
var view = app.workspace.getLeavesOfType('campaign-map-view')[0].view;
var bar = view.contentEl.querySelector('.campaign-map-toolbar');
var buttons = bar ? bar.querySelectorAll('.campaign-map-toolbar-btn').length : 0;
JSON.stringify({ hasToolbar: !!bar, buttonCount: buttons });
```

Assert `hasToolbar` is true and `buttonCount` is 6.

Then, to prove the generate button is actually wired (not just present), click
it and confirm generation runs. Follow the gate's existing await/poll pattern:

```js
// zoom to world band so "Generate here" produces world fabric, then click it
view.map.setZoom(5);
view.contentEl.querySelectorAll('.campaign-map-toolbar-btn')[1].click(); // the "Generate fabric here" button
'clicked';
```
then poll `app.plugins.plugins['campaign-map'].generated.length` until `> 0`
(reuse whatever polling helper `phase3.ts` already uses for generation checks;
generation is async).

**Test-validity caveat**: `view.map.setZoom(5)` fires `zoomend`, which also
triggers the view's debounced viewport dispatcher — so `generated.length > 0`
could become true from the automatic dispatch, not from your button click,
making this a weak "is the button wired" test. To isolate the button: capture
`before = generated.length` *after* the setZoom-triggered dispatch has settled
(poll until it stops changing), then click the button and assert the count
increases beyond `before` — or, more simply, assert the button's `onclick` is a
function and that clicking it does not throw, and rely on the manual smoke test
for the full wiring. Either is acceptable; just don't claim the naive
`> 0`-after-click proves wiring when the dispatcher confounds it.

**Verify**: `npx tsx scripts/gates/phase3.ts` → all pass including the new
checks.

## Test plan

- **Unit**: none required — this is DOM-wiring glue calling already-tested
  methods. Existing `npm test` stays green.
- **App gate**: the `phase3.ts` additions are the regression test — they prove
  (a) the toolbar renders with all 6 buttons and (b) the generate button is
  wired to real generation.
- **Manual smoke (if a human/agent can drive the app)**: open Ashfall; confirm a
  6-button toolbar sits top-left; click "Add location at center" → QuickAdd
  opens; click "Generate fabric here" at world zoom → a Notice reports N
  features and terrain appears; "Settings" → the control modal opens; "Theme" →
  the theme switcher opens.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (existing suite unchanged, still green)
- [ ] `grep -n 'campaign-map-toolbar' src/view/MapView.ts styles.css` shows
      matches in both files
- [ ] `grep -n 'private openControlPanel' src/main.ts` returns **no matches**
      (it was made public)
- [ ] `npx tsx scripts/gates/phase3.ts` passes including the toolbar-presence
      and generate-wiring checks — or, if the app/CLI is unavailable, that is a
      STOP condition, not something to skip silently
- [ ] No file outside the in-scope list is modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The overlay-building pattern in `onOpen()` or the generation method signatures
  don't match the "Current state" excerpts (drift since 3783bf9).
- `bandForZoom` no longer returns `"world" | "city"` or is no longer imported in
  `MapView.ts` — Step 2's tier logic depends on it.
- Making `openControlPanel` public breaks a caller expecting it private (it
  won't — widening visibility is safe — but if typecheck complains, report it).
- The app gate cannot run because the dev-vault Obsidian / official CLI is
  unavailable. Report typecheck + unit tests pass and the toolbar is written but
  the live gate is unrun; hand back for a human to run it. Do not delete the
  gate check to go green.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- This toolbar is the **DOM-overlay foundation** the Direction items in
  `plans/README.md` build on (empty-state onboarding, a layer/legend panel,
  batch-canonize). Keep `buildToolbar()` simple and data-light so those can
  extend it.
- If plan 001 (clickable pins) also lands, the "Add to canon" affordance for a
  clicked generated feature lives in 001's `showGeneratedCard`; the toolbar's
  "Canonize nearest" is the center-of-map complement. They don't conflict — one
  is click-targeted, one is center-targeted.
- A reviewer should confirm the toolbar (top-left, z-index 6) doesn't overlap
  the warning badge or loading indicator (top-right) at narrow widths, and that
  buttons remain legible in both light and dark Obsidian themes (they inherit
  `--text-muted`/`--background-secondary`, so they should).
- Real-city campaigns show the same toolbar; "Generate fabric here" no-ops
  there (generation is fictional-only) and returns an empty array → the Notice
  reports "generated 0 features," which is acceptable but a future refinement
  could hide/disable generation buttons for real-city campaigns.

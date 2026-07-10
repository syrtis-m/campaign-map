# Plan 005: Point-crawl connections — create / edit / delete from the UI

> **Executor instructions**: Follow step by step; run every verification; honor
> STOP conditions; update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 3783bf9..HEAD -- src/view/MapView.ts src/model/locationNote.ts src/map/themes/connectionLayers.ts`
> Locate methods by name (plans 001/003/004 also touch `MapView.ts`).

## Status

- **Priority**: P1 (completes the point-crawl feature)
- **Effort**: M
- **Risk**: LOW-MED (adds a write path + a modal; existing writes unchanged)
- **Depends on**: **plan 004** (connections must render before editing them is
  meaningful; 004 defines the frontmatter shape and the `connection-line` layer).
- **Category**: direction (feature)
- **Planned at**: commit `3783bf9`, 2026-07-09

## Why this matters

Plan 004 makes connections *declared in frontmatter* appear on the map. This
plan lets a GM **create and remove them from the map itself** — the ≤5s yes-and
bar the whole product is built around, applied to edges instead of nodes. Two
gestures: from a place card, "Connect to…" → pick a target → the link is written
to frontmatter and drawn instantly; click a connection line → option to remove
it. Optional travel-time/path-type label on creation (point-crawl GMs annotate
edges with distance/danger).

## Current state

- `src/model/locationNote.ts` — after plan 004, `LocationFrontmatter` has an
  optional `connections` array (bare string or `{to,type?,label?}`), and
  `ParsedLocation.connections` is the parsed form. Writes go through
  `app.fileManager.processFrontMatter(file, fm => {...})`.
- `src/view/MapView.ts`:
  - `showPlaceCard(feature)` (~line 809) builds the canon place-card DOM with an
    actions row (`.campaign-map-place-card-actions`) — this is where a "Connect
    to…" button goes. It has `location` (the `ParsedLocation`) in scope.
  - `handleClick(e)` (~line 704) hit-tests layers; after plan 001 it uses a
    tolerant picker. A click on `connection-line` should offer removal.
  - The plugin exposes `getCampaignState(id).index` (all locations) and
    `this.app.fileManager.processFrontMatter`.
- `src/view/LocationSearchModal.ts` — a quick-switcher-style modal over the
  campaign's locations with a select callback. **Reuse this pattern** for the
  "pick a target location" step.
- `src/vault/locationOps.ts` — where canon note mutations live (create/move).
  Add connection add/remove helpers here to keep `MapView` thin and testable.
- `src/model/mutationLog.ts` + `plugin.log` — map-originated writes append to the
  log (quick-add create, drag-move). Connection edits should log too, for
  undo/replay parity.

**Conventions:** DOM controls, not native `Menu` (native Menu is
CLI-unverifiable — see PROGRESS.md). Writes via `processFrontMatter`. User
feedback via `new Notice("Campaign Map: …")`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass (+ new) |
| Gate (write only) | `npx tsx scripts/gates/phase1.ts` | see env note |

## Scope

**In scope:** `src/vault/locationOps.ts` (add connection helpers +
optional colocated test), `src/view/MapView.ts` (place-card button + line-click
removal), a new `src/view/ConnectTargetModal.ts` **only if**
`LocationSearchModal` can't be reused with a different callback (prefer reuse —
if reusable, no new file), `scripts/gates/phase1.ts` (write-only check).

**Out of scope:** the render layer and schema (plan 004 owns them); curved
paths/arrowheads; bulk connection editing; `src/gen/**`.

## Git workflow

- Branch: `advisor/005-point-crawl-interaction`. Conventional commits ending with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push branch; no merge.

## Steps

### Step 1: Vault helpers to add/remove a connection

In `src/vault/locationOps.ts`, add two functions that edit a source note's
`connections` frontmatter idempotently (match plan 004's schema: an array whose
entries are strings or `{to,...}` objects). Store the target by its **basename**
(stable, human-readable, matches how 004's resolver looks up `byName`):

```ts
export async function addConnection(app: App, sourcePath: string, targetBasename: string, label?: string): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    const list: unknown[] = Array.isArray(fm.connections) ? fm.connections : [];
    const already = list.some((c) => (typeof c === "string" ? c === targetBasename : c?.to === targetBasename));
    if (already) return;
    list.push(label ? { to: targetBasename, label } : targetBasename);
    fm.connections = list;
  });
}

export async function removeConnection(app: App, sourcePath: string, targetBasename: string): Promise<void> {
  const file = app.vault.getFileByPath(sourcePath);
  if (!file) return;
  await app.fileManager.processFrontMatter(file, (fm) => {
    if (!Array.isArray(fm.connections)) return;
    fm.connections = fm.connections.filter((c: unknown) => (typeof c === "string" ? c !== targetBasename : c?.to !== targetBasename));
    if (fm.connections.length === 0) delete fm.connections;
  });
}
```
(Match the existing import/style of `locationOps.ts` — use its `App` import and
any existing helpers.)

**Verify**: `npm run typecheck` → exit 0.

### Step 2: "Connect to…" in the place card

In `MapView.showPlaceCard`, add a button to the actions row:
```ts
actions.createEl("button", { text: "Connect to…" }).onclick = () => {
  const others = this.plugin.getCampaignState(this.campaign!.id).index.all().filter((l) => l.path !== location.path && l.point);
  new LocationSearchModal(this.app, others, (target) => {
    void addConnection(this.app, location.path, target.name).then(() => {
      void this.plugin.log.append?.(this.campaign!.id, { type: "connect", path: location.path, data: { to: target.name } });
      new Notice(`Campaign Map: connected ${location.name} → ${target.name}`);
    });
  }).open();
};
```
Import `addConnection` from `../vault/locationOps`. The vault write triggers the
existing reconcile → `onIndexUpdated` → plan 004's `refreshConnections()`, so the
new line appears without extra plumbing. (If `plugin.log.append` has a different
signature, match it or omit the log call — logging is a nice-to-have here, not a
blocker; do not invent a log API that doesn't exist.)

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Click a connection line → remove it

Extend `handleClick` so a click that misses all pins but hits `connection-line`
offers removal. After the canon/generated picks (plan 001) and before the
dropped-pin fallback:
```ts
const line = this.map.queryRenderedFeatures(e.point, { layers: this.map.getLayer("connection-line") ? ["connection-line"] : [] })[0];
if (line) {
  this.showConnectionCard(line, e.lngLat);
  return;
}
```
Add `showConnectionCard(feature, lngLat)` modeled on `showDroppedPin`: show the
two endpoint names (from `feature.properties.from`/`to`, which are vault paths —
derive basenames) and a "Remove connection" button calling `removeConnection`.
`from`/`to` on the feature are the two note paths (plan 004 sets them); remove
the edge from whichever end declared it — for robustness call `removeConnection`
on **both** `from` and `to` (only the declaring side has it; the other is a
no-op):
```ts
await Promise.all([
  removeConnection(this.app, from, basename(to)),
  removeConnection(this.app, to, basename(from)),
]);
```

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass.

### Step 4: Unit-test the vault helpers

Add tests for `addConnection`/`removeConnection` (colocated, e.g.
`src/vault/locationOps.test.ts` if one exists, else create it) using a fake
`app.fileManager.processFrontMatter` that runs the mutator over an in-memory
frontmatter object. Cover: add creates the array; add is idempotent (no dup);
add with label stores the object form; remove deletes the entry; remove of the
last entry deletes the whole `connections` key. If `locationOps` has no existing
test harness to model on, keep these as pure-object tests of the mutator
callbacks.

**Verify**: `npm test` → all pass including the new cases.

### Step 5: Gate check (write only)

In `scripts/gates/phase1.ts`, add a check that drives the write path: call
`addConnection` (or the view button's code path) between two known locations via
`evalJs` on the plugin, then assert the `connections` source gains a feature.
Follow the file's idiom; poll for the async reconcile like the existing quick-add
check does.

**Verify (if app available)**: `npx tsx scripts/gates/phase1.ts` passes.

## Test plan

- **Unit (required)**: Step 4 covers the frontmatter mutation logic — the real
  regression surface.
- **App gate**: Step 5 proves the end-to-end create path renders a line.
- **Manual (if drivable)**: click a pin → "Connect to…" → pick another → a dashed
  line appears; click the line → "Remove connection" → it disappears; both
  reflected in the note frontmatter.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 including new `locationOps` connection tests
- [ ] `grep -n "addConnection\|removeConnection" src/vault/locationOps.ts` → both defined
- [ ] `grep -n "Connect to" src/view/MapView.ts` → the place-card button exists
- [ ] `grep -n "showConnectionCard" src/view/MapView.ts` → line-click removal exists
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

- Plan 004 is not merged / the `connections` frontmatter shape or
  `connection-line` layer differs from 004's spec — STOP (this plan builds on it).
- `LocationSearchModal`'s constructor signature is incompatible with reuse for
  target-picking and building a new modal balloons scope — report and propose.
- `processFrontMatter` array handling behaves unexpectedly (e.g. serializes the
  object form badly) — report with the actual YAML produced.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- Undo parity: if `plugin.log` gains a `connect`/`disconnect` reversal, wire
  `undoLastEdit` to it later; this plan logs the intent but the single-step undo
  (`MapView.undoLastEdit`) only reverses create/move today — extending it is a
  follow-up (see the multi-step-undo gap in README).
- Follow-ups: drag-from-pin-to-pin to connect (a drag gesture variant of
  `handleDragStart`); edit an existing edge's label/type inline; one-way passages
  (directional arrowhead) once 004's arrowhead follow-up lands.
- Reviewer: confirm a connection removed from one end fully disappears (the
  "remove from both ends" call in Step 3), and that the target picker excludes the
  source and sidecar-only (pointless) locations.

# Plan 009: Campaign replay + per-session travel paths (Phase 5)

> **Executor**: follow step by step, run every verification, honor STOP conditions, update `plans/README.md` row when done.
> **Drift check**: `git diff --stat 04d3d45..HEAD -- src/view/MapView.ts src/main.ts src/map/theme.ts src/map/themes/index.ts` — locate by symbol name; `MapView.ts`, `theme.ts`, `themes/index.ts` were changed by plans 004/005 (connection rendering) which you will model on.

## Status
- **Priority**: P1 (Phase 5 roadmap: "Campaign replay from mutation log; per-session travel paths")
- **Effort**: M
- **Risk**: LOW-MED
- **Depends on**: 004 (reuses the connection source/layer pattern) — merged to `main`
- **Category**: direction (Phase 5)
- **Planned at**: commit `04d3d45`, 2026-07-09

## Why this matters
docs/03 Phase 5: campaign replay from the mutation log, and per-session travel paths ("session notes already date-stamp the log"). Two features: (1) **Replay** — step through the campaign's map-edit history chronologically, flying to each created location. (2) **Session travel path** — draw an ordered path through the locations a session note wikilinks, so a GM can see where the party went.

## Current state
- `src/model/mutationLog.ts` — `readLog(app, campaignFolder): Promise<LogEntry[]>` where `LogEntry = { ts: number; type: "create"|"move"; campaignId; path; data }`; `campaignFolderFromConfigPath(configPath)`. Entries are append-order (chronological by `ts`).
- `src/view/MapView.ts` — `flyTo`, `pulseFeature(loc)` (a pulse-ring marker for ~900ms), `openSearch` (LocationSearchModal pattern for picking). `this.plugin.getCampaignState(id).index` resolves paths→`ParsedLocation` (with `.point`, `.name`). Connection rendering (plan 004): `refreshConnections()` sets the `connections` geojson source from `buildConnectionFeatures`; the source + `connectionLayers` are registered in both `buildThemeStyle` (`themes/index.ts`) and `obsidianNativeStyle` (`theme.ts`). **Model the session-path source/layer on this exactly.**
- `src/map/themes/connectionLayers.ts` — `connectionLayers({ lineColor })` returns one dashed line layer on the `connections` source. Model `sessionPathLayers` on it (solid or differently-dashed line, distinct color = `poi` or a passed token, on a new `session-path` source).
- Session notes live in `<campaign>/Sessions/*.md`; their bodies contain `[[Location Name]]` wikilinks.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass (+ new) |
| Build | `npm run build` | exit 0 |

## Scope
**In scope:** `src/model/sessionPath.ts` (new — pure parser), `src/model/sessionPath.test.ts` (new), `src/map/themes/sessionPathLayers.ts` (new), `src/map/themes/index.ts` + `src/map/theme.ts` (register `session-path` source + layer, exactly like `connections`), `src/view/MapView.ts` (`showSessionPath()`, `replayCampaign()`, `refreshSessionPath` clear), `src/main.ts` (two commands).
**Out of scope:** editing session notes, animated tweened camera paths (a stepped flyTo sequence is fine), `src/gen/**`.

## Git workflow
- Branch `advisor/009-replay-and-travel-paths`. Conventional commits ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push; no merge; don't edit `plans/README.md`.

## Steps
### Step 1: Pure session-path parser
Create `src/model/sessionPath.ts`:
```ts
import type { ParsedLocation } from "./locationNote";
/** Ordered wikilink targets in a note body → resolved location points, in
 * appearance order, deduped consecutively. Returns [] if <2 resolve. */
export function parseSessionPath(body: string, locations: ParsedLocation[]): { name: string; point: [number, number] }[] {
  const byName = new Map<string, ParsedLocation>();
  for (const l of locations) { byName.set(l.name, l); for (const a of l.aliases) byName.set(a, l); }
  const refs: { name: string; point: [number, number] }[] = [];
  const re = /\[\[([^\]|#]+)/g; let m;
  while ((m = re.exec(body))) {
    const loc = byName.get(m[1].trim());
    if (loc?.point) {
      const last = refs[refs.length - 1];
      if (!last || last.name !== loc.name) refs.push({ name: loc.name, point: loc.point });
    }
  }
  return refs.length >= 2 ? refs : [];
}
export function sessionPathFeature(pts: { point: [number, number] }[]): GeoJSON.Feature | null {
  if (pts.length < 2) return null;
  return { type: "Feature", geometry: { type: "LineString", coordinates: pts.map((p) => p.point) }, properties: { kind: "session-path" } };
}
```
**Verify**: `npm run typecheck` → exit 0.

### Step 2: Unit-test parser
`src/model/sessionPath.test.ts`: two wikilinks → 2-point path; repeated consecutive link deduped; unknown/sidecar-only link skipped; <2 resolvable → []. Model on `connections.test.ts`.
**Verify**: `npm test` → pass incl. new.

### Step 3: session-path source + layer
Create `src/map/themes/sessionPathLayers.ts` modeled on `connectionLayers.ts`: a `session-path` line layer (source `session-path`), solid, `line-width` ~2.5, arrow-ish distinct color (pass `lineColor`), `line-opacity` 0.9. Register a `session-path` geojson source (empty) and `...sessionPathLayers({ lineColor: <token>.poi })` in BOTH `buildThemeStyle` (`themes/index.ts`) and `obsidianNativeStyle` (`theme.ts`) — same two edits as the `connections` wiring, placed right after `connectionLayers`.
**Verify**: `npm run typecheck` → exit 0.

### Step 4: Show session path (MapView + command)
`showSessionPath()`: open a suggester of `<campaign>/Sessions/*.md` notes (reuse Obsidian `FuzzySuggestModal` or the `LocationSearchModal` pattern), read the chosen note body, `parseSessionPath(body, index.all())`, set the `session-path` source data to `sessionPathFeature(pts)` (or empty FeatureCollection if null), and `fitBounds` to the path. Add a `clearSessionPath()` that empties the source. Command `show-session-path` in `main.ts`.
**Verify**: `npm run typecheck` → exit 0.

### Step 5: Replay (MapView + command)
`async replayCampaign()`: `readLog(this.app, campaignFolderFromConfigPath(this.campaign.path))`, filter `type==="create"`, sort by `ts`, then for each: resolve `entry.path` → location in index, `flyTo({center: point})`, `pulseFeature`, `await` ~900ms between steps. `new Notice` at start/end. Command `replay-campaign` in `main.ts`. Keep it simple and interruptible (if `this.map` goes null mid-replay, stop).
**Verify**: `npm run typecheck` → exit 0; `npm test` → pass; `npm run build` → exit 0.

## Test plan
- Unit: `parseSessionPath` (Step 2) — the real regression surface.
- Manual (env-gated): seed a Sessions note with two `[[Location]]` links, run `show-session-path` → a line connects them; run `replay-campaign` → camera flies through created locations.

## Done criteria
- [ ] `npm run typecheck` exits 0; `npm test` passes incl. new `sessionPath` tests; `npm run build` exits 0
- [ ] `grep -rn "session-path" src/map` shows the source+layer wired via both style builders (`grep -rn "sessionPathLayers" src/map` → `themes/index.ts` + `theme.ts`)
- [ ] `grep -n "replayCampaign\|showSessionPath" src/view/MapView.ts` matches; `grep -n "show-session-path\|replay-campaign" src/main.ts` matches
- [ ] No files outside scope modified; `plans/README.md` not edited

## STOP conditions
- The `connections`/`connectionLayers` wiring in `theme.ts`/`themes/index.ts` isn't shaped as described (drift) — re-locate and match the actual pattern.
- `readLog`/`campaignFolderFromConfigPath` signatures differ — adapt.
- A verification fails twice after a reasonable fix.

## Maintenance notes
- Follow-ups: animated tweened travel (not stepped flyTo), per-session color coding, replay scrubber UI, drawing move-history not just creates.
- Reviewer: confirm the session-path source clears cleanly (no stale line after switching sessions) and survives a theme switch (the `styledata` re-set — mirror how 004 re-sets `connections`).

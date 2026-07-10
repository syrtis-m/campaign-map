# Plan 010: Populate-area command + external-agent note contract (Phase 5)

> **Executor**: follow step by step, run every verification, honor STOP conditions, update `plans/README.md` row when done.
> **Drift check**: `git diff --stat 04d3d45..HEAD -- src/main.ts src/vault/locationOps.ts src/gen/naming/regions.ts` — locate by symbol name.

## Status
- **Priority**: P1 (Phase 5 roadmap: "LLM hook: agent-in-vault … emits valid location notes")
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none new (uses existing naming + createLocation)
- **Category**: direction (Phase 5)
- **Planned at**: commit `04d3d45`, 2026-07-09

## Why this matters
docs/03 Phase 5 wants "populate this district with 5 shops." The plugin has no external-LLM API integration (no settings/key infra), and adding one is out of scope. But the *value* — generating a cluster of valid, named, typed location notes in an area — is achievable **offline and deterministically** using the existing seeded naming cultures + type taxonomy. This plan ships that as a `populate-area` command, and documents the **note-emission contract** so any external agent-in-vault (the "LLM hook") can also emit valid notes the plugin reconciles automatically. Two complementary halves: an in-app deterministic populate, and a documented contract for external agents.

## Current state
- `src/vault/locationOps.ts` / `src/main.ts` — `this.plugin.createLocation(campaignId, point, name, type)` creates a valid location note (used by quick-add). Reuse it.
- `src/gen/naming/regions.ts` — `cultureAt(seed, x, y, worldBounds, genre, namingCultures)` → a naming culture; the culture's generator produces seeded names. `src/gen/naming/cultures` → `genreForCampaign(crs, theme)`. See `MapView.openQuickAdd` for the exact call sequence producing a name from a culture.
- `src/model/locationNote.ts` — `LOCATION_TYPES` (valid type strings), `TYPE_TAXONOMY`, and `LocationFrontmatterSchema` (the contract an external agent must satisfy: `map`, `geometry: [x,y]`, `type`, optional `aliases`/`connections`).
- `src/view/MapView.ts` — `this.map.getBounds()` / `getCenter()` for the current viewport; `this.campaign.config` has `seed`, `crs`, `theme`, `bounds`, `scaleMetersPerUnit`, `namingCultures`.
- Deterministic placement: `src/gen/spatialHash.ts` has `hash(...)`-based helpers; simplest here is N seeded jittered points within the viewport via `hashSeed`-driven offsets (see `jitteredGridPoints`), so re-running is stable.

## Commands
| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass (+ new) |
| Build | `npm run build` | exit 0 |

## Scope
**In scope:** `src/gen/populate.ts` (new — pure: given seed, bbox, type, count, culture-fn → `{name,type,point}[]`), `src/gen/populate.test.ts` (new), `src/view/PopulateAreaModal.ts` (new — type dropdown + count input, model on `QuickAddModal`), `src/view/MapView.ts` (`populateArea()`), `src/main.ts` (`populate-area` command), `docs/07-llm-note-contract.md` (new — the external-agent contract doc).
**Out of scope:** any real LLM/API call, settings/key UI, `src/map/**` rendering (reconcile already renders new notes).

## Git workflow
- Branch `advisor/010-populate-area`. Conventional commits ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Push; no merge; don't edit `plans/README.md`.

## Steps
### Step 1: Pure populate generator
Create `src/gen/populate.ts`:
```ts
import type { BBox } from "./spatialHash";
import { hashSeed } from "./rng";
export interface PopulateSpec { seed: number; bbox: BBox; type: string; count: number; nameFor: (x: number, y: number) => string; salt?: string; }
export function populateArea(spec: PopulateSpec): { name: string; type: string; point: [number, number] }[] {
  const { seed, bbox, type, count } = spec; const salt = spec.salt ?? "populate";
  const out: { name: string; type: string; point: [number, number] }[] = [];
  const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
  for (let i = 0; i < count; i++) {
    const rx = (hashSeed(seed, i, 0, salt) >>> 0) / 0xffffffff;
    const ry = (hashSeed(seed, i, 1, salt) >>> 0) / 0xffffffff;
    const x = bbox.minX + rx * w, y = bbox.minY + ry * h;
    out.push({ name: spec.nameFor(x, y), type, point: [x, y] });
  }
  return out;
}
```
(Confirm the actual `hashSeed` signature/return in `src/gen/rng.ts` and adapt the normalization; it returns a uint. Deterministic: same seed+bbox+type+count → identical output.)
**Verify**: `npm run typecheck` → exit 0.

### Step 2: Unit-test
`src/gen/populate.test.ts`: count honored; determinism (same spec → identical); all points inside bbox; distinct salts → different layouts. Model on existing `src/gen/**/*.test.ts`.
**Verify**: `npm test` → pass incl. new.

### Step 3: Modal + MapView method
`PopulateAreaModal` (model on `QuickAddModal`): a type dropdown (`LOCATION_TYPES`) + a count number input (default 5, clamp 1–20) + confirm → callback `{type, count}`.
`MapView.populateArea()`: open the modal; on confirm, compute the viewport bbox (in campaign units), build `nameFor` from `cultureAt(...)` at each point (same sequence as `openQuickAdd`), call `populateArea(...)`, then `for` each result `await this.plugin.createLocation(this.campaign.id, point, name, type)`. `new Notice` with the count created.
**Verify**: `npm run typecheck` → exit 0.

### Step 4: Command
`main.ts`: `populate-area` command (checkCallback + `activeMapView()`) → `void view.populateArea()`. Model on `search-locations`.
**Verify**: `npm run typecheck` → exit 0; `npm test` → pass; `npm run build` → exit 0.

### Step 5: External-agent note contract doc
Create `docs/07-llm-note-contract.md`: a short spec for an external agent-in-vault to emit valid location notes — the exact frontmatter (`map`, `geometry: [x, y]` in campaign units, `type` from `LOCATION_TYPES`, optional `aliases`, `connections`), where files go (`<campaign>/Locations/<Name>.md`), that the plugin reconciles them live (no import step), and that invalid frontmatter surfaces a warning badge (never silently dropped). Quote the Zod schema fields from `src/model/locationNote.ts`. This documents the "LLM hook" as satisfied-by-contract: the vault IS the API.
**Verify**: file exists and is accurate to the current schema.

## Test plan
- Unit: `populateArea` (Step 2).
- Manual (env-gated): run `populate-area`, choose "shop/tavern/venue" × 5 → 5 new culture-named notes appear as pins in the viewport; re-running with the same seed/viewport produces the same names/positions.

## Done criteria
- [ ] `npm run typecheck` exits 0; `npm test` passes incl. new `populate` tests; `npm run build` exits 0
- [ ] `grep -n "populateArea" src/gen/populate.ts src/view/MapView.ts` matches; `grep -n "populate-area" src/main.ts` matches
- [ ] `docs/07-llm-note-contract.md` exists and quotes the real `LocationFrontmatterSchema` fields
- [ ] No files outside scope modified; `plans/README.md` not edited

## STOP conditions
- `hashSeed` signature differs from the assumption → adapt the normalization, don't invent an RNG.
- `createLocation` signature differs → match it.
- `cultureAt`/`genreForCampaign` call shape differs from `openQuickAdd` → mirror the real `openQuickAdd` sequence.
- A verification fails twice after a reasonable fix.

## Maintenance notes
- Follow-ups: an actual LLM API integration (needs a settings tab + key storage via `loadData`/`saveData`, currently absent) that emits notes conforming to `docs/07-llm-note-contract.md`; spacing-aware placement; type-mix templates ("a market district" = shops+tavern+residences).
- Reviewer: confirm populated notes validate (no warning badge) and are culture-consistent for the region.

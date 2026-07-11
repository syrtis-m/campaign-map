# Plan 015 — Explicit visibility field (decouple label visibility from `type`)

**Priority:** P1 · **Effort:** M · **Depends on:** none (builds on the shipped
depth-of-field LOD, commit `70fb361`) · **Model:** Opus 4.8

## The correction (user's words)
> "instead of doing zoom levels via the type field, we should have a separate
> field that handles that. i don't want to have to keep a mental model in my head
> during dming of what type is visible at what levels — this tool should be as
> quick to use as possible, it's just another friction point."

## Background — current state (read before touching anything)
The map has three **focus levels** (Wide/Mid/Close, per-campaign, from the
overview zoom) and a **depth-of-field** label model: a location's dot always
renders; its NAME reveals at all three levels (`deep`), from Mid inward
(`medium`), or at Close only (`shallow`). See `README.md` (Locations / Focus
levels), `docs/06 §3`, and the 2026-07-10 `DECISIONS.md` entry.

Today the `focus` bucket is **derived from `type`** via `focusForType()` in
`src/model/locationNote.ts` (city→deep, shop→shallow, …), with an optional
`focus:` frontmatter override. That derivation is exactly the friction the user
is calling out: to know whether a name will show, the GM has to remember the
type→visibility mapping. It's an invisible mental model.

Key files: `src/model/locationNote.ts` (`TYPE_FOCUS`, `focusForType`,
`FocusDepth`, `focus` on `ParsedLocation` + feature props, frontmatter schema),
the QuickAdd modal (`src/view/` — grep `QuickAddModal` / `openQuickAdd`), the
place card (`src/view/MapView.ts` `showPlaceCard`), `src/gen/world/settlements.ts`
(generated features also set `focus`).

## Goal
Make label visibility an **explicit, first-class, fast-to-set field**, fully
decoupled from `type`. `type` becomes purely semantic (naming, future icons); it
no longer secretly controls what's visible. The GM sets visibility directly in
one obvious control and never has to reason from type.

## Approach (recommended — refine as you see fit, keep the intent)
1. **Decouple the runtime gating from `type`.** The stored `focus` value on the
   note is the sole source of truth for label visibility. Remove type→focus as
   the *runtime* gate: a note with no explicit value falls back to a single
   global default (`medium`), NOT a type-derived one. (`focusForType` may survive
   only as the QuickAdd pre-selection convenience in step 3 — nothing else should
   read it for gating.)
2. **Make the field GM-friendly and obvious.** Consider renaming for legibility
   (e.g. frontmatter `visibility:` with values that read plainly, or keep
   `focus:` — your call, but the UI labels must be self-explanatory, mapping 1:1
   to the three focus levels: e.g. "Always / From Mid / Street-level" or
   "Wide / Mid / Close"). If you rename the stored enum, keep back-compat: still
   accept the old `focus:` key. Update `README.md`, `docs/06 §3`, and the
   Zod schema/validator accordingly.
3. **Surface it in QuickAdd** as a prominent 3-way picker (segmented control or
   dropdown), so setting visibility is part of the ≤5s add flow. Pre-select a
   sensible default — you MAY use the type as a hint to pre-select (e.g. a city
   pre-selects "Always") as a convenience, but the value is written explicitly to
   the note so it's visible/editable thereafter and never re-derived.
4. **Make it editable after creation** from the place card (a quick control that
   writes the field via `processFrontMatter`), so re-tuning visibility mid-session
   is one click, not a frontmatter edit.
5. Keep generated settlements setting an explicit value too (provenance parity).

## Non-negotiable constraints
- **Never put `zoom` in a layer `filter`** — it silently blanks the whole style
  (no console error, unit tests stay green). Visibility gating stays on the
  bucketed label layers' numeric `minzoom` (see `canonLayers.ts` /
  `canonLayers.test.ts`). You should not need to touch the layer zoom logic at
  all — this plan is about *which bucket a note is in*, set explicitly.
- Bad/unknown field values → warning badge, never a silent drop (existing
  reconcile discipline; validate at the IO boundary with Zod).
- Determinism, canon=notes, vault-APIs-only all still hold (CLAUDE.md).

## Acceptance criteria
- A note's label visibility is controlled by an explicit field, independent of
  `type`; changing `type` alone does not change what's visible.
- QuickAdd lets the GM set visibility in the add flow; the place card lets them
  change it after. Both write the field explicitly.
- Notes without the field render at the global default (`medium`), not a
  type-derived bucket.
- `npm run typecheck` + `npm test` green (add/adjust unit tests:
  `locationNote.test.ts` for the new default + parsing/override + back-compat).
- Docs updated (README Locations section, docs/06 §3, a DECISIONS entry).

## Verification note
Background agents can't run the live Obsidian loop reliably; hard-gate on
typecheck + test and push your branch. The orchestrator will live-verify (open a
campaign, add a location choosing each visibility, confirm names reveal at the
right focus levels) and merge. Leave any live-gate additions written-but-unrun.

## Restart-from-scratch note
This plan is self-contained: the goal is "visibility is an explicit note field,
decoupled from type, fast to set in the UI." If the working branch is lost,
re-read the current state above and re-implement from that intent — nothing here
depends on a specific in-progress diff.

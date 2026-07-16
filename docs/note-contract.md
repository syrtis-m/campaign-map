# External-agent note contract ("the LLM hook")

The intent (original roadmap, Phase 5): *"LLM hook: agent-in-vault reads campaign
markdown, emits valid location notes ('populate this district with 5 shops')."*

This plugin ships no LLM/API integration — no settings tab, no key storage,
no network call (see plan 010). It doesn't need one to satisfy that
intent, because **canon = notes** (CLAUDE.md): the vault is the source of
truth and the map is a view over it. Any external agent that already has
read/write access to the vault — an LLM-in-a-loop, a script, a human typing —
can "populate a district" today, with zero plugin-side integration work,
simply by writing markdown files that satisfy the contract below. The plugin
reconciles them live, the same way it reconciles a note a human typed by hand.

This is the deterministic in-app equivalent too: the `populate-area` command
(plan 010, `src/gen/populate.ts` + `MapView.populateArea`) generates the same
kind of notes offline and seeded, no agent required. Both paths — an external
agent and the built-in command — emit through this one contract.

## The contract

A location is a markdown note whose frontmatter validates against
`LocationFrontmatterSchema` in `src/model/locationNote.ts`:

```ts
export const LocationFrontmatterSchema = z.object({
  map: z.string().min(1),
  geometry: z.union([PointGeometry, z.string().min(1)]), // point, or path to sidecar .geojson
  type: z.string().min(1).default("custom"),
  aliases: z.array(z.string()).optional(),
  importance: z.number().int().min(1).max(9).optional(),
  "zoom-range": z.tuple([z.number(), z.number()]).optional(), // legacy; no longer gates labels
  visibility: z.enum(["wide", "mid", "close"]).optional(),    // explicit label-visibility field
  focus: z.enum(["deep", "medium", "shallow"]).optional(),    // back-compat legacy bucket
  icon: z.string().optional(),
  connections: z.array(ConnectionSchema).optional(),
});
```

where `PointGeometry = z.tuple([z.number(), z.number()])` and

```ts
const ConnectionSchema = z.union([
  z.string().min(1),
  z.object({ to: z.string().min(1), type: z.string().optional(), label: z.string().optional() }),
]);
```

### Field-by-field

| Field | Required | Meaning |
|---|---|---|
| `map` | yes | The campaign's id (`campaign.id` — the same value every other location note under that campaign already carries; copy it from a sibling note or the campaign's config file). |
| `geometry` | yes | Either a `[x, y]` point tuple **in the campaign's own units** (fictional campaigns: fake lng/lat in the campaign's bounded box, `scaleMetersPerUnit` per campaign; real-city campaigns: real lng/lat), or a vault-relative path string to a sidecar `.geojson` for non-point geometry (CLAUDE.md: "complex geometry → sidecar .geojson"). Most agent-emitted notes should just emit a point. |
| `type` | yes (defaults to `"custom"` if omitted) | One of `LOCATION_TYPES` (`src/model/locationNote.ts`'s `TYPE_TAXONOMY` keys): `nation/region`, `city`, `town`, `village`, `route`, `water-feature`, `district`, `street(named)`, `landmark`, `shop/tavern/venue`, `residence/minor`, `custom`. `type` is **semantic only** (naming, future icons) — it carries a pinned `importance` default and a visibility *hint*, but never gates labels at runtime. An agent should not invent styling; just pick the closest type. |
| `visibility` | no | `wide` \| `mid` \| `close` — at which focus level the location's **name** first appears (the dot always renders). This is the explicit, sole runtime label gate (plan 015). Omit for the global default `mid`. |
| `aliases` | no | Alternate names, array of strings. |
| `importance` | no | Integer 1–9 (1 = highest, wins label collisions). Omit to use the type's default — don't fight the cartographic discipline (CLAUDE.md product bar). |
| `zoom-range` | no | **Legacy** `[min, max]` — retained for incidental camera math only; it no longer gates label visibility. Don't emit it; use `visibility`. |
| `focus` | no | **Legacy** raw bucket (`deep`/`medium`/`shallow`) from before the `visibility` field; accepted for back-compat. Don't emit it. |
| `icon` | no | Icon identifier string. |
| `connections` | no | Array of either a bare target basename string, or `{ to, type?, label? }`. Point-crawl edges (plan 004/005) — used for roads/paths/relationships between locations. |

### Where the file goes

`<campaign-folder>/Locations/<Name>.md` — the same folder every quick-added
location already lands in (`src/vault/locationOps.ts`'s `createLocationNote`).
`<campaign-folder>` is the folder containing that campaign's config note.
The filename (sans extension) becomes the note's displayed name; sanitize
`\ / : * ? " < > |` out of it. If a file of that name already exists, pick a
different name — the plugin does not merge or overwrite existing notes.

Minimal valid note body:

```markdown
---
map: my-campaign-id
geometry: [12.4, -3.1]
type: shop/tavern/venue
---

(note body is yours — the plugin never touches it)
```

### No import step

There is no "import" or "sync" action to run. The plugin watches the vault
(`vault.on("create"/"modify"/"delete"/"rename")` and
`metadataCache.on("changed")` in `src/main.ts`) and reconciles on every
change: as soon as the file lands in the vault, it parses, validates, and (if
valid) appears as a pin. Same for edits and deletes. This is the same path a
human's own quick-add or manual note-editing goes through — there is no
agent-specific code path to keep in sync.

### Invalid frontmatter is never silently dropped

If a note's frontmatter fails `LocationFrontmatterSchema.safeParse` (missing
`map`, malformed `geometry`, etc.), `parseLocationNote` returns a structured
`LocationParseError` instead of a location, and the map surfaces a persistent
warning badge — `"⚠ N locations with invalid map data"` — until it's fixed
(`MapView`'s `warningBadgeEl`, driven by `CampaignState.invalid` in
`src/main.ts`). An external agent's bad output is therefore visible on the map
(CLAUDE.md: "bad frontmatter → warning badge, never silent drop").

### Determinism has nothing to do with this contract

Unlike the plugin's own generators, an external agent emitting notes through
this contract is not required to be deterministic — it's writing canon, not
generating regenerable cache content. Canon is never overwritten by
generators, and generated features never become canon until something (a
human, or an agent through this contract) creates the note.

## Summary

The "LLM hook" is satisfied by contract, not by an integration: any
agent-in-vault that can write a markdown file satisfying the schema above,
in `<campaign-folder>/Locations/`, has fully "populated the district" from
the plugin's point of view. `populate-area` (plan 010) is the offline,
deterministic, no-agent-required version of the same idea, built on the same
`createLocationNote` write path.

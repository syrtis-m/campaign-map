# CLAUDE.md — standards for working on campaign-map

Obsidian plugin: Google-Maps-style map tab for tabletop campaigns (fantasy, real-city modern, stylized Dishonored-esque). Campaign data lives in the vault. Solo-GM, "yes-and": locations invented mid-session become notes + map pins in ≤5 seconds.

This file is the standards doc: locked decisions, engineering conventions, performance and testing bars, and the documentation rules. It is deliberately dense — every line here has either bitten someone or been ruled by Jonah.

## The documentation set (and the rules for maintaining it)

Each doc has one job. When you change behavior, update the doc that owns it — in the same commit, not later.

| Doc | Owns | Update when |
|---|---|---|
| `README.md` | The product, for a non-technical Obsidian user. No plan numbers, no agent jargon, no internals | A GM-visible feature ships, changes, or is removed |
| `ARCHITECTURE.md` | How the system works: data model, engine, host, rendering; §12 invariants (single home); §13 GM-action → event cascade (the perf reference) | Structure/behavior changes; any perf work touching terrain/worker/cache/repaint updates §13 |
| `CLAUDE.md` (this file) | Standards: locked decisions, conventions, perf/testing bars, doc rules | A decision is ratified or reversed (name Jonah + date) |
| `docs/procgen-design.md` | Determinism doctrine (D1–D6), seam safety, city-pipeline rationale — the *why* the code can't say | The doctrine itself changes (rare; needs Jonah) |
| `docs/quality-bar.md` | Failure modes + acceptance criteria (the screenshot test); pinned aesthetic defaults | The quality bar or a pinned default moves |
| `docs/dev-workflow.md` | Dev loops (playground + Obsidian CLI), test tiers T0–T3, board runner, hard-won pitfalls | Tooling/cadence changes; a new pitfall costs an agent >30 min |
| `docs/note-contract.md` | The frontmatter contract external agents emit location notes against | `LocationFrontmatterSchema` changes |
| `plans/README.md` | The plan ledger: every `plans/NNN-*.md` with status | A plan starts, finishes, or is superseded |
| `DECISIONS.md` | Append-only rulings log: date, decision, alternatives, reversibility | Any non-obvious call an agent makes; any Jonah ruling |
| `PROGRESS.md` | Slim current state for resuming multi-session work | After each significant arc/phase; keep it short — archive old arcs to `review/` |

Rules:
- **Docs are holistic, not journals.** No new doc for a single task's findings — fold into the owning doc above, or `review/` if it's a one-off artifact (run journals, break-proofs, screenshots). If a doc stops earning its slot, delete it (git history keeps it).
- **Where a doc and the code disagree, the code wins; where behavior and a locked decision disagree, the locked decision wins.** Docs state facts the code can't: intent, rationale, rulings, invariants.
- Code comments reference docs by filename (`docs/quality-bar.md`), never by the retired numbers (docs/01–08).
- Historical material (shipped roadmaps, research snapshots, finished run protocols) gets deleted, not kept "for context" — `plans/` and git history are the record.

## Read first
- `ARCHITECTURE.md` — the system map. §13 is mandatory before any perf work
- `docs/procgen-design.md` — determinism doctrine (D1–D6), seam safety
- `docs/quality-bar.md` — failure modes + acceptance criteria; the "screenshot test"
- `docs/dev-workflow.md` — the two dev loops (playground first for procgen; Obsidian CLI for host/theme), test tiers, pitfalls
- `plans/README.md` — the plan ledger; 020 (sketch-driven procgen regions) defined the current architecture

## Locked decisions (don't relitigate without Jonah)
- Obsidian plugin (TS + esbuild), MapLibre GL JS in a custom ItemView; desktop-first
- **Three-layer model (plan 019 → amended per plan 020, Jonah 2026-07-12)**: top = **Locations** (markdown notes with `map:` frontmatter — vault = source of truth, map = view; linkable); middle = **Sketch** (GM-drawn shapes in `Fabric.geojson` — selectable + editable any time, PowerPoint-style: vertex handles + property edits); bottom = **Procgen fabric** (generated output, regenerable `.mapcache/` only). Z-order asserted in `layerOrder.ts`: procgen < sketch < locations. **Fabric never promotes to a Location** — no canonize, no promote. Procgen fabric is never edited directly — only via the sketch shape or params that drive it
- **Generation is explicit-only**: runs only on a GM request; never from pan/zoom/viewport. **A sketch with a procgen block IS the request** (amended per plan 020; district → city, and likewise river/forest/park/farmland/wall/mountain/relief/landform). What persists is the request, split by tier: **world-tier** requests live in `<campaign>/Generated.json` (synced); **region-tier** requests live on the sketch feature's `procgen` block in `Fabric.geojson` (`{ algorithm, seed, version, params }`). Output stays regenerable cache. Sketched fabric feeds every run as constraints
- Generated content = regenerable JSONL cache in `.mapcache/` (deterministic → deletable, sync-excluded, conflict-immune); in-memory flatbush index; **no SQLite**
- Vault/DataAdapter APIs only — never Node `fs` (keeps mobile possible)
- Real cities: Protomaps PMTiles file in vault, custom protocol, byte-range reads
- Fictional worlds: fake lng/lat bounded box; `scaleMetersPerUnit` per campaign
- Themes are MapLibre style JSONs (same feature schema, themes own ALL paint); generators emit typed features only, never styles
- Default theme `obsidian-native`: style JSON generated at runtime from Obsidian CSS variables, rebuilt on `css-change`; handcrafted genre themes (parchment, ink-soot, modern-clean, neon-sprawl) are per-campaign overrides. Inspired-by aesthetics only — never copy game assets/trade dress
- Interaction grammar is Google Maps' (see ARCHITECTURE.md §7): left-click pin dot = no popup (Jonah 2026-07-15 — place card retired); left-click a location *name* opens its note in a split (2026-07-16); click empty = dropped pin + "Add location here"; right-click = native Menu — the one place location actions (Open note/Center/Connect to…/Visibility) live
- **Operators + data (plan 030-C, standing convention)**: a new preset of an existing algorithm must be expressible as `params` + existing operators — `profile`/`variety`-keyed data tables are data; a preset-conditional branch inside a generator stage is not allowed (a new mechanism becomes a new operator). Operators move to a shared `src/gen/operators/` home only on their SECOND consumer — no speculative extraction
- Generators are pure headless host-agnostic functions in `src/gen/` — no DOM/map/Obsidian imports. Two shapes: world-tier `(seed, bbox, constraints) => Feature[]`; **region generators `(seed, region, params, constraints) => Feature[]`** (a `ProcgenRegion` is the sketched polygon; `params` are validated by the algorithm's own zod schema). The **sketch-kind → algorithm registry** (`src/gen/procgen/registry.ts`) binds a fabric kind to its region generator; host lifecycle consults the registry, never `if (kind === "district")`
- **Determinism is versioned (plan 029, ratified 2026-07-14)**: same `(seed, params, algorithm version)` ⇒ same bytes forever, per machine — D1–D6 binding WITHIN a version. Between versions, generator authors are free: a change that alters output bytes for the same `(seed, params)` bumps that algorithm's `currentVersion` (registry) and re-goldens (`npm run goldens:accept -- <algorithm>`) — no byte-neutrality analysis. Prefer a param over a bump when an absent param naturally reproduces old behavior (a preference, not a law). Regions pin `procgen.version` at creation; **only explicit GM adoption raises a pin** (prompt on edit / panel Adopt / "Update all regions to current generators") — a plugin update never visibly changes an existing region; a pinned-old region without cache renders nothing + a needs-adoption badge, never silently different bytes. No per-version code forks, ever. World tier stays frozen (`world/heightmap.ts` noise). Region caches carry the region id (`region:<regionId>:…`). A region's seed = `hashSeed(campaignSeed, featureId)`, **persisted at creation**: vertex edits keep the seed (city keeps its identity, boundary adapts); explicit "Re-roll" replaces it. Never derive a seed from floats at run time
- Location/sketch geometry is never overwritten by generators; locations AND sketched fabric feed generators as constraints. Sketch shapes are the durable, selectable, re-editable handles on generated content — move a vertex → the region adapts; delete the shape → its generated fabric is gone
- **Zoom LOD affects location-name visibility ONLY** (Jonah: Kanto test 2026-07-10, reaffirmed for generated fabric 2026-07-12): sketched AND generated fabric (incl. building footprints/parcels) render at every zoom — never re-add minzoom gating; if far-out density is a problem, the fix is paint treatment in themes (opacity ramps), not zoom gates. Never bake absolute zoom thresholds anywhere (fictional overviews sit at ~z4.5; z14 is unreachable)
- **Global terrain only (Jonah 2026-07-15)**: the composed terrain field (base + mountain/relief/landform stamps + river carve) is one campaign-wide surface — contours render everywhere it has relief; no mountain-polygon special-casing
- All map-originated writes append to `.mapcache/log.jsonl` (undo/redo, campaign replay)

## Engineering conventions
- Zod validators in `src/model/`; validate at every IO boundary — especially frontmatter reconcile (bad frontmatter → warning badge, never silent drop)
- Keep frontmatter minimal (geometry, type, map, aliases, visibility); complex geometry → sidecar .geojson; the note body belongs to the human
- Pure TS. `npm run dev` (esbuild watch → dev vault) / `test` (fast Vitest) / `test:fuzz` / `build` / `playground` / `perceptual` / `board`
- Every zod param gets a `.describe()` — it becomes the GM-facing tooltip. GUI-only param translations (e.g. presenting halfWidth+apron as one width) go through the `presented*` layer in `paramControls.ts`, never into schemas or generators
- Never bypass `appendCachedTile` (`src/model/tileCache.ts`) — cache appends serialize through a per-file promise chain
- Cache-invalidation keys must use each input's **provable reach** (`terrainStampSupport`, `riverCarveReach`), never a blanket margin — under-keyed long-reach inputs leave stale content behind (ARCHITECTURE §13, the "phantom cliffs" class). Any new retained cache needs a ground-truth-diff check (forced full recompute vs cached = identical)
- Byte-exact fast paths are the sanctioned speedup for determinism-pinned code: a fast branch may return only the exact constants the slow path provably returns (precedents: carve occupancy reject, `buildRingClassifier`). Changing scan lattices/algorithms needs a version bump
- Hazard patterns H1–H6 (async-read-straddling-write, unconditional busts, per-frame heavy work, unit/frame mismatch, worker priority inversion, poisoned in-flight entries) are catalogued with precedents in ARCHITECTURE §13.12 — check new code against them
- Use MapLibre agent skills (https://github.com/maplibre/maplibre-agent-skills) and the obsidian-cli skill (https://github.com/kepano/obsidian-skills)

## Performance standards
- Budget target: **60 fps pan on a Surface Pro inside Obsidian**; the dev machine (Mac Neo) is several times faster — perf claims need CPU-throttled numbers, never feel
- GM edits must feel immediate: geometry edits repaint in well under a second on a campaign-sized map (the 2026-07-16 bar: relief vertex edit → contours repainted in 0.40 s on Cradle, from 22 s); terrain drags show a live contour preview (~100 ms/tick)
- The recipe when something feels slow, in order: read ARCHITECTURE §13 (it probably names the path and its hazards) → measure live with `obsidian eval` + a `PerformanceObserver('longtask')` around the action → fix the biggest main-thread block first. §13.11 is the ground-truth table; add your measurement to it
- Per frame = cheap render/readout only; one validated commit on release (H3). Anything calling `buildRegionFromFeature` in a loop goes through the controller's `regionMemo`
- Reconcile budgets: a note create/rename/delete reflects on the map within 500 ms; location-index rebuild on vault open <1 s for a 500-note campaign
- Determinism is per-machine (cache never syncs) — never assert byte-equality across machines

## Testing standards
- Tiers (full detail + board runner: docs/dev-workflow.md): **T0** every edit = `npm test` + tsc (<45 s) · **T1** per-phase commit = T0 + build + perceptual + that phase's own gate standalone (+ fuzz iff generator behavior changed) · **T3** = `npm run board` **ONCE per plan**, at its final phase (Jonah 2026-07-13) — never per phase, never re-run chasing flakes. A board gate that fails but passes standalone right after is an environment flake: log it, count it green
- Test generators headlessly: shared structural invariants (`gen/testkit/invariants.ts`) + metric bands (`*Metrics.ts`) + ONE byte-golden per algorithm + perceptual goldens (`npm run perceptual`); 2×2 adjacent-tile seam tests mandatory for anything touching `gen/`
- **Procgen iteration starts in the playground** (`npm run playground` → http://localhost:8734): tune and judge geometry/composition there FIRST — its paint is a shim, so theme-paint judgment still needs an in-app screenshot
- The Obsidian loop (host/theme/integration): `plugin:reload id=campaign-map` (NEVER `plugin:enable` — silent no-op when already enabled) → drive via `eval`/`command` → `dev:errors` must be clean → `dev:screenshot` and actually view it. Run from `dev-vault/` — never Jonah's real vault. Test API at `app.plugins.plugins['campaign-map']`; every modal flow needs a headless test-API twin (modals hang CLI)
- A green `npm test` does NOT prove the map renders (an invalid MapLibre style loads blank with no console error — it has shipped twice); live verification or the styleGolden/validateStyle nets are what catch it
- `dev-vault/Campaigns/Vespergate` holds Jonah's real campaign data — gate fixtures are name-tagged, self-clean, and leave his files byte-intact

## Multi-session / autonomous work
- The repo is the memory: a cold session resumes from CLAUDE.md + PROGRESS.md + `git log` alone — anything correctness-critical that lives only in conversation context is fragile
- One phase = one green-gated (T1) atomic commit, pushed. Subagent output is vapor until the orchestrator verifies, commits, and pushes it; subagents never commit
- Non-obvious calls get a DECISIONS.md entry (append-only: date, decision, alternatives, reversibility). When genuinely undecided on UX: pick the option closest to Google Maps behavior, log it, don't block
- Tier-B items (aesthetic judgment needing Jonah's eyes) go to `review/` and never block: write the artifact, continue building
- Shared checkout: parallel sessions drop files into the same tree — stage explicit paths, never `git add -A`

## Product bar
- Screenshot test (docs/quality-bar.md): no label collisions, no tile seams, no blank voids, no default fonts, genre identifiable in 3s
- Importance/visibility/name defaults do the cartographic discipline — never push styling onto the GM
- Add-location ≤ 5s; note rename/delete reflects on map instantly
- Full function offline; 60fps pan on a Surface Pro inside Obsidian
- Deleting `.mapcache/` is harmless for every region at its algorithm's `currentVersion` (byte-identical regeneration, per machine) — if it isn't, determinism broke; that's a release blocker. Carve-out (plan 029 §5): regions pinned to OLDER versions need adoption before they can re-render — the map makes that visible (badge + prompt), it never silently substitutes different bytes

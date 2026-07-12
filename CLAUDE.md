# CLAUDE.md — campaign map generator (Obsidian plugin)

Obsidian plugin: Google-Maps-style map tab for tabletop campaigns (fantasy, real-city modern, stylized Dishonored-esque). Campaign data lives in the vault. Solo-GM, "yes-and": locations invented mid-session become notes + map pins in ≤5 seconds.

## Read first
- `docs/01-sota-research.md` — prior art, techniques, sources (incl. Obsidian plugin landscape)
- `docs/02-architecture.md` — vault data model, procedural-LOD + canon design
- `docs/03-roadmap.md` — current phase and exit tests
- `docs/04-quality-bar.md` — failure modes + acceptance criteria; the "screenshot test"
- `docs/05-dev-workflow.md` — build/test loop via the official Obsidian CLI (reload → drive → eval → dev:errors → screenshot)
- `docs/06-autonomous-build.md` — unattended-build protocol: preflight, Tier A/B gates, pinned aesthetic defaults, state files (PROGRESS.md, DECISIONS.md, review/)
- `plans/README.md` — numbered feature plans; 020 (sketch-driven procgen regions, shipped v4.0–4.2) is the current architecture, 021–023 (algorithm suite / fields+elevation / cross-layer cascade) are the designed next arc — each plan carries a cold-start §0 with intent + pitfalls
- `GOAL.md` — the goal command for an unattended Phase 0–5 run

## Locked decisions (don't relitigate without Jonah)
- Obsidian plugin (TS + esbuild), MapLibre GL JS in a custom ItemView; desktop-first
- **Three-layer model (plan 019 → amended per plan 020, Jonah 2026-07-12)**: top = **Locations** (markdown notes with `map:` frontmatter — vault = source of truth, map = view; linkable); middle = **Sketch** (GM-drawn shapes in `Fabric.geojson` — roads/walls/rivers/water/districts/parks — selectable + editable any time, PowerPoint-style: vertex handles + property edits); bottom = **Procgen fabric** (generated output, regenerable `.mapcache/` only). Z-order asserted in `layerOrder.ts`: procgen < sketch < locations. **Fabric never promotes to a Location** — no canonize, no promote. Procgen fabric is never edited directly — only via the sketch shape or params that drive it
- **Generation is explicit-only**: runs only on a GM request; never from pan/zoom/viewport. **A district sketch IS the request for city procgen** (amended per plan 020) — sketching/editing a district polygon is the explicit ask; the disc-domain flow (click at z≥8 → DomainProfileModal) is retired. What persists is the request, split by tier: **world-tier** requests live in `<campaign>/Generated.json` (synced); **city-tier** requests live on the sketch feature's `procgen` block in `Fabric.geojson` (`{ algorithm, seed, version, params }`). Output stays regenerable cache. Sketched fabric feeds every run as constraints
- Generated content = regenerable JSONL cache in `.mapcache/` (deterministic → deletable, sync-excluded, conflict-immune); in-memory flatbush index; **no SQLite**
- Vault/DataAdapter APIs only — never Node `fs` (keeps mobile possible)
- Real cities: Protomaps PMTiles file in vault, custom protocol, byte-range reads
- Fictional worlds: fake lng/lat bounded box; `scaleMetersPerUnit` per campaign
- Themes are MapLibre style JSONs (same feature schema, themes own ALL paint); generators emit typed features only, never styles
- Default theme `obsidian-native`: style JSON generated at runtime from Obsidian CSS variables, rebuilt on `css-change`; handcrafted genre themes (parchment, ink-soot, modern-clean, neon-sprawl) are per-campaign overrides. Inspired-by aesthetics only — never copy game assets/trade dress
- Interaction grammar is Google Maps' (see docs/02 §3b): click pin = place card; click empty = dropped pin + "Add location here"; right-click = native Menu
- Generators are pure headless host-agnostic functions in `src/gen/` — no DOM/map/Obsidian imports. Two shapes: world-tier `(seed, bbox, constraints) => Feature[]`; **region generators `(seed, region, params, constraints) => Feature[]`** (amended per plan 020 — a `ProcgenRegion` is the sketched polygon; `params` are validated by the algorithm's own zod schema). A **sketch-kind → algorithm registry** (`src/gen/procgen/registry.ts`) binds a fabric kind to its region generator (v1: district → `city`); host lifecycle consults the registry, never `if (kind === "district")`
- Determinism is sacred: `hash(campaignSeed, tileX, tileY, zoom, generatorId)`; same input = same map forever. Region caches carry the region id (`region:<regionId>:…`, amended per plan 020 — fixes a latent same-tile two-region clobber). A region's seed = `hashSeed(campaignSeed, featureId)`, **persisted at creation** in the sketch feature's `procgen` block: vertex edits keep the seed (city keeps its identity, boundary adapts); explicit "Re-roll" replaces it. Never derive a seed from floats at run time
- Location/sketch geometry is never overwritten by generators; locations AND sketched fabric feed generators as constraints. Sketch shapes are the durable, selectable, re-editable handles on generated content — move a vertex → the region adapts; delete the shape → its generated fabric is gone
- **Zoom LOD affects location-name visibility ONLY** (Jonah: Kanto test 2026-07-10, reaffirmed for generated fabric 2026-07-12): sketched AND generated fabric (incl. building footprints/parcels) render at every zoom — never re-add minzoom gating; if far-out density is a problem, the fix is paint treatment in themes (opacity ramps), not zoom gates. Never bake absolute zoom thresholds anywhere (fictional overviews sit at ~z4.5; z14 is unreachable)
- All map-originated writes append to `.mapcache/log.jsonl` (undo/redo, campaign replay)

## Conventions
- Zod validators in `src/model/`; validate at every IO boundary — especially frontmatter reconcile (bad frontmatter → warning badge, never silent drop)
- Unit-test generators with seeded snapshot fixtures; 2×2 adjacent-tile seam tests mandatory
- Keep frontmatter minimal (geometry, type, map, aliases); complex geometry → sidecar .geojson; note body belongs to the human
- Use MapLibre agent skills (https://github.com/maplibre/maplibre-agent-skills) and the obsidian-cli skill (https://github.com/kepano/obsidian-skills)
- Pure TS. `npm run dev` (esbuild watch → dev vault) / `test` (Vitest, generators+model) / `test:app` (CLI integration) / `build`
- Iteration loop: `plugin:reload id=campaign-map` (NEVER `plugin:enable` — silent no-op when already enabled) → drive via `eval`/`command` → `dev:errors` must be clean → `dev:screenshot` and actually view it. Run from `dev-vault/` — never Jonah's real vault. Expose the test API at `app.plugins.plugins['campaign-map']`; every modal flow needs a headless test-API twin (modals hang CLI). Long sessions degrade the renderer — final gate boards run one-gate-per-fresh-Obsidian-process. Full pitfall list: docs/05 §Hard-won pitfalls
- `dev-vault/Campaigns/Vespergate` holds Jonah's real campaign data — gate fixtures are name-tagged, self-clean, and leave his files byte-intact
- Perf: dev machine (Mac Neo) is far faster than the Surface Pro budget target — perf claims need CPU-throttled numbers, not feel; determinism is per-machine (cache never syncs), never assert byte-equality across machines

## Product bar
- Screenshot test (docs/04): no label collisions, no tile seams, no blank voids, no default fonts, genre identifiable in 3s
- Importance/zoom-range/name defaults do the cartographic discipline — never push styling onto the GM
- Add-location ≤ 5s; note rename/delete reflects on map instantly
- Full function offline; 60fps pan on a Surface Pro inside Obsidian
- Deleting `.mapcache/` must be harmless (regenerates identically) — if it isn't, determinism broke; that's a release blocker

# CLAUDE.md — campaign map generator (Obsidian plugin)

Obsidian plugin: Google-Maps-style map tab for tabletop campaigns (fantasy, real-city modern, stylized Dishonored-esque). Campaign data lives in the vault. Solo-GM, "yes-and": locations invented mid-session become notes + map pins in ≤5 seconds.

## Read first
- `docs/01-sota-research.md` — prior art, techniques, sources (incl. Obsidian plugin landscape)
- `docs/02-architecture.md` — vault data model, procedural-LOD + canon design
- `docs/03-roadmap.md` — current phase and exit tests
- `docs/04-quality-bar.md` — failure modes + acceptance criteria; the "screenshot test"
- `docs/05-dev-workflow.md` — build/test loop via the official Obsidian CLI (reload → drive → eval → dev:errors → screenshot)
- `docs/06-autonomous-build.md` — unattended-build protocol: preflight, Tier A/B gates, pinned aesthetic defaults, state files (PROGRESS.md, DECISIONS.md, review/)
- `GOAL.md` — the goal command for an unattended Phase 0–5 run

## Locked decisions (don't relitigate without Jonah)
- Obsidian plugin (TS + esbuild), MapLibre GL JS in a custom ItemView; desktop-first
- **Two-layer model (plan 019)**: **Locations** are markdown notes with `map:` frontmatter (vault = source of truth, map = view; linkable). **Things on the map** ("fabric") are background geometry — sketched (`Fabric.geojson`) or generated. Locations always render above fabric (asserted, `layerOrder.ts`); **fabric never promotes to a Location** — no canonize, no promote
- **Generation is explicit-only**: runs only on a GM request (toolbar/menu/command); never from pan/zoom/viewport. What persists is the request (`<campaign>/Generated.json` manifest, synced); output stays regenerable cache. Sketched fabric feeds every run as constraints
- Generated content = regenerable JSONL cache in `.mapcache/` (deterministic → deletable, sync-excluded, conflict-immune); in-memory flatbush index; **no SQLite**
- Vault/DataAdapter APIs only — never Node `fs` (keeps mobile possible)
- Real cities: Protomaps PMTiles file in vault, custom protocol, byte-range reads
- Fictional worlds: fake lng/lat bounded box; `scaleMetersPerUnit` per campaign
- Themes are MapLibre style JSONs (same feature schema, themes own ALL paint); generators emit typed features only, never styles
- Default theme `obsidian-native`: style JSON generated at runtime from Obsidian CSS variables, rebuilt on `css-change`; handcrafted genre themes (parchment, ink-soot, modern-clean, neon-sprawl) are per-campaign overrides. Inspired-by aesthetics only — never copy game assets/trade dress
- Interaction grammar is Google Maps' (see docs/02 §3b): click pin = place card; click empty = dropped pin + "Add location here"; right-click = native Menu
- Generators are pure headless host-agnostic functions `(seed, bbox, constraints) => Feature[]` in `src/gen/` — no DOM/map/Obsidian imports
- Determinism is sacred: `hash(campaignSeed, tileX, tileY, zoom, generatorId)`; same input = same map forever
- Location/sketch geometry is never overwritten by generators; locations AND sketched fabric feed generators as constraints
- All map-originated writes append to `.mapcache/log.jsonl` (undo/redo, campaign replay)

## Conventions
- Zod validators in `src/model/`; validate at every IO boundary — especially frontmatter reconcile (bad frontmatter → warning badge, never silent drop)
- Unit-test generators with seeded snapshot fixtures; 2×2 adjacent-tile seam tests mandatory
- Keep frontmatter minimal (geometry, type, map, aliases); complex geometry → sidecar .geojson; note body belongs to the human
- Use MapLibre agent skills (https://github.com/maplibre/maplibre-agent-skills) and the obsidian-cli skill (https://github.com/kepano/obsidian-skills)
- Pure TS. `npm run dev` (esbuild watch → dev vault) / `test` (Vitest, generators+model) / `test:app` (CLI integration) / `build`
- Iteration loop: `plugin:reload id=campaign-map` → drive via `eval`/`command` → `dev:errors` must be clean → `dev:screenshot` and actually view it. Run from `dev-vault/` — never Jonah's real vault. Expose the test API at `app.plugins.plugins['campaign-map']`

## Product bar
- Screenshot test (docs/04): no label collisions, no tile seams, no blank voids, no default fonts, genre identifiable in 3s
- Importance/zoom-range/name defaults do the cartographic discipline — never push styling onto the GM
- Add-location ≤ 5s; note rename/delete reflects on map instantly
- Full function offline; 60fps pan on a Surface Pro inside Obsidian
- Deleting `.mapcache/` must be harmless (regenerates identically) — if it isn't, determinism broke; that's a release blocker

# Campaign Map Generator — Obsidian Plugin

A Google-Maps-style map tab inside Obsidian for tabletop campaigns — one engine for space-fantasy worlds, real modern cities, and stylized Dishonored-esque cities. Built around "yes-and": invent a location mid-session and it's a vault note + searchable map pin in under five seconds. Canon locations *are* markdown notes; the map is a live view of the vault.

## Docs

| File | What |
|---|---|
| [docs/01-sota-research.md](docs/01-sota-research.md) | SOTA: procedural generation, web mapping, offline stack, Obsidian plugin landscape |
| [docs/02-architecture.md](docs/02-architecture.md) | Vault data model, theming, procedural-LOD + canon design |
| [docs/03-roadmap.md](docs/03-roadmap.md) | Five build phases with exit tests |
| [docs/04-quality-bar.md](docs/04-quality-bar.md) | Failure modes + acceptance criteria (the screenshot test) |
| [docs/05-dev-workflow.md](docs/05-dev-workflow.md) | Build & test loop via the official Obsidian CLI |
| [docs/06-autonomous-build.md](docs/06-autonomous-build.md) | Unattended-build protocol: preflight, gates, pinned defaults, state |
| [GOAL.md](GOAL.md) | Goal command for an unattended Phase 0–5 Claude Code run |
| [CLAUDE.md](CLAUDE.md) | Conventions and locked decisions for coding agents |

## Status

Planning complete, rev 2 (Obsidian pivot), July 2026. Next: Phase 0 — plugin scaffold + the two spikes (MapLibre-in-ItemView, fictional CRS).

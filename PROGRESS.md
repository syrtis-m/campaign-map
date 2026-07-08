# Progress

*Updated after every gate run. A fresh session should be able to resume from CLAUDE.md + this file alone.*

## Status: Phase 0 — in progress

## Environment (done)
- [x] `scripts/preflight.sh` written and green (Obsidian 1.12.7 running, `dev-vault` registered + CLI-reachable, restricted mode off, Node v22.14.0 installed locally, git repo initialized, GitHub remote `syrtis-m/campaign-map` created)
- [x] `.claude/skills/maplibre-agent-skills` and `.claude/skills/obsidian-skills` cloned

## Phase 0 — plugin skeleton + two spikes (in progress)
- [ ] TS + esbuild scaffold (manifest.json, package.json, esbuild.config.mjs, tsconfig.json)
- [ ] dev-vault hot-reload wiring (`npm run dev` → `dev-vault/.obsidian/plugins/campaign-map/`)
- [ ] `ItemView` map tab + ribbon/command to open
- [ ] Spike A: MapLibre renders in the ItemView, survives tab drag/split/close, coexists with Obsidian CSS
- [ ] Spike B: fictional CRS (fake lng/lat bounded box) — labels, bearing, fitBounds, scale bar
- [ ] Campaign config note (`*.map.md` frontmatter) parsed; blank themed world panning at 60fps
- [ ] `scripts/gates/phase0.ts` written + green
- [ ] Exit test: open vault → command "Open map: Ashfall" → pan/zoom empty themed world in a tab; drag tab to a split; reload Obsidian; still works

## Next 3 actions
1. Scaffold package.json/tsconfig/esbuild config and minimal plugin (`onload` registering an ItemView)
2. `npm install`, build, `plugin:reload`, confirm it loads with clean `dev:errors`
3. Wire MapLibre into the ItemView (Spike A) and screenshot it

## Open blockers
None currently.

## Awaiting Jonah's eyes
(nothing yet — will populate as Tier B review/ items and final screenshots land)

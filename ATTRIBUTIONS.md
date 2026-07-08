# Attributions

*docs/06 §4 — assets fetched by `scripts/fetch-fonts.sh` / preflight, license notes.*

## Fonts

All OFL (SIL Open Font License 1.1). Glyph PBFs generated locally via `fontnik` (`npm run fonts:build`); TTF sources and generated PBFs are gitignored — regenerate on demand, not redistributed in this repo. Per-theme assignment is docs/06 §3's pinned font table.

- **Inter** — [rsms/inter](https://github.com/rsms/inter) v4.1 release. `obsidian-native` fallback + `modern-clean`.
- **Alegreya** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/alegreya) (variable font, default instance used — no separate static Bold cut upstream). `parchment` labels.
- **Cormorant SC** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/cormorantsc). `parchment` region small-caps.
- **IBM Plex Serif** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/ibmplexserif). `ink-soot` labels.
- **Oswald** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/oswald) (variable font, default instance). `ink-soot` region/accent.
- **Rajdhani** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/rajdhani). `neon-sprawl` region labels.
- **Saira Condensed** — [google/fonts](https://github.com/google/fonts/tree/main/ofl/sairacondensed). `neon-sprawl` labels.

## Basemap data

- **Protomaps Basemap** — [maps.protomaps.com/builds](https://maps.protomaps.com/builds), daily build `20260707`, extracted to a central-London bbox (`-0.20,51.46,-0.05,51.54`, docs/06 §4) via the official `pmtiles extract` CLI ([go-pmtiles](https://github.com/protomaps/go-pmtiles)). Basemap layers derived from OpenStreetMap and Natural Earth. **© OpenStreetMap contributors** ([openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)) — ODbL. File lives at `dev-vault/Campaigns/London/basemap.pmtiles` (gitignored — regenerate with the command in DECISIONS.md).

## Icons

*Phase 2: game-icons.net SVG pack (CC-BY 3.0) — pending.*

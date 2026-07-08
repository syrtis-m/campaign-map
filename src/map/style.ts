import type { StyleSpecification } from "maplibre-gl";

/**
 * Phase 0 placeholder style: a blank themed world with no data sources yet.
 * Real per-theme style generation (obsidian-native, parchment, ink-soot, ...)
 * lands in Phase 1/2 (architecture §4). Land color pinned per docs/06 §3
 * theme-token table so the blank world reads as "unexplored", not "broken"
 * (quality-bar F4).
 */
export function blankWorldStyle(landColor = "#f2e8cf"): StyleSpecification {
  return {
    version: 8,
    name: "campaign-map-blank",
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": landColor },
      },
    ],
  };
}

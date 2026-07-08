import type { StyleSpecification } from "maplibre-gl";

/**
 * Default theme (architecture §4): derived at runtime from the active Obsidian
 * theme's CSS variables, so the map always matches the user's look. Handcrafted
 * genre themes (parchment, ink-soot, modern-clean, neon-sprawl) are per-campaign
 * overrides that land in Phase 2 with their own craft budget (quality-bar F6).
 *
 * Phase 1 scope: canon-location circle + label layers only — no terrain/basemap
 * data exists yet (that starts Phase 2/3), so "land" is just the pane background.
 */
export interface ObsidianCssTokens {
  backgroundPrimary: string;
  backgroundSecondary: string;
  textMuted: string;
  textNormal: string;
  interactiveAccent: string;
  fontText: string;
}

export function readObsidianCssTokens(root: HTMLElement = document.body): ObsidianCssTokens {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    backgroundPrimary: read("--background-primary", "#ffffff"),
    backgroundSecondary: read("--background-secondary", "#f2f3f5"),
    textMuted: read("--text-muted", "#888888"),
    textNormal: read("--text-normal", "#222222"),
    interactiveAccent: read("--interactive-accent", "#7c3aed"),
    fontText: read("--font-text", "sans-serif").replace(/^["']|["']$/g, ""),
  };
}

export function obsidianNativeStyle(tokens: ObsidianCssTokens, glyphsUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "obsidian-native",
    glyphs: glyphsUrl,
    sources: {
      canon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": tokens.backgroundPrimary },
      },
      {
        id: "canon-point",
        type: "circle",
        source: "canon",
        filter: ["all", ["<=", ["get", "minZoom"], ["zoom"]], ["<=", ["zoom"], ["get", "maxZoom"]]],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "importance"],
            1,
            7,
            7,
            3,
          ],
          "circle-color": tokens.interactiveAccent,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": tokens.backgroundPrimary,
        },
      },
      {
        id: "canon-label",
        type: "symbol",
        source: "canon",
        filter: ["all", ["<=", ["get", "minZoom"], ["zoom"]], ["<=", ["zoom"], ["get", "maxZoom"]]],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Inter Regular"],
          "text-size": ["interpolate", ["linear"], ["get", "importance"], 1, 18, 7, 11],
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "symbol-sort-key": ["get", "importance"],
          "text-optional": true,
        },
        paint: {
          "text-color": tokens.textNormal,
          "text-halo-color": tokens.backgroundPrimary,
          "text-halo-width": 1.5,
        },
      },
    ],
  };
}

import type { StyleSpecification } from "maplibre-gl";
import { HANDCRAFTED_THEMES, type ThemeTokens } from "./tokens";
import { canonLayers } from "./canonLayers";
import { basemapLayers } from "./basemapLayers";

export { HANDCRAFTED_THEMES, type ThemeTokens };

export function isHandcraftedTheme(id: string): id is keyof typeof HANDCRAFTED_THEMES {
  return id in HANDCRAFTED_THEMES;
}

/**
 * Assembles a full style for a handcrafted genre theme. `basemap` is present only for
 * real-city campaigns with a registered vault PMTiles source (Phase 2); fictional
 * campaigns get the theme's land/water/canon layers with no basemap source at all —
 * unexplored space reads as the theme's land color, not a void (quality-bar F4).
 */
export function buildThemeStyle(
  tokens: ThemeTokens,
  glyphsUrl: string,
  basemap?: { sourceId: string; url: string }
): StyleSpecification {
  return {
    version: 8,
    name: tokens.id,
    glyphs: glyphsUrl,
    sources: {
      canon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...(basemap
        ? { [basemap.sourceId]: { type: "vector" as const, url: basemap.url } }
        : {}),
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": tokens.land } },
      ...(basemap ? basemapLayers(basemap.sourceId, tokens) : []),
      ...canonLayers({
        pointColor: tokens.accent,
        pointHaloColor: tokens.land,
        textColor: tokens.labelMajor,
        textHaloColor: tokens.land,
        fontStack: tokens.fontRegular,
      }),
    ],
  };
}

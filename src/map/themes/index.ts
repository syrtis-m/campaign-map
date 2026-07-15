import type { StyleSpecification } from "maplibre-gl";
import { HANDCRAFTED_THEMES, type ThemeTokens } from "./tokens";
import { canonLayers } from "./canonLayers";
import { basemapLayers } from "./basemapLayers";
import { generatedLayers } from "./generatedLayers";
import { connectionLayers } from "./connectionLayers";
import { sessionPathLayers } from "./sessionPathLayers";
import { fabricLayers, FABRIC_SOURCE_SPEC } from "./fabricLayers";
import { regionLabelLayers } from "./regionLabels";
import { hillshadeLayer, hillshadeSourceSpec } from "./hillshadeLayer";
import {
  terrainContourLayer,
  TERRAIN_CONTOUR_SOURCE_ID,
  TERRAIN_CONTOUR_SOURCE_SPEC,
} from "./terrainContourLayer";
import { assertLayerOrder } from "./layerOrder";

export { HANDCRAFTED_THEMES, type ThemeTokens };

export function isHandcraftedTheme(id: string): id is keyof typeof HANDCRAFTED_THEMES {
  return id in HANDCRAFTED_THEMES;
}

/**
 * Assembles a full style for a handcrafted genre theme. `basemap` is present only for
 * real-city campaigns with a registered vault PMTiles source; fictional
 * campaigns get the theme's land/water/canon layers with no basemap source at all —
 * unexplored space reads as the theme's land color, not a void (quality-bar F4).
 */
export function buildThemeStyle(
  tokens: ThemeTokens,
  glyphsUrl: string,
  basemap?: { sourceId: string; url: string },
  dem?: { sourceId: string; url: string }
): StyleSpecification {
  return {
    version: 8,
    name: tokens.id,
    glyphs: glyphsUrl,
    sources: {
      canon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      generated: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      connections: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "session-path": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      fabric: { ...FABRIC_SOURCE_SPEC },
      ...(basemap
        ? { [basemap.sourceId]: { type: "vector" as const, url: basemap.url } }
        : {}),
      ...(dem ? { [dem.sourceId]: hillshadeSourceSpec(dem.url) } : {}),
      // Global terrain-contour surface (fictional-only, same gate as the DEM).
      ...(dem ? { [TERRAIN_CONTOUR_SOURCE_ID]: { ...TERRAIN_CONTOUR_SOURCE_SPEC } } : {}),
    },
    // Z-order invariant (see layerOrder.ts): Locations always above fabric;
    // sketched fabric above generated (the GM's hand wins). Hillshade relief
    // sits below the vector fabric, default-hidden.
    layers: assertOrdered([
      { id: "background", type: "background", paint: { "background-color": tokens.land } },
      ...(basemap ? basemapLayers(basemap.sourceId, tokens) : []),
      ...(dem ? [hillshadeLayer(tokens, dem.sourceId)] : []),
      // Contours at the bottom of the generated group (relief under fabric).
      ...(dem ? [terrainContourLayer(tokens)] : []),
      ...generatedLayers(tokens),
      ...fabricLayers(tokens),
      // Named-region overview labels ride the fabric source, above the sketch
      // fills/lines but still within the fabric z-group (below locations).
      ...regionLabelLayers(tokens),
      ...connectionLayers({ lineColor: tokens.accent }),
      ...sessionPathLayers({ lineColor: tokens.poi }),
      ...canonLayers({
        pointColor: tokens.accent,
        pointHaloColor: tokens.land,
        textColor: tokens.labelMajor,
        textHaloColor: tokens.land,
        fontStack: tokens.fontRegular,
      }),
    ]),
  };
}

/** Pass-through that enforces the plan-019 z-order contract on every build. */
export function assertOrdered(layers: StyleSpecification["layers"]): StyleSpecification["layers"] {
  assertLayerOrder(layers);
  return layers;
}

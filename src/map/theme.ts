import type { StyleSpecification } from "maplibre-gl";
import { canonLayers } from "./themes/canonLayers";
import { basemapLayers } from "./themes/basemapLayers";
import { generatedLayers } from "./themes/generatedLayers";
import { connectionLayers } from "./themes/connectionLayers";
import { sessionPathLayers } from "./themes/sessionPathLayers";
import { fabricLayers, FABRIC_SOURCE_SPEC } from "./themes/fabricLayers";
import { regionLabelLayers } from "./themes/regionLabels";
import { hillshadeLayer, hillshadeSourceSpec } from "./themes/hillshadeLayer";
import {
  terrainContourLayer,
  TERRAIN_CONTOUR_SOURCE_ID,
  TERRAIN_CONTOUR_SOURCE_SPEC,
} from "./themes/terrainContourLayer";
import { assertOrdered } from "./themes";
import type { ThemeTokens } from "./themes/tokens";

/**
 * Default theme (architecture §4): derived at runtime from the active Obsidian
 * theme's CSS variables, so the map always matches the user's look. Handcrafted
 * genre themes (parchment, ink-soot, modern-clean, neon-sprawl — src/map/themes/)
 * are per-campaign overrides with their own craft budget (quality-bar F6).
 *
 * Font caveat: "inherit theme font" is aspirational — generating glyph PBFs for an
 * arbitrary live Obsidian font is a real asset pipeline (see DECISIONS.md, the
 * glyph-PBF entry), so obsidian-native always renders labels in Inter regardless of the
 * user's actual body font. Colors/layout genuinely follow the live theme; typeface does not.
 */
export interface ObsidianCssTokens {
  backgroundPrimary: string;
  backgroundSecondary: string;
  backgroundModifierBorder: string;
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
    backgroundModifierBorder: read("--background-modifier-border", "#bbbbbb"),
    textMuted: read("--text-muted", "#888888"),
    textNormal: read("--text-normal", "#222222"),
    interactiveAccent: read("--interactive-accent", "#7c3aed"),
    fontText: read("--font-text", "sans-serif").replace(/^["']|["']$/g, ""),
  };
}

/**
 * Best-effort CSS color → [r,g,b]. Obsidian CSS variables resolve to hex or
 * rgb()/rgba() in practice; anything else returns null and the caller falls
 * back to the dark palette (Obsidian's default look).
 */
function parseCssColor(color: string): [number, number, number] | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((x) => x + x).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(c);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function isDarkBackground(color: string): boolean {
  const rgb = parseCssColor(color);
  if (!rgb) return true; // unparseable → assume Obsidian's default dark theme
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * Fabric colors for obsidian-native. Obsidian CSS variables carry
 * no green or blue we can rely on, so the nature hues (water/river/park) and
 * wall stone are fixed neutral values chosen per background luminance — the
 * *derivation* from the live theme is the light/dark split plus reusing
 * textMuted for roads (matches roadMajor) and interactiveAccent for the
 * district wash (Obsidian's own highlight language, at low fill-opacity).
 */
const FABRIC_ON_LIGHT = {
  fabricWater: "#a9c9e2",
  fabricRiver: "#5187b8",
  fabricWall: "#8a8175",
  fabricPark: "#93bd80",
  fabricForest: "#5f9560", // deeper than park; woodland on a light Obsidian theme
  fabricFarmland: "#cdb679", // warm cultivated tan on a light Obsidian theme
  fabricMountain: "#ab9d8d", // rocky taupe massif on a light Obsidian theme
  fabricPathCasing: "#6b6b6b", // darker gray rim under the road-gray park path
  fabricWaterShore: "#6f97b4", // deeper blue rim on the pale pond
} as const;
const FABRIC_ON_DARK = {
  fabricWater: "#26384c",
  fabricRiver: "#6d9bc9",
  fabricWall: "#8d8478",
  fabricPark: "#5d7a4e",
  fabricForest: "#3f5c38", // dark canopy, distinct from the park green on dark
  fabricFarmland: "#6b5d3f", // dark tilled-earth khaki on a dark Obsidian theme
  fabricMountain: "#565046", // dark slate-brown rock on a dark Obsidian theme
  fabricPathCasing: "#3a3a3a", // near-black rim under the road-gray park path
  fabricWaterShore: "#4a6a86", // lighter steel rim, reads on the dark pond
} as const;

export function obsidianTokensAsThemeTokens(tokens: ObsidianCssTokens): ThemeTokens {
  const fabric = isDarkBackground(tokens.backgroundPrimary) ? FABRIC_ON_DARK : FABRIC_ON_LIGHT;
  return {
    id: "obsidian-native",
    land: tokens.backgroundPrimary,
    water: tokens.backgroundSecondary,
    // Not `backgroundSecondary` (review/001): that's the same token `water`
    // uses, so roads and water bodies rendered as literally the same color
    // — near-invisible against `backgroundPrimary` on the stock dark theme.
    // `--background-modifier-border` is Obsidian's own "visible divider
    // against either background" variable, which is exactly the contrast
    // roads need.
    roadMajor: tokens.textMuted,
    roadMinor: tokens.backgroundModifierBorder,
    labelMajor: tokens.textNormal,
    labelMinor: tokens.textMuted,
    accent: tokens.interactiveAccent,
    poi: tokens.textMuted,
    ...fabric,
    fabricRoad: tokens.textMuted,
    fabricDistrict: tokens.interactiveAccent,
    fontRegular: "Inter Regular",
    fontRegion: "Inter Bold",
  };
}

export function obsidianNativeStyle(
  tokens: ObsidianCssTokens,
  glyphsUrl: string,
  basemap?: { sourceId: string; url: string },
  dem?: { sourceId: string; url: string }
): StyleSpecification {
  const t = obsidianTokensAsThemeTokens(tokens);
  return {
    version: 8,
    name: "obsidian-native",
    glyphs: glyphsUrl,
    sources: {
      canon: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      generated: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      connections: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "session-path": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      fabric: { ...FABRIC_SOURCE_SPEC },
      // One centroid POINT per named region — keeps the overview label from
      // repeating per-tile on a canvas-filling polygon (see regionLabels.ts).
      "region-labels": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ...(basemap ? { [basemap.sourceId]: { type: "vector" as const, url: basemap.url } } : {}),
      ...(dem ? { [dem.sourceId]: hillshadeSourceSpec(dem.url) } : {}),
      // The global terrain-contour surface is fictional-campaign-only (it derives
      // from the same composed field as the DEM); `dem` presence is exactly that
      // gate. Populated per viewport by TerrainContourManager.
      ...(dem ? { [TERRAIN_CONTOUR_SOURCE_ID]: { ...TERRAIN_CONTOUR_SOURCE_SPEC } } : {}),
    },
    // Same z-order contract as buildThemeStyle (see layerOrder.ts).
    layers: assertOrdered([
      { id: "background", type: "background", paint: { "background-color": t.land } },
      ...(basemap ? basemapLayers(basemap.sourceId, t) : []),
      ...(dem ? [hillshadeLayer(t, dem.sourceId)] : []),
      // Contours sit at the BOTTOM of the generated group (relief context under
      // the fabric), above hillshade.
      ...(dem ? [terrainContourLayer(t)] : []),
      ...generatedLayers(t),
      ...fabricLayers(t),
      // Named-region overview labels (dedicated region-labels point source,
      // fabric z-group).
      ...regionLabelLayers(t),
      ...connectionLayers({ lineColor: t.accent }),
      ...sessionPathLayers({ lineColor: t.poi }),
      ...canonLayers({
        pointColor: t.accent,
        pointHaloColor: t.land,
        textColor: t.labelMajor,
        textHaloColor: t.land,
        fontStack: t.fontRegular,
      }),
    ]),
  };
}

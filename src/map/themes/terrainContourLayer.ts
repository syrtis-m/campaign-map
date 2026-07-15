import type { LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { roleColorsForTheme } from "./roleColors";

/**
 * Global terrain contour paint (Jonah 2026-07-15: "relief lines should be
 * showing everywhere, since we have a global terrain system"). Iso-lines of the
 * campaign-wide composed terrain field (`fields/terrainContours.ts`) render as a
 * dedicated `terrain-contour` GeoJSON source, updated per viewport by
 * `TerrainContourManager`. This replaces the retired per-mountain-ring
 * `mountain-contour` generated feature — contours now appear wherever the field
 * has relief (base fBm, relief spines, landform edges, mountains), at EVERY zoom
 * (LOD is via contour INTERVAL selection per zoom, never a minzoom gate).
 *
 * The layer id is `generated-terrain-contour`, so it classifies into the
 * `generated` z-group (below the GM's sketch, above hillshade) — relief context
 * beneath the fabric. Colors flow through the `terrain-contour` semantic role
 * (mountain stone token) with a luminance-aware darken/lighten so the lines read
 * on any theme's ground, with ZERO per-theme special-casing (the 030-D contract
 * pattern: obsidian-native derives its stone from CSS vars like every genre).
 */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function clampCh(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((v) => clampCh(v).toString(16).padStart(2, "0")).join("");
}
function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}
/** Scale a hex toward black by factor `f` (relief idiom, matches generatedBuilder). */
function darken(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * f, g * f, b * f]);
}
/** Mix a hex toward white by `tw` (relief idiom, matches generatedBuilder). */
function lighten(hex: string, tw: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r + (255 - r) * tw, g + (255 - g) * tw, b + (255 - b) * tw]);
}

/** The `terrain-contour` GeoJSON source: empty until `TerrainContourManager`
 * feeds it per-viewport leaves (in DISPLAY units). */
export const TERRAIN_CONTOUR_SOURCE_ID = "terrain-contour";
export const TERRAIN_CONTOUR_SOURCE_SPEC: SourceSpecification = {
  type: "geojson",
  data: { type: "FeatureCollection", features: [] },
} as unknown as SourceSpecification;

/**
 * The single global contour layer. Width ramps by zoom and by the `index`
 * property (major index lines heavier than minor), the same cartographic cadence
 * the retired mountain-contour recipe used — NO minzoom gating (LOD is interval
 * selection per zoom, upstream in the manager).
 */
export function terrainContourLayer(t: ThemeTokens): LayerSpecification {
  const roles = roleColorsForTheme(t);
  const darkMap = luma(t.land) < 128;
  const contour = darkMap ? lighten(roles["terrain-contour"], 0.3) : darken(roles["terrain-contour"], 0.6);
  return {
    id: "generated-terrain-contour",
    type: "line",
    source: TERRAIN_CONTOUR_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": contour,
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        ["match", ["get", "index"], "major", 0.9, 0.4],
        14,
        ["match", ["get", "index"], "major", 2.2, 1.1],
      ],
      "line-opacity": ["match", ["get", "index"], "major", 0.8, 0.5],
    },
  } as unknown as LayerSpecification;
}

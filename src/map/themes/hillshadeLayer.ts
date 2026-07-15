import type { LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { DEM_TILE_RES } from "../campaignDemProtocol";

/**
 * Hillshade relief shading over the generated DEM. ONE `hillshade`
 * layer fed by a `raster-dem` source (terrarium encoding, served by the
 * `campaigndem` protocol). Sits in the `hillshade` z-group — below the vector
 * mountain fabric (massif/hachures/contours read on top of the shaded ground),
 * above basemap. Generators emit no paint here — like the rest of the theme, the
 * shading COLORS are theme-owned so every genre's relief tracks its palette.
 *
 * Default visibility is OFF (`none`): an always-visible raster-dem source would
 * make every fictional map fetch DEM tiles on pan. The view's terrain toggle is
 * pitch-adaptive (MapView.applyTerrainMode): top-down it flips THIS layer
 * visible; pitched it hides it and attaches the 3D mesh instead — the two never
 * render together (maplibre-gl 4.7.1 misrenders hillshade while a terrain mesh
 * is active). Fictional campaigns only — real-city elevation isn't supported yet.
 */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function mix([r, g, b]: Rgb, [r2, g2, b2]: Rgb, t: number): Rgb {
  return [r + (r2 - r) * t, g + (g2 - g) * t, b + (b2 - b) * t];
}
function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}
function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** The raster-dem source spec for a campaign's DEM (terrarium, served by the
 * `campaigndem` protocol). `tileSize` MUST equal the served image edge. */
export function hillshadeSourceSpec(url: string): SourceSpecification {
  return {
    type: "raster-dem",
    tiles: [url],
    tileSize: DEM_TILE_RES,
    encoding: "terrarium",
    minzoom: 0,
    maxzoom: 14,
  } as unknown as SourceSpecification;
}

/**
 * Hillshade layer, colors derived from the theme's stone/land so relief reads in
 * every genre. Shadows sink the mountain hue toward black, highlights lift it
 * toward white; the accent is the mid stone tone. On a dark-themed map the land
 * is already dark, so shadows stay subtle and highlights carry the read (mirrors
 * the luminance-aware relief contrast in generated/mountain.ts).
 */
export function hillshadeLayer(t: ThemeTokens, sourceId: string): LayerSpecification {
  const stone = hexToRgb(t.fabricMountain);
  const darkMap = luma(t.land) < 128;
  const shadow = mix(stone, BLACK, darkMap ? 0.55 : 0.75);
  const highlight = mix(stone, WHITE, darkMap ? 0.8 : 0.7);
  const accent = mix(stone, darkMap ? WHITE : BLACK, 0.2);
  return {
    id: "hillshade",
    type: "hillshade",
    source: sourceId,
    layout: { visibility: "none" },
    paint: {
      "hillshade-shadow-color": rgba(shadow, darkMap ? 0.55 : 0.7),
      "hillshade-highlight-color": rgba(highlight, darkMap ? 0.7 : 0.6),
      "hillshade-accent-color": rgba(accent, 0.4),
      "hillshade-exaggeration": 0.85,
      "hillshade-illumination-direction": 315,
      "hillshade-illumination-anchor": "viewport",
    },
  } as unknown as LayerSpecification;
}

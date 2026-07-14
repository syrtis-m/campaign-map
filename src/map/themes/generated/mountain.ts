import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Mountain fabric paint (plan 023 §3). Relief drawn bottom-up: the rocky-ground
 * MASSIF wash first, downslope HACHURE ticks above it (a darker stroke of the
 * massif hue — the classic dark-line relief read), then the summit PEAK markers
 * on top. Mountain is BASE TERRAIN, so this block sits EARLY in the emitted
 * array (after world-region, before farm/city) — a town sketched on a mountain
 * paints its footprints on top. NO zoom LOD (Jonah 2026-07-12): density is
 * paint, never a minzoom gate.
 *
 * Generators emit typed features only; all paint (incl. the darker hachure/peak
 * shades derived by relative channel moves from `fabricMountain`) lives here, so
 * every theme's stone tint is respected.
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
/** Scale toward black by `f` (<1 darkens) — the relief shadow stroke. */
function darken(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * f, g * f, b * f]);
}
/** Mix toward white by `t`. */
function lighten(hex: string, tw: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r + (255 - r) * tw, g + (255 - g) * tw, b + (255 - b) * tw]);
}
/** Rec. 601 luma of a hex color (0..255). */
function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

export function mountainLayers(t: ThemeTokens): LayerSpecification[] {
  // Relief marks must CONTRAST with the land: the classic dark-line hachure
  // idiom reads only on a LIGHT ground; on a dark-themed map (obsidian-native
  // dark, ink-soot, neon) a dark stroke on near-black land vanishes. So derive
  // hachures/peaks from `fabricMountain` but push them AWAY from the land's
  // luminance (lighter on dark maps, darker on light) — hue still tracks the
  // theme's stone (hue discipline), contrast holds either way.
  const darkMap = luma(t.land) < 128;
  const hachure = darkMap ? lighten(t.fabricMountain, 0.4) : darken(t.fabricMountain, 0.5);
  const peak = darkMap ? lighten(t.fabricMountain, 0.55) : darken(t.fabricMountain, 0.45);
  const peakRing = darkMap ? darken(t.fabricMountain, 0.4) : lighten(t.fabricMountain, 0.7);
  return [
    {
      // Rocky-ground massif: a restrained stony wash so a bare mountain reads as
      // relief without slabbing the base (the district purple-slab lesson —
      // opacity stays low on the dark themes). `fill-antialias: false` kills the
      // per-polygon hairline. Painted FIRST so hachures + peaks layer above.
      id: "generated-mountain-massif",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "mountain-massif"],
      paint: { "fill-color": t.fabricMountain, "fill-opacity": 0.45, "fill-antialias": false },
    } as unknown as LayerSpecification,
    {
      // Downslope hachure ticks — a darker stroke of the massif hue (dark-line
      // relief idiom), thin, ABOVE the massif so the shading reads over the rock.
      id: "generated-mountain-hachure",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "mountain-hachure"],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": hachure,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 14, 2.6],
        "line-opacity": 0.85,
      },
    } as unknown as LayerSpecification,
    {
      // Summit peaks — small dark stone markers, radius ∝ the generator's sizeN
      // (bigger summits read larger), the top of the relief stack.
      id: "generated-mountain-peak",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "mountain-peak"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "sizeN"], 0, 1.8, 1, 4.2],
        "circle-color": peak,
        "circle-opacity": 0.95,
        // A light rim so a dark summit dot still reads against the dark massif /
        // dark themes (contrast on both light and dark backgrounds).
        "circle-stroke-color": peakRing,
        "circle-stroke-width": 1,
        "circle-stroke-opacity": 0.9,
      },
    } as unknown as LayerSpecification,
  ];
}

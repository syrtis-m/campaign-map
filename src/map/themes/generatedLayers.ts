import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { CANON_DOT_RADIUS } from "./canonLayers";

/**
 * Generated city/world fabric (Phase 3), styled from the same theme tokens
 * as the real-city basemap and canon layers so it reads as "part of the
 * map," not a debug overlay — quality-bar F2 (provenance invisibility): a
 * GM shouldn't be able to eyeball canon vs. generated, only distinguish
 * them through the "Canonize" action. Settlement points reuse canon-point's
 * exact circle+label recipe (same property schema: importance/minZoom/
 * maxZoom/name — see gen/world/settlements.ts) against the "generated"
 * source instead of "canon".
 */
export function generatedLayers(t: ThemeTokens): LayerSpecification[] {
  const zoomFilter = ["all", ["<=", ["get", "minZoom"], ["zoom"]], ["<=", ["zoom"], ["get", "maxZoom"]]];

  return [
    {
      id: "generated-region",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-region"],
      paint: {
        "fill-color": [
          "match",
          ["get", "biome"],
          "ocean", t.water,
          "coast", t.water,
          // all land biomes fall through to land — ocean vs. land is the
          // whole win here (it produces the coastline); per-biome hues are
          // a follow-up (see maintenance notes in plans/002).
          t.land,
        ],
        "fill-opacity": 0.9,
      },
    } as unknown as LayerSpecification,
    {
      // Districts are the *persistent* city fabric — large area fills stay
      // legible when thin street lines thin to sub-pixel on zoom-out. Bumped
      // from a near-invisible 0.05 to a subtle-but-present 0.09 so "there's a
      // city here" still reads once streets get small, without washing out
      // close-up detail (kept flat/low — a heavier or outlined fill turned the
      // near-black neon base into a solid purple slab when zoomed into a block).
      id: "generated-district",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-district"],
      paint: { "fill-color": t.poi, "fill-opacity": 0.09 },
    } as unknown as LayerSpecification,
    {
      id: "generated-footprint",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-footprint"],
      minzoom: 14,
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.3 },
    } as unknown as LayerSpecification,
    {
      id: "generated-route",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-route"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.roadMajor, "line-width": 1.5, "line-dasharray": [2, 2] },
    } as unknown as LayerSpecification,
    {
      id: "generated-street",
      type: "line",
      source: "generated",
      // sketch-corridor (plan 014) streets are city streets by another
      // generator — same paint, so elaborated sketches read as native fabric.
      filter: ["match", ["get", "generatorId"], ["city-street", "sketch-corridor"], true, false],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.roadMinor,
        // Width FLOOR of ~1px: streets used to interpolate down to 0.5px at
        // z10 (thinner still below), going sub-pixel and vanishing on a dark
        // base as you zoomed out. Never let a street render narrower than it
        // takes to be seen — it thickens with zoom for detail, but the low end
        // holds a visible minimum so the road network doesn't blink out.
        // Corridor avenues (roadClass "major") render a step wider so the
        // GM's drawn arterial stays legible over its branches. NOTE: the
        // zoom `interpolate` MUST be the top-level expression — MapLibre
        // rejects `zoom` nested inside another expression (e.g. `["*", …,
        // interpolate(zoom)]`) and that silently invalidates the whole style
        // (map loads blank, no error — 006-class). So the per-feature avenue
        // multiplier is folded into each interpolate output instead.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["*", 1, ["case", ["==", ["get", "roadClass"], "major"], 1.8, 1]],
          12, ["*", 1.6, ["case", ["==", ["get", "roadClass"], "major"], 1.8, 1]],
          18, ["*", 3.5, ["case", ["==", ["get", "roadClass"], "major"], 1.8, 1]],
        ],
      },
    } as unknown as LayerSpecification,
    {
      // One dot, every zoom, one constant size — identical to canon-point
      // (provenance invisibility, F2). No zoom filter (settlements never vanish
      // on zoom-out), no importance-scaled radius. Replaces the former
      // generated-point / generated-point-far split.
      id: "generated-point",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-settlement"],
      paint: {
        "circle-radius": CANON_DOT_RADIUS,
        "circle-color": t.accent,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": t.land,
      },
    } as unknown as LayerSpecification,
    {
      id: "generated-label",
      type: "symbol",
      source: "generated",
      filter: ["all", ["==", ["get", "generatorId"], "world-settlement"], zoomFilter],
      layout: {
        "text-field": ["get", "name"],
        "text-font": [t.fontRegular],
        "text-size": ["interpolate", ["linear"], ["get", "importance"], 1, 18, 7, 11],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "symbol-sort-key": ["get", "importance"],
        "text-optional": true,
      },
      paint: {
        "text-color": t.labelMajor,
        "text-halo-color": t.land,
        "text-halo-width": 1.5,
      },
    } as unknown as LayerSpecification,
  ];
}

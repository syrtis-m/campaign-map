import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";

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
      id: "generated-district",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "city-district"],
      paint: { "fill-color": t.poi, "fill-opacity": 0.05 },
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
      filter: ["==", ["get", "generatorId"], "city-street"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.roadMinor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 18, 3],
      },
    } as unknown as LayerSpecification,
    {
      // Same "always a dot, even zoomed out past the type's normal range"
      // treatment as canon-point-far (src/map/themes/canonLayers.ts) —
      // provenance must stay invisible (F2), so generated settlements get
      // the identical far-zoom affordance canon locations do.
      id: "generated-point-far",
      type: "circle",
      source: "generated",
      filter: ["all", ["==", ["get", "generatorId"], "world-settlement"], ["<", ["zoom"], ["get", "minZoom"]]],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "importance"], 1, 4, 7, 2],
        "circle-color": t.accent,
        "circle-opacity": 0.75,
      },
    } as unknown as LayerSpecification,
    {
      id: "generated-point",
      type: "circle",
      source: "generated",
      filter: ["all", ["==", ["get", "generatorId"], "world-settlement"], zoomFilter],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "importance"], 1, 7, 7, 3],
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

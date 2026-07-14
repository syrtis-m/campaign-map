import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * World-tier generated fabric. Split across the emitted array: the region fill
 * is the FIRST generated layer (ocean/land coastline base); world routes paint
 * near the END (above every city/forest/park/wall block, below city streets) so
 * an overland route reads over the terrain it crosses. generatedLayers.ts keeps
 * these two fragments in their original positions — do not merge them into one
 * contiguous block (that would reorder route relative to the city/forest/etc.
 * layers and break style byte-identity).
 */
export function worldRegionLayers(t: ThemeTokens): LayerSpecification[] {
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
          // Water biomes use the fabric water token so a generated ocean and
          // a sketched lake read as the same water (F2).
          "ocean", t.fabricWater,
          "coast", t.fabricWater,
          // all land biomes fall through to land — ocean vs. land is the
          // whole win here (it produces the coastline); per-biome hues are
          // a follow-up (see maintenance notes in plans/002).
          t.land,
        ],
        "fill-opacity": 0.9,
      },
    } as unknown as LayerSpecification,
  ];
}

export function worldRouteLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // World routes are roads by another tier — fabric road hue, dashed to
      // read as an overland route rather than a street.
      id: "generated-route",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "world-route"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.fabricRoad, "line-width": 1.5, "line-dasharray": [2, 2] },
    } as unknown as LayerSpecification,
  ];
}

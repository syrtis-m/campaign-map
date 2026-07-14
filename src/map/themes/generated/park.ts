import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Park fabric (procgen v4.7, plan 022 §3.3). Composed top-down: lawn ground
 * first, then beds/court/paths, then pond water + island + bridge, then the
 * rock + tree stipples on top. NO zoom LOD (Jonah 2026-07-12).
 */
export function parkLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Procgen v4.7 park (plan 022 §3.3): the ground fabric — a manicured lawn
      // in the per-theme `fabricPark` green (F2: a generated park and a sketched
      // park read as the same class of thing). NO zoom LOD (Jonah 2026-07-12).
      // The ground paints FIRST so every other park element layers above it.
      id: "generated-park-lawn",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-lawn"],
      paint: { "fill-color": t.fabricPark, "fill-opacity": 0.55 },
    } as unknown as LayerSpecification,
    {
      // Planting beds: denser cultivation than the lawn — the deeper woodland
      // green (fabricForest) reads as shrub/flower beds. Above the lawn.
      id: "generated-park-bed",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-bed"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Karesansui raked-gravel court (japanese-garden): pale stony ground in
      // the sandstone `fabricWall` hue, a low wash so the rocks read on top.
      id: "generated-park-court",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-court"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.4 },
    } as unknown as LayerSpecification,
    {
      // Garden paths: same hue as sketched roads (F2). Above the ground fills,
      // below the water so a bridge (not the path) carries a pond crossing.
      id: "generated-park-path",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-path"],
      paint: { "fill-color": t.fabricRoad, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Pond: the composition anchor — water hue (F2: reads as the same water
      // as a sketched pond). Above the ground + paths so it reads as a pool.
      id: "generated-park-pond",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-pond"],
      paint: { "fill-color": t.fabricWater, "fill-opacity": 0.9 },
    } as unknown as LayerSpecification,
    {
      // Pond island: dry land in the pond — land hue, ABOVE the pond water so it
      // reads as a hole of ground (same idiom as a river island).
      id: "generated-park-island",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-island"],
      paint: { "fill-color": t.land, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Bridges: short decks where the path crosses to the island — the stone
      // `fabricWall` hue, ABOVE the pond + island so the span reads over water.
      id: "generated-park-bridge",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-bridge"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Rock groupings (japanese-garden): solid stones — the stone hue at full
      // opacity, ABOVE the gravel court so a karesansui reads rocks-on-gravel.
      id: "generated-park-rock",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-rock"],
      paint: { "circle-radius": 2.2, "circle-color": t.fabricWall, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Park trees: specimen/scatter trees in the deeper canopy green, painted
      // ABOVE everything so the greenery keeps a legible stipple.
      id: "generated-park-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-tree"],
      paint: { "circle-radius": 1.8, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
  ];
}

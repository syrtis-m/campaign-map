import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Wall fabric. Composed bottom-up: outboard moat water first, then the masonry
 * band, then towers/bastions, then the gate markers. No zoom LOD — fabric
 * renders at every zoom.
 */
export function wallLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // The outboard MOAT — water hue (F2: reads as the same water as a
      // sketched river/pond). Painted FIRST of the
      // wall stack so the masonry band + towers sit above it. NO zoom LOD.
      id: "generated-wall-moat",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-moat"],
      paint: { "fill-color": t.fabricWater, "fill-opacity": 0.8 },
    } as unknown as LayerSpecification,
    {
      // The masonry band — the sketched-wall stone hue (F2: a generated wall
      // and a sketched/city wall read as the same class of thing). Above the
      // moat, below the towers. Palisades share the hue; the theme could tint
      // per `wallStyle` later (the property is carried on every feature).
      id: "generated-wall-quad",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-quad"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Towers / bastions: solid stone at full opacity, ABOVE the band so a
      // curtain wall reads as wall-plus-towers and a bastioned trace reads as
      // angular star-fort points.
      id: "generated-wall-tower",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-tower"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 1 },
    } as unknown as LayerSpecification,
    {
      // Gates: unnamed stone dots where a sketched road pierces the wall — small
      // circles, never Location pins (I4). Same idiom as the city gate points.
      id: "generated-wall-gate",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "wall-gate"],
      paint: { "circle-radius": 3, "circle-color": t.fabricWall, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
  ];
}

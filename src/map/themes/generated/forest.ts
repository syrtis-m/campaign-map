import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Forest fabric (procgen v4.6, plan 022 §3.2). Canopy first, clearings then
 * trees above. Forest is stage 2 (below city, stage 3): this block sorts before
 * the district/street/footprint layers in the emitted array, so a town in the
 * woods reads as a clearing without the forest ever seeing the city (plan 022
 * §3.2 one-direction rule). NO zoom LOD (Jonah 2026-07-12).
 */
export function forestLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Procgen v4.6 forest canopy (plan 022 §3.2): woodland fill in the
      // deeper `fabricForest` green (F2: one legend per kind — a generated
      // forest and a sketched forest read as the same class of thing). NO zoom
      // LOD (Jonah 2026-07-12). Canopy paints FIRST so clearings + trees layer
      // above it. Forest is stage 2 (below city, which is stage 3): its layer
      // id sorts before the district/street/footprint layers in this array, so
      // a town in the woods reads as a clearing without the forest ever seeing
      // the city (plan 022 §3.2 one-direction rule).
      id: "generated-forest-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.8 },
    } as unknown as LayerSpecification,
    {
      // Forest clearings: open ground punched into the canopy — land hue,
      // painted ABOVE the canopy so the glade reads as a hole of ground.
      id: "generated-forest-clearing",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-clearing"],
      paint: { "fill-color": t.land, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // Individual trees: small stipple circles in a darker shade of the
      // canopy, painted ABOVE canopy + clearings so the forest keeps a legible
      // texture even where the canopy fill thins near the ragged edge.
      id: "generated-forest-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "forest-tree"],
      paint: { "circle-radius": 1.6, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
  ];
}

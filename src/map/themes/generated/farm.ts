import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Farmland fabric (plan 022 §4.9, plan 022 §3.5).
 * Farmland is stage 2 (agriculture) and the city is stage 3, so the whole
 * farm stack sits EARLY in the emitted array — BELOW the district/footprint/street
 * layers — so a city sketched over/beside farmland reads with the city on
 * top (advisor 2026-07-13; deliberately NOT forest's mid-array slot, which
 * paints canopy above city footprints). NO zoom LOD (Jonah 2026-07-12).
 */
export function farmLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Tilled fields — the warm cultivated `fabricFarmland` wash (F2: one
      // legend per kind; a generated field and a sketched farmland read as the
      // same class of thing). Plain token; `crop` is carried on each feature for
      // future theme texture but never branched here (keeps the paint a plain
      // token so the coverage guard's fillColor() stays valid).
      id: "generated-farm-field",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-field"],
      paint: { "fill-color": t.fabricFarmland, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Farm lanes / section roads — the fabric road hue (F2), a thin dirt
      // track, ABOVE the field fill so the lanes read over the crops.
      id: "generated-farm-lane",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-lane"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.fabricRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 16, 2.5],
        "line-opacity": 0.85,
      },
    } as unknown as LayerSpecification,
    {
      // Field-edge hedges/fences — hedgerows read as the deeper woodland green,
      // fences as the stone/timber `fabricWall` hue (branch on the `hedging`
      // property carried by every hedge feature). Above the field, below the
      // buildings/trees.
      id: "generated-farm-hedge",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-hedge"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "hedging"], "fences", t.fabricWall, t.fabricForest],
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 16, 1.8],
        "line-opacity": 0.8,
      },
    } as unknown as LayerSpecification,
    {
      // Farmstead footprints — heavier buildings in the roadMinor hue, like the
      // city footprints (F2: a building reads as a building), ABOVE the fields.
      id: "generated-farm-building",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "farm-building"],
      paint: { "fill-color": t.roadMinor, "fill-opacity": 0.7 },
    } as unknown as LayerSpecification,
    {
      // Orchard trees — regular tree rows, small stipple circles in the deeper
      // canopy green (F2: reads as the same greenery as forest/park trees),
      // ABOVE the fields so the rows keep a legible texture.
      id: "generated-orchard-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "orchard-tree"],
      paint: { "circle-radius": 1.5, "circle-color": t.fabricForest, "circle-opacity": 0.95 },
    } as unknown as LayerSpecification,
  ];
}

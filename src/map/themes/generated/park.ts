import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * Park fabric (procgen v4.7 → plan 027-A figure-ground overhaul). Composed
 * bottom-up: the merged lawn ground first, then the darker CANOPY (the second
 * green — lawn vs wooded blocks, the #1 legibility fix), then beds/court, then
 * the CASED path lines (a darker casing line UNDER a lighter fill line — round
 * joins fix the old notch), then pond water + a shore-casing rim + island +
 * bridge, then the rock + tree stipples on top. NO zoom LOD in any FILTER
 * (Jonah 2026-07-12) — the size/width ramps below key on zoom in PAINT only,
 * which is the endorsed density fix, never a zoom gate.
 */
export function parkLayers(t: ThemeTokens): LayerSpecification[] {
  // Casing tokens are additive (plan 027-A) — fall back to stony/water hues so
  // the layers always paint even against an older ThemeTokens literal.
  const pathCasing = t.fabricPathCasing ?? t.fabricWall;
  const waterShore = t.fabricWaterShore ?? t.fabricRiver;
  return [
    {
      // Ground: ONE merged lawn polygon (= the sketched ring) in the per-theme
      // `fabricPark` green (F2: a generated park and a sketched park read as the
      // same class of thing). Paints FIRST so everything layers above it. The
      // merged polygon has no interior seams — this replaces the old 22 m cell
      // lattice that produced the antialiasing hairline grid. NO zoom LOD.
      id: "generated-park-lawn",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-lawn"],
      paint: { "fill-color": t.fabricPark, "fill-opacity": 0.6 },
    } as unknown as LayerSpecification,
    {
      // Canopy: the second green — wooded blocks in the DEEPER `fabricForest`
      // green, above the lawn so the park reads as figure (canopy) vs ground
      // (lawn). High opacity so overlapping clumps read as one wooded mass
      // (real polygon union lands in 27-C).
      id: "generated-park-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.85 },
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
      // Path CASING: the darker under-line of a cased path, drawn FIRST (below
      // the fill line) and wider so it reads as an edge. Class-differentiated
      // width (a formal `axis` is grander than a `walk`), zoom-interpolated so
      // paths thin out on the overview and thicken on approach.
      id: "generated-park-path-casing",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-path"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": pathCasing,
        "line-opacity": 0.85,
        // A single top-level zoom interpolate (MapLibre requires zoom to be the
        // direct input to interpolate) whose per-stop output is a zoom-free
        // class match — grander for a formal `axis`, thinnest for a `walk`.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 4, "loop", 3, "circuit", 2.6, "walk", 2.2, 3],
          15, ["match", ["get", "class"], "axis", 9, "loop", 7, "circuit", 6, "walk", 5, 6],
        ],
      },
    } as unknown as LayerSpecification,
    {
      // Path FILL: the lighter top-line in the sketched-road hue (F2), narrower
      // than its casing so a rim of casing shows on both banks. Above the casing.
      id: "generated-park-path",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-path"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.fabricRoad,
        "line-opacity": 0.95,
        // Narrower than the casing at every zoom so a casing rim shows on both
        // banks; same top-level-zoom / class-match shape as the casing above.
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 2.4, "loop", 1.6, "circuit", 1.3, "walk", 1, 1.6],
          15, ["match", ["get", "class"], "axis", 6, "loop", 4.5, "circuit", 3.6, "walk", 3, 4],
        ],
      },
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
      // Pond SHORE casing: a thin rim line on the pond boundary, drawn ABOVE the
      // pond fill so the water edge reads crisply (a shore is a rim, not an
      // under-casing — hence above its fill, unlike the path casing).
      id: "generated-park-pond-shore",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-pond"],
      layout: { "line-join": "round" },
      paint: {
        "line-color": waterShore,
        "line-opacity": 0.9,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 15, 2],
      },
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
      // Bigger than v4.7's flat 2.2 px and zoom-ramped so they read on approach
      // without cluttering the z4.5 overview.
      id: "generated-park-rock",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-rock"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.4, 14, 3.2],
        "circle-color": t.fabricWall,
        "circle-opacity": 0.95,
      },
    } as unknown as LayerSpecification,
    {
      // Park trees: specimen/scatter trees in the deeper canopy green, painted
      // ABOVE everything so the greenery keeps a legible stipple. Zoom-ramped
      // (smaller on the overview) so a wooded park is not a field of dots at z4.5.
      id: "generated-park-tree",
      type: "circle",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-tree"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.2, 14, 2.6],
        "circle-color": t.fabricForest,
        "circle-opacity": 0.95,
      },
    } as unknown as LayerSpecification,
  ];
}

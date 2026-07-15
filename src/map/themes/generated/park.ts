import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";
import { parkPointIconExpr, parkRockIconExpr, parkTreeIconExpr } from "../../parkGlyphs";

/**
 * Park fabric. Composed bottom-up: the merged lawn ground, then the darker
 * CANOPY (the second green — ONE organic marching-squares MultiPolygon with a
 * seam-safe rim, so overlapping clumps no longer double-darken), then
 * beds/court + karesansui rake, then the CASED path lines (casing under fill),
 * then the organic pond + a seam-safe shore-casing rim + island + bridge, then
 * the rock + tree + landmark SDF-glyph symbols on top. No zoom LOD in any FILTER
 * — the size/width/opacity ramps below key on zoom in PAINT only, never a zoom
 * gate.
 *
 * All differentiation is theme-side (generators emit typed features only):
 *  - CANOPY is a single organic MultiPolygon (`fill-antialias:false` kills the
 *    per-polygon hairline) + a `park-canopy-rim` LineString outline (seam-safe:
 *    a separate line feature, never a line layer on the fill).
 *  - POND shore casing filters the SEPARATE `park-pond-shore` LineStrings (a
 *    line-on-fill shore would stroke tile-clip seams on a pond straddling a
 *    tile edge).
 *  - `park-court-rake` = raked-gravel furrow lines over the karesansui court.
 *  - Rocks / trees / landmark points are SDF-glyph SYMBOL layers (shared
 *    `treeGlyphs.ts` machinery via `parkGlyphs.ts`): tinted per theme by
 *    `icon-color`, rimmed by `icon-halo`, zoom-ramped size/opacity (halo→0 at
 *    the overview so the downscaled SDF AA doesn't smear into a box).
 */
export function parkLayers(t: ThemeTokens): LayerSpecification[] {
  // Casing tokens are optional — fall back to stony/water hues so
  // the layers always paint even against an older ThemeTokens literal.
  const pathCasing = t.fabricPathCasing ?? t.fabricWall;
  const waterShore = t.fabricWaterShore ?? t.fabricRiver;

  // Shared symbol layout for the greenery/landmark glyphs: allow-overlap +
  // ignore-placement skip collision detection (the symbol perf cliff), and the
  // glyphs render at every zoom (icon-size only ramps the footprint — NOT a
  // minzoom gate).
  const glyphLayout = (iconImage: unknown, anchor: "bottom" | "center", sizeStops: [number, number][]) => ({
    "icon-image": iconImage,
    "icon-size": ["interpolate", ["linear"], ["zoom"], ...sizeStops.flatMap(([z, s]) => [z, s])],
    "icon-anchor": anchor,
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "icon-padding": 0,
    "symbol-z-order": "viewport-y",
  });
  // Halo ramps to ~0 toward the fictional overview (~z4.5) so the SDF downscale
  // AA doesn't read as a pale box. Pure `["zoom"]` = paint.
  const haloWidth: unknown = ["interpolate", ["linear"], ["zoom"], 5.5, 0, 9, 1.6];

  return [
    {
      // Ground: ONE merged lawn polygon (= the sketched ring) in the per-theme
      // `fabricPark` green. Paints FIRST so everything layers above it. NO zoom LOD.
      id: "generated-park-lawn",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-lawn"],
      paint: { "fill-color": t.fabricPark, "fill-opacity": 0.6 },
    } as unknown as LayerSpecification,
    {
      // Canopy: the second green — ONE organic MultiPolygon in the
      // deeper `fabricForest` green, above the lawn so the park reads as figure
      // (canopy) vs ground (lawn). `fill-antialias:false` removes the per-polygon
      // hairline. A blob-UNION now, so overlapping clumps paint one flat mass.
      id: "generated-park-canopy",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-canopy"],
      paint: { "fill-color": t.fabricForest, "fill-opacity": 0.85, "fill-antialias": false },
    } as unknown as LayerSpecification,
    {
      // Canopy RIM: a darker line tracing the canopy outline (+ any
      // hole) so the wooded mass reads as a drawn shape. Filters the SEPARATE
      // `park-canopy-rim` LineStrings (seam-safe — never a line on the fill). No LOD.
      id: "generated-park-canopy-rim",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-canopy-rim"],
      paint: { "line-color": pathCasing, "line-width": 0.8, "line-opacity": 0.55 },
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
      // the sandstone `fabricWall` hue, a low wash so the rocks + rake read on top.
      id: "generated-park-court",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-court"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.4 },
    } as unknown as LayerSpecification,
    {
      // Karesansui RAKE: the gravel furrow lines, ABOVE the court
      // wash. A darker stony hue so the raked texture reads. Seam-safe LineStrings.
      id: "generated-park-court-rake",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-court-rake"],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": pathCasing,
        "line-opacity": 0.5,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 15, 1.2],
      },
    } as unknown as LayerSpecification,
    {
      // Path CASING: the darker under-line of a cased path, drawn FIRST (below
      // the fill line) and wider so it reads as an edge. Class-differentiated
      // width, zoom-interpolated so paths thin out on the overview.
      id: "generated-park-path-casing",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-path"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": pathCasing,
        "line-opacity": 0.85,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 4, "loop", 3, "circuit", 2.6, "walk", 2.2, "roji", 1.8, 3],
          15, ["match", ["get", "class"], "axis", 9, "loop", 7, "circuit", 6, "walk", 5, "roji", 4, 6],
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
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          8, ["match", ["get", "class"], "axis", 2.4, "loop", 1.6, "circuit", 1.3, "walk", 1, "roji", 0.8, 1.6],
          15, ["match", ["get", "class"], "axis", 6, "loop", 4.5, "circuit", 3.6, "walk", 3, "roji", 2.4, 4],
        ],
      },
    } as unknown as LayerSpecification,
    {
      // Pond: the composition anchor — an organic MultiPolygon in
      // the water hue. Above the ground + paths so it reads as a pool.
      id: "generated-park-pond",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-pond"],
      paint: { "fill-color": t.fabricWater, "fill-opacity": 0.9 },
    } as unknown as LayerSpecification,
    {
      // Pond SHORE casing: the SEPARATE `park-pond-shore` LineStrings
      // (seam-safe) — a thin rim on the water edge, ABOVE the pond fill so the
      // shore reads crisply (a rim, not an under-casing).
      id: "generated-park-pond-shore",
      type: "line",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-pond-shore"],
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
      // Bridges: short decks (arch or yatsuhashi zigzag) where the path crosses
      // to the island — the stone `fabricWall` hue, ABOVE the pond + island so the
      // span reads over water.
      id: "generated-park-bridge",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-bridge"],
      paint: { "fill-color": t.fabricWall, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
    {
      // Park trees: specimen/scatter trees as SDF tree GLYPHS (the shared
      // tree-glyph set, keyed on treeFamily+variant), tinted the deeper canopy green,
      // painted ABOVE the greenery. Zoom-ramped footprint so a wooded park is not
      // a field of dots at z4.5; a lighter `icon-halo` rim (park green) lifts each
      // crown off the same-family canopy, ramped to 0 at the overview.
      id: "generated-park-tree",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-tree"],
      layout: glyphLayout(parkTreeIconExpr(), "bottom", [
        [4, 0.16],
        [8, 0.5],
        [12, 0.85],
      ]),
      paint: {
        "icon-color": t.fabricForest,
        "icon-halo-color": t.fabricPark,
        "icon-halo-width": haloWidth,
        "icon-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.85, 8, 1],
      },
    } as unknown as LayerSpecification,
    {
      // Rock groupings (japanese-garden): SDF boulder GLYPHS (horizontal-dominant,
      // 3 hashed variants) in the stone hue at full opacity, ABOVE the gravel court
      // so a karesansui reads rocks-on-gravel. Anchored center (a stone lies flat).
      id: "generated-park-rock",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-rock"],
      layout: glyphLayout(parkRockIconExpr(), "center", [
        [6, 0.2],
        [14, 0.6],
      ]),
      paint: {
        "icon-color": t.fabricWall,
        "icon-halo-color": pathCasing,
        "icon-halo-width": haloWidth,
        "icon-opacity": 1,
      },
    } as unknown as LayerSpecification,
    {
      // Park point dressing: fountain / bandstand / monument /
      // lantern / teahouse as per-kind SDF landmark GLYPHS (parkGlyphs.ts),
      // painted ON TOP so the composition's focal points read. Tinted per
      // `pointKind` (water fountains, stony lanterns/monuments, accent bandstands).
      id: "generated-park-point",
      type: "symbol",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "park-point"],
      layout: glyphLayout(parkPointIconExpr(), "bottom", [
        [5, 0.35],
        [14, 1],
      ]),
      paint: {
        "icon-color": [
          "match",
          ["get", "pointKind"],
          "fountain",
          t.fabricWater,
          "bandstand",
          t.accent,
          "monument",
          t.fabricWall,
          "lantern",
          t.fabricWall,
          "teahouse",
          t.fabricWall,
          t.accent,
        ],
        "icon-halo-color": t.land,
        "icon-halo-width": haloWidth,
        "icon-opacity": 1,
      },
    } as unknown as LayerSpecification,
  ];
}

import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { FABRIC_KINDS, isPolygonKind, type FabricKind } from "../../model/fabric";

/**
 * Sketched-fabric layers — one line/fill layer per fabric kind on the `fabric`
 * geojson source, themed via tokens like connections/session-path so sketches
 * read consistently across every map style.
 *
 * NO zoom-based LOD here: fabric renders at EVERY zoom — a drawn
 * road/wall/river/park/water/district is always visible, never gated by a
 * per-kind `minzoom`. Only the source's `tolerance` still applies — that's
 * geometry *simplification* for perf (fewer vertices far out), not hiding: the
 * feature always draws, just with a coarser outline when zoomed way out.
 */

export const FABRIC_LAYER_IDS = FABRIC_KINDS.map((k) => `fabric-${k}`);

/** The `fabric` source spec both style builders register — `tolerance` gives
 * zoom-dependent Douglas-Peucker simplification so dense sketched polylines
 * simplify as you zoom out rather than rendering every hand-placed vertex. */
export const FABRIC_SOURCE_SPEC = {
  type: "geojson" as const,
  tolerance: 2,
  data: { type: "FeatureCollection" as const, features: [] },
};

function kindFilter(kind: FabricKind): unknown {
  // Filter by kind ONLY. Never put a `["zoom"]` expression in a layer `filter`
  // — it silently invalidates the ENTIRE style (map loads blank, no console
  // error). Fabric has no zoom gating at all, so there's nothing zoom-related
  // to express here anyway.
  return ["==", ["get", "kind"], kind];
}

export function fabricLayers(tokens: ThemeTokens): LayerSpecification[] {
  const layers: Record<FabricKind, unknown> = {
    // Polygons (drawn first, under the line kinds)
    // Per-kind colors are the dedicated fabric tokens: each of the
    // six kinds must read visibly distinct in every theme — river ≠ water,
    // park reads green, wall reads stony, district is a subtle wash. Never
    // reuse a label/poi/road token here; that's exactly what made the map
    // muddy before.
    water: {
      id: "fabric-water",
      type: "fill",
      source: "fabric",
      filter: kindFilter("water"),
      paint: {
        "fill-color": tokens.fabricWater,
        "fill-opacity": 0.85,
        // Shoreline in the river hue: defines the water edge against land and
        // keeps river lines coherent where they meet a lake.
        "fill-outline-color": tokens.fabricRiver,
      },
    },
    district: {
      id: "fabric-district",
      type: "fill",
      source: "fabric",
      filter: kindFilter("district"),
      // Low opacity is load-bearing: a heavier district fill turned the
      // near-black neon base into a purple slab (see generatedLayers.ts).
      paint: {
        "fill-color": tokens.fabricDistrict,
        "fill-opacity": 0.18,
        "fill-outline-color": tokens.fabricDistrict,
      },
    },
    park: {
      id: "fabric-park",
      type: "fill",
      source: "fabric",
      filter: kindFilter("park"),
      paint: {
        "fill-color": tokens.fabricPark,
        "fill-opacity": 0.45,
        "fill-outline-color": tokens.fabricPark,
      },
    },
    forest: {
      // Inert sketched forest: a FAINT canopy-green wash so an un-generated
      // forest outline reads as "woodland here" without competing with the
      // dense generated canopy. Once a procgen block is attached the generated
      // `forest-canopy` cells ARE the paint, so the raw polygon drops to
      // opacity 0 — same mechanism as the river spine line (fill stays
      // rendered so queryRenderedFeatures still hit-tests it for selection).
      id: "fabric-forest",
      type: "fill",
      source: "fabric",
      filter: kindFilter("forest"),
      paint: {
        "fill-color": tokens.fabricForest,
        "fill-opacity": ["case", ["has", "procgen"], 0, 0.28],
        "fill-outline-color": tokens.fabricForest,
      },
    },
    farmland: {
      // Inert sketched farmland: a faint
      // cultivated-tan wash so an un-generated farmland outline reads as
      // "fields here" without competing with the dense generated fields. Once a
      // procgen block is attached the generated `farm-field` polygons ARE the
      // paint, so the raw polygon drops to opacity 0 — same mechanism as the
      // forest fill / river+wall spine lines (fill stays rendered so
      // queryRenderedFeatures still hit-tests it for selection).
      id: "fabric-farmland",
      type: "fill",
      source: "fabric",
      filter: kindFilter("farmland"),
      paint: {
        "fill-color": tokens.fabricFarmland,
        "fill-opacity": ["case", ["has", "procgen"], 0, 0.28],
        "fill-outline-color": tokens.fabricFarmland,
      },
    },
    mountain: {
      // Inert sketched mountain: a faint
      // rocky wash so an un-generated mountain outline reads as "relief here"
      // without competing with the generated massif/hachures. Once a procgen
      // block is attached the generated `mountain-massif` + hachures ARE the
      // paint, so the raw polygon drops to opacity 0 — same mechanism as the
      // forest/farmland fill (fill stays rendered so queryRenderedFeatures still
      // hit-tests it for selection).
      id: "fabric-mountain",
      type: "fill",
      source: "fabric",
      filter: kindFilter("mountain"),
      paint: {
        "fill-color": tokens.fabricMountain,
        "fill-opacity": ["case", ["has", "procgen"], 0, 0.28],
        "fill-outline-color": tokens.fabricMountain,
      },
    },
    landform: {
      // Sketched landform (plateau/basin/sea replace-stamp). A SEA reads as
      // theme water (shortlist 5): the coast used to be blank parchment because
      // sea-mode landforms only shape the DEM. `landformMode` is lifted to a
      // filterable property by the fabric mirror (MapView.refreshFabric) from the
      // procgen `mode` — persisted bytes untouched. Plateau/basin keep the subtle
      // relief wash (mountain token) and, once a procgen block is attached, drop
      // to opacity 0 since their visible form is the composed-field contours/
      // hillshade (plan 036-C). Sea stays painted regardless so the water reads.
      // Fill stays rendered in all cases so queryRenderedFeatures hit-tests it.
      id: "fabric-landform",
      type: "fill",
      source: "fabric",
      filter: kindFilter("landform"),
      paint: {
        "fill-color": ["case", ["==", ["get", "landformMode"], "sea"], tokens.fabricWater, tokens.fabricMountain],
        "fill-opacity": [
          "case",
          ["==", ["get", "landformMode"], "sea"], 0.7,
          ["has", "procgen"], 0,
          0.2,
        ],
        "fill-outline-color": ["case", ["==", ["get", "landformMode"], "sea"], tokens.fabricRiver, tokens.fabricMountain],
      },
    },
    // Lines
    relief: {
      // Inert sketched relief (ridge/valley add-stamp): a faint dashed relief
      // stroke in the mountain hue. Its VISIBLE form is the composed-field
      // contours (plan 036-C); the raw spine drops to opacity 0 once a procgen
      // block is attached (still rendered for hit-testing / selection).
      id: "fabric-relief",
      type: "line",
      source: "fabric",
      filter: kindFilter("relief"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": tokens.fabricMountain,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 4],
        "line-dasharray": [3, 2],
        "line-opacity": ["case", ["has", "procgen"], 0, 0.7],
      },
    },
    river: {
      id: "fabric-river",
      type: "line",
      source: "fabric",
      filter: kindFilter("river"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": tokens.fabricRiver,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 5],
        // A river carrying a procgen block paints as its GENERATED channel —
        // hide the raw spine line so the water doesn't double-paint. Opacity 0,
        // NOT a filter: the line
        // must stay rendered so queryRenderedFeatures still hit-tests it for
        // selection — the sketch stays the selectable handle on the output.
        "line-opacity": ["case", ["has", "procgen"], 0, 0.95],
      },
    },
    road: {
      id: "fabric-road",
      type: "line",
      source: "fabric",
      filter: kindFilter("road"),
      layout: { "line-cap": "round", "line-join": "round" },
      // Rural tracks strengthened slightly (shortlist 7) so a smoothed road
      // reads as a track rather than a faint hairline — a touch wider at every
      // zoom, at full opacity.
      paint: {
        "line-color": tokens.fabricRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.4, 16, 5],
        "line-opacity": 1,
      },
    },
    wall: {
      id: "fabric-wall",
      type: "line",
      source: "fabric",
      filter: kindFilter("wall"),
      layout: { "line-cap": "butt", "line-join": "miter" },
      paint: {
        "line-color": tokens.fabricWall,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 16, 3],
        "line-dasharray": [4, 1.5],
        // A wall carrying a procgen block paints as its GENERATED masonry band +
        // towers — the sketch line goes invisible to avoid a
        // dashed line double-painted over the band (same mechanism as the river
        // spine / forest fill). Corridor selection still hits via the line-kind
        // fallback (MapController.regionForSpinePoint).
        "line-opacity": ["case", ["has", "procgen"], 0, 1],
      },
    },
  };
  // Polygon kinds first so line kinds render on top of fills.
  const order: FabricKind[] = [
    ...FABRIC_KINDS.filter(isPolygonKind),
    ...FABRIC_KINDS.filter((k) => !isPolygonKind(k)),
  ];
  return order.map((k) => layers[k] as unknown as LayerSpecification);
}

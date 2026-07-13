import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { FABRIC_KINDS, isPolygonKind, type FabricKind } from "../../model/fabric";

/**
 * Sketched-fabric layers (plan 013) — one line/fill layer per fabric kind on
 * the `fabric` geojson source, themed via tokens like connections/session-path
 * so sketches read consistently across every map style.
 *
 * NO zoom-based LOD here: fabric renders at EVERY zoom (Jonah's decision after
 * the Kanto test — "LOD should only impact visibility of location names", so a
 * drawn road/wall/river/park/water/district is always visible, never gated by a
 * per-kind `minzoom`). Only the source's `tolerance` still applies — that's
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
  // error; the 006-class failure). Fabric has no zoom gating at all now, so
  // there's nothing zoom-related to express here anyway.
  return ["==", ["get", "kind"], kind];
}

export function fabricLayers(tokens: ThemeTokens): LayerSpecification[] {
  const layers: Record<FabricKind, unknown> = {
    // Polygons (drawn first, under the line kinds)
    // Per-kind colors are the dedicated fabric tokens (plan 017): each of the
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
      // Inert sketched forest (plan 022 §3.2, open question §5.2 — Jonah
      // 2026-07-13 decision): a FAINT canopy-green wash so an un-generated
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
    // Lines
    river: {
      id: "fabric-river",
      type: "line",
      source: "fabric",
      filter: kindFilter("river"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": tokens.fabricRiver,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 5],
        // A river carrying a procgen block paints as its GENERATED channel
        // (plan 022 §3.1) — hide the raw spine line so the water doesn't
        // double-paint (Jonah 2026-07-13). Opacity 0, NOT a filter: the line
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
      paint: {
        "line-color": tokens.fabricRoad,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 4],
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

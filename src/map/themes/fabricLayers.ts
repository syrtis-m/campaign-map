import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { FABRIC_KINDS, defaultMinZoomFor, isPolygonKind, type FabricKind } from "../../model/fabric";

/**
 * Sketched-fabric layers (plan 013) — one line/fill layer per fabric kind on
 * the `fabric` geojson source, themed via tokens like connections/session-path
 * so sketches read consistently across every map style.
 *
 * LOD discipline is NON-NEGOTIABLE here (the plan's load-bearing constraint):
 * every layer carries a per-kind `minzoom` (so a road web drawn at z14 simply
 * drops out at z7 instead of tangling), plus a zoom filter honoring an
 * optional per-feature `minZoom` override (which can only *raise* visibility
 * past the kind default — the layer `minzoom` is the floor). Geometry
 * simplification comes from the source's `tolerance` (see FABRIC_SOURCE_SPEC).
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
  return [
    "all",
    ["==", ["get", "kind"], kind],
    [">=", ["zoom"], ["coalesce", ["get", "minZoom"], defaultMinZoomFor(kind)]],
  ];
}

export function fabricLayers(tokens: ThemeTokens): LayerSpecification[] {
  const layers: Record<FabricKind, unknown> = {
    // Polygons (drawn first, under the line kinds)
    water: {
      id: "fabric-water",
      type: "fill",
      source: "fabric",
      minzoom: defaultMinZoomFor("water"),
      filter: kindFilter("water"),
      paint: {
        "fill-color": tokens.water,
        "fill-opacity": 0.85,
        "fill-outline-color": tokens.water,
      },
    },
    district: {
      id: "fabric-district",
      type: "fill",
      source: "fabric",
      minzoom: defaultMinZoomFor("district"),
      filter: kindFilter("district"),
      paint: {
        "fill-color": tokens.poi,
        "fill-opacity": 0.15,
        "fill-outline-color": tokens.poi,
      },
    },
    park: {
      id: "fabric-park",
      type: "fill",
      source: "fabric",
      minzoom: defaultMinZoomFor("park"),
      filter: kindFilter("park"),
      // No dedicated green token (≤8 semantic colors per theme, quality-bar
      // F6) — roadMinor at low opacity reads as a soft open-space wash in
      // every theme without inventing a new hue.
      paint: {
        "fill-color": tokens.roadMinor,
        "fill-opacity": 0.35,
        "fill-outline-color": tokens.labelMinor,
      },
    },
    // Lines
    river: {
      id: "fabric-river",
      type: "line",
      source: "fabric",
      minzoom: defaultMinZoomFor("river"),
      filter: kindFilter("river"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": tokens.water,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 14, 5],
        "line-opacity": 0.95,
      },
    },
    road: {
      id: "fabric-road",
      type: "line",
      source: "fabric",
      minzoom: defaultMinZoomFor("road"),
      filter: kindFilter("road"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": tokens.roadMajor,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 4],
      },
    },
    wall: {
      id: "fabric-wall",
      type: "line",
      source: "fabric",
      minzoom: defaultMinZoomFor("wall"),
      filter: kindFilter("wall"),
      layout: { "line-cap": "butt", "line-join": "miter" },
      paint: {
        "line-color": tokens.labelMinor,
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

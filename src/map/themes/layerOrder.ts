import type { LayerSpecification } from "maplibre-gl";

/**
 * Z-order invariant (plan 019, Phase 4): Locations always render ABOVE
 * things-on-the-map. This is the two-layer model made structural — a theme
 * edit that sinks pins under fabric must fail loudly (unit test + runtime
 * assert in both style builders), not ship as a happenstance of array order.
 *
 * background < basemap < generated fabric < sketched fabric < connections
 * < session-path < location dots < location labels
 *
 * (Generated below sketched: the GM's hand beats the generator's where they
 * overlap. Connections/session-path are location-derived, so they ride above
 * all fabric but below the dots/labels they connect.)
 */
export const LAYER_GROUP_ORDER = [
  "background",
  "basemap",
  "generated",
  "fabric",
  "connections",
  "session-path",
  "location-point",
  "location-label",
] as const;
export type LayerGroup = (typeof LAYER_GROUP_ORDER)[number];

/** Classifies a layer id into its z-order group. Throws on ids no group
 * claims, so a new layer family must declare where it sits. */
export function layerGroupOf(id: string): LayerGroup {
  if (id === "background") return "background";
  if (id.startsWith("basemap-")) return "basemap";
  if (id.startsWith("generated-")) return "generated";
  if (id.startsWith("fabric-")) return "fabric";
  if (id.startsWith("connection")) return "connections";
  if (id.startsWith("session-path")) return "session-path";
  if (id === "canon-point") return "location-point";
  if (id.startsWith("canon-label")) return "location-label";
  throw new Error(`layerOrder: layer "${id}" belongs to no known z-order group — add it to layerGroupOf`);
}

/**
 * Asserts the emitted layer array respects LAYER_GROUP_ORDER. Called by both
 * style builders on every build (cheap — a handful of string checks), and by
 * the theme unit tests across all themes.
 */
export function assertLayerOrder(layers: Pick<LayerSpecification, "id">[]): void {
  let highest = 0;
  for (const layer of layers) {
    const group = layerGroupOf(layer.id);
    const rank = LAYER_GROUP_ORDER.indexOf(group);
    if (rank < highest) {
      throw new Error(
        `layerOrder violated: "${layer.id}" (${group}) renders above ${LAYER_GROUP_ORDER[highest]} layers — locations must stay on top of fabric (plan 019)`
      );
    }
    highest = Math.max(highest, rank);
  }
}

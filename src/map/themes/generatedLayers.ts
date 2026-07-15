import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { worldRegionLayers, worldRouteLayers } from "./generated/world";
import { mountainLayers } from "./generated/mountain";
import { farmLayers } from "./generated/farm";
import { cityLayers, cityStreetLayers } from "./generated/city";
import { riverLayers } from "./generated/river";
import { forestLayers } from "./generated/forest";
import { parkLayers } from "./generated/park";
import { wallLayers } from "./generated/wall";

/**
 * Generated fabric, painted with the SAME per-kind fabric tokens as sketched
 * fabric — quality-bar F2: a generated road and a sketched road differ in
 * provenance, not legend. The two sources/modules stay separate (generated
 * output is regenerable cache; sketches are durable), but the eye reads one
 * class of thing per kind.
 *
 * No settlement point/label layers: named places are Locations — the
 * world-settlement generator is unwired from generate-here, so nothing emits
 * point features into this source.
 *
 * The per-kind layer builders live in `./generated/{world,mountain,farm,city,
 * river,forest,park,wall}.ts`. This function is the sole composer: it
 * concatenates the fragments in EXACTLY the emitted
 * order. That order is deliberately interleaved — world-region opens the stack
 * and world-route paints near the end; the city block sits mid-stack and city
 * streets paint last — so the world/city builders each contribute two
 * fragments in their original positions. Do NOT regroup into contiguous
 * per-kind blocks: that reorders route/street and breaks the style byte-for-
 * byte (see layerOrder.ts for the group-level z-order contract, and the
 * per-block order tests in generatedLayers.test.ts).
 */
export function generatedLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    ...worldRegionLayers(t),
    ...mountainLayers(t),
    ...farmLayers(t),
    ...cityLayers(t),
    ...riverLayers(t),
    ...forestLayers(t),
    ...parkLayers(t),
    ...wallLayers(t),
    ...worldRouteLayers(t),
    ...cityStreetLayers(t),
  ];
}

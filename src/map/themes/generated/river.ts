import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "../tokens";

/**
 * River fabric (procgen v4.5, plan 022 §3.1). Channel water first, islands
 * above. NO zoom LOD (Jonah 2026-07-12).
 */
export function riverLayers(t: ThemeTokens): LayerSpecification[] {
  return [
    {
      // Procgen v4.5 river (plan 022 §3.1): the generated channel is water —
      // same hue as a sketched river/water (F2: one legend per kind). Islands
      // paint AFTER (below in this array = under? no: later = on top), so the
      // island layer follows this one. NO zoom LOD (Jonah 2026-07-12).
      id: "generated-river-channel",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-channel"],
      paint: { "fill-color": t.fabricRiver, "fill-opacity": 0.85 },
    } as unknown as LayerSpecification,
    {
      // River islands: dry land inside a braided reach — land hue, painted
      // ABOVE the channel water (later in the array) so the island reads as a
      // hole of ground in the water.
      id: "generated-river-island",
      type: "fill",
      source: "generated",
      filter: ["==", ["get", "generatorId"], "river-island"],
      paint: { "fill-color": t.land, "fill-opacity": 0.95 },
    } as unknown as LayerSpecification,
  ];
}

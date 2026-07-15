import type { LayerSpecification } from "maplibre-gl";
import type { ThemeTokens } from "./tokens";
import { buildGeneratedLayers } from "./generatedBuilder";

/**
 * Generated fabric, painted with the SAME per-kind fabric tokens as sketched
 * fabric — quality-bar F2: a generated road and a sketched road differ in
 * provenance, not legend. No settlement point/label layers: named places are
 * Locations.
 *
 * The stack is assembled by the one contract-driven builder
 * (`generatedBuilder.ts`): each emitted generator-id binds to a semantic paint
 * role in `src/gen/procgen/styleContract.ts`, and the builder resolves roles to
 * per-theme colors and orders the layers by the contract's `z` slots. See
 * `layerOrder.ts` for the group-level z-order contract.
 */
export function generatedLayers(t: ThemeTokens): LayerSpecification[] {
  return buildGeneratedLayers(t);
}

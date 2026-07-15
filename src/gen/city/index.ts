/**
 * Legacy city-tier barrel — pruned to the survivors of the citynet rewrite.
 *
 * The per-tile city generators (the streamline street "fur", the Voronoi
 * districts, the bisection blocks) are replaced wholesale by the domain-scoped
 * pipeline in `src/gen/citynet/` (skeleton → growth → faces → parcels →
 * outskirts/walls).
 *
 * What survives here, and why:
 *  - `corridor.ts` — sketch-corridor elaboration is still a live host feature,
 *    and `chaikinSmooth` is shared smoothing for citynet.
 *  - `tensorField.ts` — survives as the citynet growth orientation prior.
 *  - `streamlines.ts` — corridor elaboration still traces streamlines.
 */
export {
  generateCorridorStreets,
  chaikinSmooth,
  CORRIDOR_HALO,
  CORRIDOR_INFLUENCE,
} from "./corridor";

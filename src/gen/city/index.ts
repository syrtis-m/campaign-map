/**
 * Legacy city-tier barrel — pruned to the §5.5 survivors (procgen v3.4).
 *
 * The v2 per-tile city generators are DELETED: the streamline street "fur"
 * (`generateCityStreets`), the Voronoi districts (`districts.ts`), and the
 * bisection blocks (`blocks.ts`) are replaced wholesale by the domain-scoped
 * pipeline in `src/gen/citynet/` (skeleton → growth → faces → parcels →
 * outskirts/walls).
 *
 * What survives here, and why (§5.5):
 *  - `corridor.ts` — sketch-corridor elaboration is still a live host feature
 *    (plan 014), and `chaikinSmooth` is shared smoothing for citynet.
 *  - `tensorField.ts` — survives as the citynet growth orientation prior.
 *  - `streamlines.ts` — corridor elaboration still traces streamlines.
 */
export {
  generateCorridorStreets,
  chaikinSmooth,
  CORRIDOR_HALO,
  CORRIDOR_INFLUENCE,
} from "./corridor";

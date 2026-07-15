/**
 * Concentric-ring operators (canal-rings, radial-star, and the euro-medieval
 * growth-rings upgrade).
 *
 * A family of deterministic post-/pre-growth passes that lay CONCENTRIC rings
 * around the generation center — the first-class "concentric grid" pattern the
 * Salat research names as distinct from both grid and organic (Amsterdam canal
 * rings, Paris Étoile, the Scotland typology arcs).
 *
 * Two consumers, one geometry primitive (`concentricRingRuns`):
 *  • `driveRingRoads` (radial-star, growth-ring) — splices the rings into the
 *    grown planar graph as `ring`-class GROWN edges (reusing `insertPolyline`,
 *    the same battle-tested planar insertion the axial operator uses), so the
 *    radial arterials + concentric rings box in wedge blocks that faces/parcels
 *    then subdivide. Runs INSIDE `generateCityNetwork` after growth and BEFORE
 *    faces, exactly like `driveBoulevards` (stage order — no reflow pass).
 *  • `concentricCanalRuns` (canal-rings) — returns the ring polylines for the
 *    caller to (a) emit as visible canal WATER features and (b) fold into the
 *    constraint system as `river` lines, so the existing citynet water machinery
 *    (bridges where radials cross, quays along banks, footprints kept out of the
 *    water) drives the canals with ZERO new water plumbing.
 *
 * Determinism (D6): every ring is a fixed many-gon at a radius that is a pure
 * function of `region.maxInteriorDistance` and the ring index — no float ever
 * reaches a seed, no hashed jitter is needed (concentric rings are regular by
 * definition). Robustness (anti-Watabou): each ring is region-clipped, so a ring
 * that pokes past a concave rim contributes only its interior arcs; a ring that
 * clips to nothing is dropped by absence, never thrown.
 */
import {
  clipPolylineToRegion,
  type ProcgenRegion,
} from "../region";
import type { StreetGraph } from "./graph";
import { insertPolyline, resamplePolyline, GRAPH_RESAMPLE_M } from "./growth";
import type { ConcentricConfig } from "./profiles";

type Pt = [number, number];

/** Vertices of each concentric ring polygon — enough that the many-gon reads as
 * a smooth arc at the gallery zoom (a coarse polygon would look faceted). */
const RING_SEGMENTS = 64;

/**
 * The region-clipped interior runs of `cfg.count` concentric rings centered on
 * `center`, stepping from `innerFrac` to `outerFrac` of `region.maxInteriorDistance`.
 * Each ring is a closed `RING_SEGMENTS`-gon; `clipPolylineToRegion` keeps only
 * the arcs inside the sketch (a concave region yields several runs per ring).
 * Deterministic and pure — no seed needed (regular rings), so both consumers
 * (roads + canals) build identical geometry.
 */
export function concentricRingRuns(region: ProcgenRegion, center: Pt, cfg: ConcentricConfig): Pt[][] {
  const [cx, cy] = center;
  const rMax = region.maxInteriorDistance;
  const runs: Pt[][] = [];
  const n = Math.max(1, cfg.count);
  for (let k = 0; k < n; k++) {
    // Even radial spacing from inner to outer fraction (single ring ⇒ inner).
    const frac = n === 1 ? cfg.innerFrac : cfg.innerFrac + (cfg.outerFrac - cfg.innerFrac) * (k / (n - 1));
    const radius = frac * rMax;
    if (radius <= 0) continue;
    const ring: Pt[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * 2 * Math.PI;
      ring.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    for (const run of clipPolylineToRegion(region, ring)) {
      if (run.length >= 2) runs.push(run);
    }
  }
  return runs;
}

/**
 * Splice concentric ring ROADS into the grown graph (radial-star; the
 * euro-medieval growth-ring uses `count: 1` for one older inner ring).
 * Each clipped ring run is resampled and inserted planar as a `ring`-class grown
 * edge — every crossing with the radial arterials becomes a node, so face
 * extraction boxes the wedge blocks. Mutates `graph`. Returns the spliced runs.
 */
export function driveRingRoads(
  graph: StreetGraph,
  region: ProcgenRegion,
  center: Pt,
  cfg: ConcentricConfig
): Pt[][] {
  const runs = concentricRingRuns(region, center, cfg);
  for (const run of runs) {
    const resampled = resamplePolyline(run, GRAPH_RESAMPLE_M);
    if (resampled.length < 2) continue;
    insertPolyline(graph, resampled, { roadClass: "ring", grown: true, sketch: false });
  }
  return runs;
}

/**
 * The concentric canal ring runs (canal-rings) — the caller emits these as
 * visible canal WATER features AND folds them into the constraints as `river`
 * lines so the shared water machinery (bridges/quays/footprint-drop) drives
 * them. Kept as a thin alias of `concentricRingRuns` so the canal path and the
 * road path build bit-identical ring geometry.
 */
export function concentricCanalRuns(region: ProcgenRegion, center: Pt, cfg: ConcentricConfig): Pt[][] {
  return concentricRingRuns(region, center, cfg);
}

/**
 * Axial-breakthrough operator, shared by the haussmann and baroque-axial
 * presets.
 *
 * A deterministic POST-GROWTH pass that cuts wide boulevards THROUGH the
 * already-grown organic fabric. `driveBoulevards` runs INSIDE
 * `generateCityNetwork`, after the Stage-B growth loop and BEFORE Stage-C faces/
 * parcels, so the stage order is fixed: the boulevards are spliced into
 * the planar street graph as `boulevard`-class GROWN edges, and every
 * downstream stage (block faces, parcels, footprints) then computes ONCE against
 * the final graph — no reflow pass.
 *
 * What the breakthrough PRESERVES vs DEMOLISHES (the palimpsest):
 *  • PRESERVES — the organic fabric BETWEEN the cuts is untouched. The splice
 *    only ADDS boulevard edges and NODES the existing edges it crosses (a
 *    crossed street gains a vertex at the crossing; its geometry is otherwise
 *    identical). The skeleton features (arterials, ring, plaza, landmarks,
 *    gates) are emitted from the skeleton, not the graph, so they are wholly
 *    unaffected. Every grown-street vertex from the no-boulevard run survives.
 *  • DEMOLISHES / RE-CLOSES — the blocks the boulevard passes through are
 *    re-derived by face extraction: the cut splits each crossed face into
 *    faces bounded by the boulevard, and their parcels re-split fronting it
 *    (front realignment falls out of the standard frontage pass on the new
 *    faces — no special-casing).
 *
 * Two compositions:
 *  • `"breakthrough"` (Haussmann) — `count` chords between boundary points at
 *    interleaved bearings; the chords cross at interior STAR plazas, and a
 *    slight perpendicular elbow gives the "convex effect".
 *  • `"trident"` (Baroque) — `count` DEAD-STRAIGHT corsi fanning from ONE apex
 *    (a gate piazza: a rim point in a chosen gate's bearing) toward monumental
 *    endpoints on the far rim (the "points of view").
 *
 * Determinism (D6): every endpoint derives only from the region geometry, the
 * skeleton center/gates, and `citySeed` — no float ever reaches a seed, bearings
 * come from hashed integers. Robust / anti-Watabou: a boulevard whose endpoints
 * cannot be resolved (a ray that misses a concave rim) or that clips to nothing
 * is SKIPPED — counted by absence, never thrown. A profile with no `axial`
 * config is a no-op returning `[]`.
 */
import { hashSeed, mulberry32 } from "../rng";
import { boundaryPointFrom, clipPolylineToRegion, type ProcgenRegion } from "../region";
import type { CityProfile } from "./profiles";
import type { SkeletonOutput } from "./skeleton";
import type { StreetGraph } from "./graph";
import { insertPolyline, resamplePolyline, GRAPH_RESAMPLE_M } from "./growth";

type Pt = [number, number];

export interface AxialBoulevard {
  /** The spliced centerline in world meters (region-clipped, resampled). */
  coords: Pt[];
}

/** Half the fan angle of a Baroque trident (radians): each corso is offset up
 * to this off the central axis. ~26° gives a legible three-prong fan. */
const TRIDENT_FAN_HALF = (26 * Math.PI) / 180;
/** How far around the circle a Haussmann breakthrough chord subtends — a long
 * chord (~112°) whose crossings with its siblings fall well OFF the center, so
 * the boulevards make several interior star plazas rather than one central hub. */
const BREAKTHROUGH_SPAN = 0.62 * Math.PI;

/** Splice the profile's axial boulevards into the grown graph (mutates
 * `graph`). Returns the spliced centerlines for tests / future corridor use. */
export function driveBoulevards(
  citySeed: number,
  graph: StreetGraph,
  region: ProcgenRegion,
  profile: CityProfile,
  skel: SkeletonOutput
): AxialBoulevard[] {
  const cfg = profile.axial;
  if (!cfg || cfg.count < 1) return [];

  const centerlines =
    cfg.mode === "trident"
      ? tridentCenterlines(citySeed, region, skel, cfg.count)
      : breakthroughCenterlines(citySeed, region, skel.center, cfg.count, cfg.elbow);

  const spliced: AxialBoulevard[] = [];
  for (const line of centerlines) {
    // Clip to the region so nothing spills past the sketched outline (a chord
    // or an elbow can graze a concave rim); insert each interior run planar.
    for (const run of clipPolylineToRegion(region, line)) {
      const resampled = resamplePolyline(run, GRAPH_RESAMPLE_M);
      if (resampled.length < 2) continue;
      insertPolyline(graph, resampled, { roadClass: "boulevard", grown: true, sketch: false });
      spliced.push({ coords: resampled });
    }
  }
  return spliced;
}

/** Haussmann breakthrough: `count` chords at evenly spaced, hashed-offset
 * bearings, each subtending `BREAKTHROUGH_SPAN` so siblings cross off-center. */
function breakthroughCenterlines(
  citySeed: number,
  region: ProcgenRegion,
  center: Pt,
  count: number,
  elbow: number
): Pt[][] {
  const [cx, cy] = center;
  // Hashed base bearing interleaves the boulevards between the arterials.
  const base = mulberry32(hashSeed(citySeed, "axial-breakthrough"))() * 2 * Math.PI;
  const out: Pt[][] = [];
  for (let k = 0; k < count; k++) {
    const startA = base + (k / count) * 2 * Math.PI;
    const p0 = boundaryPointFrom(region, cx, cy, startA);
    const p1 = boundaryPointFrom(region, cx, cy, startA + BREAKTHROUGH_SPAN);
    if (!p0 || !p1) continue; // ray missed a concave rim — skip this cut
    out.push(withElbow(citySeed, k, p0, p1, elbow));
  }
  return out;
}

/** Baroque trident: a fan of straight corsi from one rim apex (in a chosen
 * gate's bearing when the profile grew a wall) toward the far rim. */
function tridentCenterlines(
  citySeed: number,
  region: ProcgenRegion,
  skel: SkeletonOutput,
  count: number
): Pt[][] {
  const [cx, cy] = skel.center;
  const gates = skel.wall?.gates ?? [];
  let apexAngle: number;
  if (gates.length > 0) {
    const g = pickGate(gates, citySeed);
    apexAngle = Math.atan2(g[1] - cy, g[0] - cx);
  } else {
    apexAngle = mulberry32(hashSeed(citySeed, "axial-apex"))() * 2 * Math.PI;
  }
  // The piazza: the rim point in the apex bearing (a grand full-length axis).
  const apex = boundaryPointFrom(region, cx, cy, apexAngle);
  if (!apex) return [];
  const out: Pt[][] = [];
  for (let k = 0; k < count; k++) {
    const frac = count === 1 ? 0 : (k / (count - 1)) * 2 - 1; // −1 … +1
    // Fan toward the OPPOSITE rim (apexAngle + π), spread ±TRIDENT_FAN_HALF. The
    // far rim points are cast from the CENTER (an interior origin): a ray cast
    // from the apex itself — which sits ON the boundary — would re-hit its own
    // rim edge at t≈0, so we spread the endpoints on the far rim from inside and
    // draw each straight corso from the shared apex to them.
    const far = boundaryPointFrom(region, cx, cy, apexAngle + Math.PI + frac * TRIDENT_FAN_HALF);
    if (!far) continue;
    out.push([apex, far]); // dead-straight corso (Baroque axes have no elbow)
  }
  return out;
}

/** Position-keyed gate choice: sort gates canonically, pick a hashed index. */
function pickGate(gates: Pt[], citySeed: number): Pt {
  const sorted = [...gates].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const idx = (hashSeed(citySeed, "axial-gate") >>> 0) % sorted.length;
  return sorted[idx];
}

/** A slight one-elbow displacement of the chord midpoint, perpendicular to the
 * chord, up to `elbow`·length (hashed sign) — the Haussmann convex effect.
 * `elbow` ≤ 0 returns the straight chord. */
function withElbow(citySeed: number, k: number, p0: Pt, p1: Pt, elbow: number): Pt[] {
  if (elbow <= 0) return [p0, p1];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return [p0, p1];
  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  const nx = -dy / len; // perpendicular unit
  const ny = dx / len;
  const sign = (hashSeed(citySeed, "axial-elbow", k) >>> 0) & 1 ? 1 : -1;
  const off = elbow * len * sign;
  return [p0, [mx + nx * off, my + ny * off], p1];
}

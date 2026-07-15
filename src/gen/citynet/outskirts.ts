/**
 * Outskirts (Watabou's rule): outside the growth extent but inside the sketched
 * region, buildings ribbon along the arterials only; farther out, farm-field
 * quads aligned to the road; then nothing toward the boundary. The outskirts
 * zone is an arc-length band per arterial, anchored where cityness (interiorT-
 * driven) first drops below the outskirts threshold along that arterial; within
 * it, development bands LATERALLY (Watabou's ribbon): houses hug the road
 * (≤ ~20 m), fields sit beyond them (≥ ~25 m off the road edge), and nothing
 * farther out — footprints only within ~40 m of arterials, fields beyond that.
 * ALL output stays strictly inside the region polygon (nothing spills past the
 * GM's line) — every emitted quad's corners are containment-checked, not just
 * its center.
 *
 * Determinism argument: zones derive from arc-length walks in arterial-part
 * order (part keys are position-derived); every roll comes from
 * `hashSeed(citySeed, salt, arterialIndex, slotIndex, side)` — position/
 * stage-keyed streams, no shared RNG cursor, no dependence on other slots'
 * outcomes (D2/D6). Pure function of its arguments.
 */
import { hashSeed, mulberry32 } from "../rng";
import type { FabricConstraintIndex } from "../fabricConstraints";
import { blockedByWater, insideSketchedFarmland } from "../fabricConstraints";
import { distanceToBoundary, regionContains, type ProcgenRegion } from "../region";
import type { CityProfile } from "./profiles";
import type { CitynessFn } from "./cityness";
import type { SkeletonOutput } from "./skeleton";

type Pt = [number, number];

/** Outskirts begin where cityness falls below profile.edge along the arterial
 * — exactly where the growth loop stopped, so hamlets pick up where the city
 * ends. (Gate-(d) style tests should sample at ≤ 0.72×edge to stay clear of
 * noise-dipped core lots near the boundary.) */
export const OUTSKIRTS_START_FRAC = 1.0;
/** Arc-length slot spacing along the arterial, meters. */
export const RIBBON_SLOT_M = 34;
export const FIELD_SLOT_M = 45;
/** Ribbon house offset range from the arterial centerline, meters. */
export const RIBBON_OFFSET_MIN = 8;
export const RIBBON_OFFSET_MAX = 14;
/** Chance a ribbon slot builds per side (gaps read as hamlets, not stripes). */
export const RIBBON_P = 0.75;
/** Chance a field slot places a field per side. */
export const FIELD_P = 0.6;
/** Field CENTERLINE offset from the arterial (plus half the field depth), so
 * the field's near edge stays clear of the ribbon houses (~20 m envelope). */
export const FIELD_OFFSET_MIN = 45;
export const FIELD_OFFSET_MAX = 75;
export const FIELD_ALONG_MIN = 35;
export const FIELD_ALONG_MAX = 70;
export const FIELD_DEEP_MIN = 25;
export const FIELD_DEEP_MAX = 45;
/** Soft margin: a field's center stays this far inside the region boundary. */
export const FIELD_RIM_MARGIN_M = 10;
/** A field must keep this clearance from every arterial polyline, meters. */
export const FIELD_ROAD_CLEARANCE_M = 10;

export interface OutskirtsOutput {
  /** Small house quads hugging the arterials (closed rings). */
  ribbonFootprints: { ring: Pt[]; key: string }[];
  /** Farm-field quads aligned to the road (closed rings). */
  fields: { ring: Pt[]; key: string }[];
}

interface ArcSample {
  p: Pt;
  tangent: number;
  /** Arc length from the polyline start, meters. */
  s: number;
}

/** Sample a polyline every `spacing` meters of arc length. */
function arcSamples(coords: Pt[], spacing: number): ArcSample[] {
  const out: ArcSample[] = [];
  let nextAt = spacing * 0.5;
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    const seg = Math.hypot(bx - ax, by - ay);
    const tangent = Math.atan2(by - ay, bx - ax);
    while (nextAt <= walked + seg) {
      const t = seg === 0 ? 0 : (nextAt - walked) / seg;
      out.push({ p: [ax + t * (bx - ax), ay + t * (by - ay)], tangent, s: nextAt });
      nextAt += spacing;
    }
    walked += seg;
  }
  return out;
}

/** Arc length at which cityness first drops below `threshold` along the line
 * (sampled every 10 m), or Infinity if it never does. */
function outskirtsStart(coords: Pt[], cityness: CitynessFn, threshold: number): number {
  for (const s of arcSamples(coords, 10)) {
    if (cityness(s.p[0], s.p[1]) < threshold) return s.s;
  }
  return Infinity;
}

/** Axis-aligned-in-frame quad centered at `c`, rotated to `angle`. Closed. */
function quadAt(c: Pt, angle: number, along: number, deep: number): Pt[] {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const corner = (su: number, sv: number): Pt => [
    c[0] + ca * along * 0.5 * su - sa * deep * 0.5 * sv,
    c[1] + sa * along * 0.5 * su + ca * deep * 0.5 * sv,
  ];
  const ring: Pt[] = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  ring.push(ring[0]);
  return ring;
}

/** Min distance from a point to any of the arterial polylines. */
function distToArterials(p: Pt, arterials: Pt[][]): number {
  let best = Infinity;
  for (const line of arterials) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Build outskirt ribbon footprints + fields. Fields never overlap streets
 * (clearance vs every arterial), water (all corners + center dry), or blocks
 * (blocks only exist inside the growth extent; the field band is outside it).
 */
export function buildOutskirts(
  citySeed: number,
  region: ProcgenRegion,
  profile: CityProfile,
  skeleton: SkeletonOutput,
  cityness: CitynessFn,
  waterIdx: FabricConstraintIndex
): OutskirtsOutput {
  const ribbonFootprints: { ring: Pt[]; key: string }[] = [];
  const fields: { ring: Pt[]; key: string }[] = [];
  const threshold = OUTSKIRTS_START_FRAC * profile.edge;
  const arterialLines = skeleton.arterials.map((a) => a.coords);

  /** Every corner (and the center) inside the region — nothing spills past the
   * GM's line, enforced per quad. */
  const quadInside = (center: Pt, ring: Pt[]): boolean => {
    if (!regionContains(region, center[0], center[1])) return false;
    for (let i = 0; i < 4; i++) {
      if (!regionContains(region, ring[i][0], ring[i][1])) return false;
    }
    return true;
  };

  skeleton.arterials.forEach((art, ai) => {
    const start = outskirtsStart(art.coords, cityness, threshold);
    if (!Number.isFinite(start)) return; // arterial never leaves the core

    // Ribbon houses.
    arcSamples(art.coords, RIBBON_SLOT_M).forEach((s, si) => {
      if (s.s < start) return;
      for (const side of [1, -1]) {
        const rng = mulberry32(hashSeed(citySeed, "ribbon", ai, si, side));
        if (rng() >= RIBBON_P) continue;
        const offset = RIBBON_OFFSET_MIN + rng() * (RIBBON_OFFSET_MAX - RIBBON_OFFSET_MIN);
        const nx = -Math.sin(s.tangent) * side;
        const ny = Math.cos(s.tangent) * side;
        const center: Pt = [s.p[0] + nx * offset, s.p[1] + ny * offset];
        if (blockedByWater(waterIdx, center[0], center[1])) continue;
        const along = 6 + rng() * 6; // 6–12 m cottages
        const deep = 5 + rng() * 5;
        const ring = quadAt(center, s.tangent, along, deep);
        if (!quadInside(center, ring)) continue;
        ribbonFootprints.push({ ring, key: `${ai}:${si}:${side}` });
      }
    });

    // Fields — same arc band, laterally beyond the ribbon houses.
    arcSamples(art.coords, FIELD_SLOT_M).forEach((s, si) => {
      if (s.s < start) return;
      for (const side of [1, -1]) {
        const rng = mulberry32(hashSeed(citySeed, "field", ai, si, side));
        if (rng() >= FIELD_P) continue;
        const along = FIELD_ALONG_MIN + rng() * (FIELD_ALONG_MAX - FIELD_ALONG_MIN);
        const deep = FIELD_DEEP_MIN + rng() * (FIELD_DEEP_MAX - FIELD_DEEP_MIN);
        const offset = FIELD_OFFSET_MIN + rng() * (FIELD_OFFSET_MAX - FIELD_OFFSET_MIN) + deep * 0.5;
        const nx = -Math.sin(s.tangent) * side;
        const ny = Math.cos(s.tangent) * side;
        const center: Pt = [s.p[0] + nx * offset, s.p[1] + ny * offset];
        // Soft boundary margin (the disc's rim margin, region form).
        if (distanceToBoundary(region, center[0], center[1]) < FIELD_RIM_MARGIN_M) continue;
        // Double-field resolution: a GM's raw farmland sketch claims this
        // ground — drop the city's own outskirt field inside it so the two
        // don't double-paint. No-op when no farmland is sketched (empty
        // farmlandRings ⇒ false).
        if (insideSketchedFarmland(waterIdx, center[0], center[1])) continue;
        // The lateral offset can land in a noise pocket the growth loop would
        // still build in — no farm fields where cityness says "city".
        if (cityness(center[0], center[1]) >= profile.edge) continue;
        const ring = quadAt(center, s.tangent, along, deep);
        if (!quadInside(center, ring)) continue;
        // No overlap with water or any street (arterials are the only streets
        // out here; blocks/parcels live inside the growth extent).
        let ok = !blockedByWater(waterIdx, center[0], center[1]);
        for (let i = 0; ok && i < 4; i++) {
          ok =
            !blockedByWater(waterIdx, ring[i][0], ring[i][1]) &&
            distToArterials(ring[i], arterialLines) > FIELD_ROAD_CLEARANCE_M;
        }
        if (!ok) continue;
        fields.push({ ring, key: `${ai}:${si}:${side}` });
      }
    });
  });

  return { ribbonFootprints, fields };
}

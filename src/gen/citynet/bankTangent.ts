/**
 * Waterfront street alignment (plan 038.1, city → waterfront): near the
 * GENERATED river channel (`upstream.water`, surfaced as `channelRings`), the
 * street tensor field bends to run PARALLEL to the bank, and buildings hold a
 * setback off the bank while the quays/streets still hug it.
 *
 * The bank tangent is blended into the field with the same mod-π tensor
 * summation the road-alignment sampler uses (`fabricConstraints.fabricAngleSampler`
 * precedent — angles summed as {cos2θ, sin2θ}, never averaged), decaying over
 * `BANK_ALIGN_FALLOFF_M` (~150 m, inside the plan's 100–200 m band). Pure /
 * headless: reads only its arguments and `nearestOnLine` (a pure predicate).
 * `channelRings` empty ⇒ the sampler is returned UNCHANGED and the setback is a
 * no-op, so a city with no upstream channel is byte-identical to the uncoupled
 * generator (the 23-E no-field discipline).
 */
import type { AngleSampler } from "../city/streamlines";
import { nearestOnLine } from "../fabricConstraints";

type Pt = [number, number];

/** Bank-tangent blend decay (m): the alignment weight is
 * `BANK_ALIGN_STRENGTH · exp(−dist / BANK_ALIGN_FALLOFF_M)`. ~150 m sits in the
 * plan's 100–200 m band. */
export const BANK_ALIGN_FALLOFF_M = 150;
/** Peak bank-tangent weight (matches the road blend's ROAD_ALIGN_STRENGTH). */
export const BANK_ALIGN_STRENGTH = 3;
/** Building setback off the channel bank (m): a parcel/footprint whose centroid
 * is DRY but within this distance of the bank is dropped — the strip belongs to
 * the quay. Streets/quays are unaffected (they hug the bank). */
export const BANK_SETBACK_M = 9;

/** Minimum distance from (x,y) to any channel ring polyline, or Infinity when
 * there are no channel rings. Uses `nearestOnLine` per closed ring (the ring's
 * closing segment is included), so it measures distance to the real bank. */
export function distToChannelBank(channelRings: Pt[][], x: number, y: number): number {
  let best = Infinity;
  for (const ring of channelRings) {
    if (ring.length < 2) continue;
    const d = nearestOnLine(ring, x, y).dist;
    if (d < best) best = d;
  }
  return best;
}

/** True iff (x,y) sits within `BANK_SETBACK_M` of a channel bank — the
 * building-exclusion strip along the quay. Strict `false` with no channel
 * rings (byte-inert). */
export function inBankSetback(channelRings: Pt[][], x: number, y: number): boolean {
  if (channelRings.length === 0) return false;
  return distToChannelBank(channelRings, x, y) < BANK_SETBACK_M;
}

/**
 * Wrap an angle sampler so it bends toward the nearest channel bank's tangent
 * within `BANK_ALIGN_FALLOFF_M`. `channelRings` empty ⇒ the base sampler is
 * returned unchanged (referential no-op — no wrapper allocation, so the growth
 * loop's byte output is identical to the uncoupled path).
 */
export function bankAlignedSampler(base: AngleSampler, channelRings: Pt[][]): AngleSampler {
  if (channelRings.length === 0) return base;
  return (x, y) => {
    const baseAngle = base(x, y);
    let a = Math.cos(2 * baseAngle);
    let b = Math.sin(2 * baseAngle);
    for (const ring of channelRings) {
      if (ring.length < 2) continue;
      const near = nearestOnLine(ring, x, y);
      const w = BANK_ALIGN_STRENGTH * Math.exp(-near.dist / BANK_ALIGN_FALLOFF_M);
      a += w * Math.cos(2 * near.angle);
      b += w * Math.sin(2 * near.angle);
    }
    return Math.atan2(b, a) / 2;
  };
}

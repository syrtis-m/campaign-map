/**
 * River metrics — a PURE measurement pass over the features `generateRiver`
 * emits, turning "does the channel meander, how wide is it" from vibes into
 * numbers. It reads features + region only; it never generates and never
 * mutates, so adding it changes ZERO generator bytes.
 *
 * The band (`RIVER_BAND`) is the tunable regression net that replaces byte-
 * eternity for river tuning (versioned-determinism policy): a GENEROUS window
 * measured around the committed golden fixture, wide enough to survive a
 * meander/width retune yet tight enough to catch a gross regression (a channel
 * gone dead-straight, a width collapsed or blown up).
 */
import type { ProcgenRegion } from "./region";
import { byGid, polylineLength, polygonNetArea, inBand } from "./metricsGeom";

type Pt = [number, number];

export interface RiverMetrics {
  /** Channel edge length ÷ straight-line spine span — a meander index. 1.0 is a
   * dead-straight cut; a wandering lowland river runs higher. */
  sinuosity: number;
  /** Mean channel width (m) = total channel-polygon area ÷ spine length. */
  meanChannelWidth: number;

  // ── Raw quantities (debug / band calibration) ──────────────────────────────
  bankLength: number;
  channelArea: number;
  spineLength: number;
  straightSpan: number;
}

export interface RiverBand {
  sinuosity: [number, number];
  meanChannelWidth: [number, number];
}

/** Band measured on the committed golden (windy + braided, seed 4242) and
 * widened to a regression window. Sinuosity ≈ 1.04, mean width ≈ 35.8 m there. */
export const RIVER_BAND: RiverBand = {
  sinuosity: [1.0, 1.7],
  meanChannelWidth: [18, 55],
};

/**
 * Measure a whole (unclipped) river. `region` supplies the spine — a river
 * region is always a corridor, so `region.spine` is defined; a polygon region
 * yields a zeroed spine span (metrics degrade gracefully rather than throw).
 */
export function computeRiverMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): RiverMetrics {
  let bankLength = 0;
  for (const f of byGid(features, "river-bank")) {
    if (f.geometry.type === "LineString") bankLength += polylineLength(f.geometry.coordinates as Pt[]);
  }
  let channelArea = 0;
  for (const f of byGid(features, "river-channel")) channelArea += polygonNetArea(f);

  const spine = region.spine;
  const spineLength = spine?.totalLen ?? 0;
  const straightSpan = spine
    ? Math.hypot(
        spine.points[spine.points.length - 1][0] - spine.points[0][0],
        spine.points[spine.points.length - 1][1] - spine.points[0][1]
      )
    : 0;

  // Two banks per channel run, so half the total bank length ≈ one channel
  // edge; dividing by the straight span gives the meander index.
  const sinuosity = straightSpan > 0 ? bankLength / 2 / straightSpan : 0;
  const meanChannelWidth = spineLength > 0 ? channelArea / spineLength : 0;

  return { sinuosity, meanChannelWidth, bankLength, channelArea, spineLength, straightSpan };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function riverBandViolations(m: RiverMetrics, band: RiverBand = RIVER_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(3)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("sinuosity", m.sinuosity, band.sinuosity);
  chk("meanChannelWidth", m.meanChannelWidth, band.meanChannelWidth);
  return out;
}

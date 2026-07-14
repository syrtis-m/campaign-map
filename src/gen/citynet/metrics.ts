/**
 * City-network metrics (plan 025 §3.1): a PURE measurement pass over the
 * feature set `generateCityNetwork` emits, turning a chunk of the docs/04
 * "screenshot test" from vibes into numbers. It reads features only — it never
 * generates, never mutates, and imposes NO determinism obligations of its own
 * beyond being a deterministic function of its inputs (D6). Because it is pure
 * measurement, adding it changes ZERO generator bytes: goldens are untouched.
 *
 * The numbers are calibrated against Serge Salat's figure-ground studies
 * (§1.2): intersection density (Venice 688 · Manhattan ~112–192 · Chongqing
 * superblocks ~49–66 /km²), street linear density (≥18 km/km² guideline floor;
 * Amsterdam 30.7, Manhattan 22.7), and street land share (25–30 %).
 *
 * SCOPE (phase 025-A): street WIDTH is not yet an emitted property — it lands
 * with the §3.3 form-based width system in a later phase. Until then the
 * width-derived metrics (`streetLandShare`, `widthHistogram`) use a
 * class→width table (`WIDTH_BY_CLASS`) as a documented approximation; when 3.3
 * emits a real `width`, this module reads it and the approximation retires
 * (see `widthOf`). Every other metric is exact today.
 */
import type { ProcgenRegion } from "../region";

export interface WidthHistogram {
  /** Fraction of total street LENGTH on streets narrower than 10 m. */
  lt10: number;
  /** Fraction on streets 10–20 m. */
  m10to20: number;
  /** Fraction on streets wider than 20 m. */
  gt20: number;
}

export interface NetworkMetrics {
  /** Junctions (graph nodes of degree ≥ 3) per km² — the headline Salat figure. */
  intersectionsPerKm2: number;
  /** Total street centre-line length per km² (Salat's ≥18 km/km² floor). */
  streetKmPerKm2: number;
  /** Street surface area ÷ region area, 0–1 (Salat's 25–30 % land share). */
  streetLandShare: number;
  /** Street length split into narrow/medium/wide bands (fractions, sum ≈ 1). */
  widthHistogram: WidthHistogram;
  /** Median block "grain" in metres = √(median block area) — Salat's urban
   * grain (Tokyo 50 · European centres ~120). 0 when there are no blocks. */
  blockGrainP50: number;
  /** Fraction of street length carried by through-classes (arterial/ring/
   * boulevard) — the avenue↔street hierarchy that gives a grid legibility. */
  avenueShare: number;
  /** Fraction of nodes that are dead-ends (degree 1) — the cul-de-sac
   * signature; high for na-suburb, low for gridded fabric. */
  deadEndShare: number;
  /** Link/node ratio (chains ÷ distinct nodes) — connectivity/permeability.
   * ~1.0–1.2 tree-like, ~1.4+ well-connected grid. */
  permeability: number;

  // ── Raw counts (for the gallery table + debug API) ─────────────────────
  intersectionCount: number;
  deadEndCount: number;
  nodeCount: number;
  linkCount: number;
  streetKm: number;
  blockCount: number;
  areaKm2: number;
}

/** A benchmark band for one preset: closed ranges every metric must fall in
 * (per plan 025 §3.1), plus the Salat §1.2 figure-ground `anchor` the preset is
 * calibrated toward. Ranges are deliberately GENEROUS windows, not exact
 * values: the output is deterministic per pinned seed, so a range that current
 * output satisfies both documents intent and tolerates future minor tuning
 * while still catching a real regression (a halved intersection density, a
 * blown-up land share). Per §5 OQ#1: these distribution bands WARN in the live
 * gallery gate (they encode taste — Jonah calibrates from review/gallery) and
 * are asserted in the unit suite where they are the numeric contract. */
export interface PresetBenchmark {
  intersectionsPerKm2: [number, number];
  streetKmPerKm2: [number, number];
  streetLandShare: [number, number];
  blockGrainP50: [number, number];
  permeability: [number, number];
  anchor: string;
}

/**
 * Benchmark bands for the four EXISTING presets (plan 025-A). Derived by
 * MEASURING the deterministic output on the gallery ring (regular 16-gon,
 * effective radius 700 m, pinned seed) and widening to research-anchored
 * windows. Cross-preset ORDERINGS (na-grid coarsest grain + most permeable +
 * sparsest; euro-medieval finer + denser than na-grid; na-suburb the most
 * dead-ends) are asserted separately in the suite — they are the strongest,
 * most research-faithful signals. New presets add their band here as they land.
 *
 * PHASE-A CAVEAT: our generator emits denser street fabric than the historic
 * cities Salat measured, so `streetLandShare` runs a little above his 25–30 %
 * guideline (the class-derived width table, §3.3 pending, also inflates it).
 * The bands accept that; the §3.3 width system + §3.4 permeability floor bring
 * it toward the guideline in later phases.
 */
export const PRESET_BENCHMARKS: Record<string, PresetBenchmark> = {
  "euro-medieval": {
    intersectionsPerKm2: [180, 520],
    streetKmPerKm2: [20, 38],
    streetLandShare: [0.25, 0.45],
    blockGrainP50: [30, 90],
    permeability: [1.2, 1.6],
    anchor: "Venice 688 · Florence 255 — organic warren, finest grain",
  },
  "euro-continental": {
    intersectionsPerKm2: [100, 260],
    streetKmPerKm2: [14, 28],
    streetLandShare: [0.18, 0.36],
    blockGrainP50: [40, 95],
    permeability: [1.2, 1.55],
    anchor: "Amsterdam core 314 · Paris Louvre 242 — regular blocks",
  },
  "na-grid": {
    intersectionsPerKm2: [80, 200],
    streetKmPerKm2: [12, 24],
    streetLandShare: [0.15, 0.3],
    blockGrainP50: [50, 110],
    permeability: [1.3, 1.65],
    anchor: "Manhattan Midtown ~112 — coarse grid, most permeable",
  },
  "na-suburb": {
    intersectionsPerKm2: [260, 560],
    streetKmPerKm2: [22, 42],
    streetLandShare: [0.28, 0.5],
    blockGrainP50: [30, 70],
    permeability: [1.2, 1.55],
    anchor: "Washington suburbs ~36 (ours denser) — cul-de-sac dead-ends",
  },
};

/** True when `value` lies within the closed band. */
export function inBand(value: number, [lo, hi]: [number, number]): boolean {
  return value >= lo && value <= hi;
}

/** Every metric of `m` that falls OUTSIDE its band for `presetId` (empty ⇒ all
 * pass). Used by both the unit suite (asserts empty) and the gallery gate
 * (warns + screenshots). */
export function benchmarkViolations(presetId: string, m: NetworkMetrics): string[] {
  const b = PRESET_BENCHMARKS[presetId];
  if (!b) return [`no benchmark for preset ${presetId}`];
  const out: string[] = [];
  const chk = (name: string, v: number, band: [number, number]): void => {
    if (!inBand(v, band)) out.push(`${name} ${v.toFixed(2)} ∉ [${band[0]}, ${band[1]}]`);
  };
  chk("intersectionsPerKm2", m.intersectionsPerKm2, b.intersectionsPerKm2);
  chk("streetKmPerKm2", m.streetKmPerKm2, b.streetKmPerKm2);
  chk("streetLandShare", m.streetLandShare, b.streetLandShare);
  chk("blockGrainP50", m.blockGrainP50, b.blockGrainP50);
  chk("permeability", m.permeability, b.permeability);
  return out;
}

/**
 * Class→width table (metres), the §3.3 stand-in until streets carry a real
 * `width`. Values follow §1.2's form hierarchy: alleys narrow, ordinary
 * streets ~10–18 m facade-to-facade, arterials/rings wider, boulevards widest.
 * Kept intentionally coarse — the honest precise histogram arrives with 3.3.
 */
export const WIDTH_BY_CLASS: Record<string, number> = {
  alley: 5,
  street: 12,
  ring: 16,
  arterial: 18,
  boulevard: 30,
};
const DEFAULT_WIDTH = 12;

/** A feature's street width: the emitted `width` once §3.3 lands, else the
 * class-derived approximation. */
function widthOf(props: Record<string, unknown>): number {
  const w = props.width;
  if (typeof w === "number" && w > 0) return w;
  const cls = String(props.roadClass ?? "street");
  return WIDTH_BY_CLASS[cls] ?? DEFAULT_WIDTH;
}

/** mm-quantized coordinate key (the emit lattice is already mm; this just makes
 * a stable string key for node coincidence). */
function nodeKey(x: number, y: number): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

function polylineLength(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return len;
}

/** Shoelace area of a closed ring (first == last is fine). */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) / 2;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const AVENUE_CLASSES = new Set(["arterial", "ring", "boulevard"]);

/**
 * Measure a whole (unclipped) region network. Pass the SAME `features`
 * `generateCityNetwork` returned and the region they were generated for; the
 * region supplies the denominator area. Every metric is a pure function of
 * these two inputs.
 *
 * Node model: streets are emitted as chains already split at junctions, so a
 * junction is where ≥2 chain ENDPOINTS coincide. Degree = number of coincident
 * chain-ends. Intersections are degree ≥ 3, dead-ends degree 1. Interior chain
 * vertices are not nodes (a chain that merely bends is one link).
 */
export function computeNetworkMetrics(
  features: GeoJSON.Feature[],
  region: ProcgenRegion
): NetworkMetrics {
  const areaKm2 = region.area / 1e6;

  // ── Streets: length, width-weighted area, avenue split, node degrees ────
  const degree = new Map<string, number>();
  let streetLenM = 0;
  let avenueLenM = 0;
  let widthAreaM2 = 0;
  const bandLen = { lt10: 0, m10to20: 0, gt20: 0 };
  let linkCount = 0;

  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    if (props.generatorId !== "city-street") continue;
    if (f.geometry.type !== "LineString") continue;
    const coords = f.geometry.coordinates as [number, number][];
    if (coords.length < 2) continue;

    const len = polylineLength(coords);
    if (len <= 0) continue;
    streetLenM += len;
    linkCount += 1;

    const cls = String(props.roadClass ?? "street");
    if (AVENUE_CLASSES.has(cls)) avenueLenM += len;

    const w = widthOf(props);
    widthAreaM2 += len * w;
    if (w < 10) bandLen.lt10 += len;
    else if (w <= 20) bandLen.m10to20 += len;
    else bandLen.gt20 += len;

    const a = coords[0];
    const b = coords[coords.length - 1];
    const ka = nodeKey(a[0], a[1]);
    const kb = nodeKey(b[0], b[1]);
    degree.set(ka, (degree.get(ka) ?? 0) + 1);
    // A closed loop (both ends the same node) contributes degree 2 at one node.
    degree.set(kb, (degree.get(kb) ?? 0) + 1);
  }

  let intersectionCount = 0;
  let deadEndCount = 0;
  for (const d of degree.values()) {
    if (d >= 3) intersectionCount += 1;
    else if (d === 1) deadEndCount += 1;
  }
  const nodeCount = degree.size;

  // ── Blocks: grain ───────────────────────────────────────────────────────
  const grains: number[] = [];
  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    if (props.generatorId !== "city-block") continue;
    if (f.geometry.type !== "Polygon") continue;
    const ring = f.geometry.coordinates[0] as [number, number][];
    const area = ringArea(ring);
    if (area > 0) grains.push(Math.sqrt(area));
  }
  grains.sort((p, q) => p - q);

  const streetKm = streetLenM / 1000;
  const totalBand = bandLen.lt10 + bandLen.m10to20 + bandLen.gt20;
  const widthHistogram: WidthHistogram =
    totalBand > 0
      ? { lt10: bandLen.lt10 / totalBand, m10to20: bandLen.m10to20 / totalBand, gt20: bandLen.gt20 / totalBand }
      : { lt10: 0, m10to20: 0, gt20: 0 };

  return {
    intersectionsPerKm2: areaKm2 > 0 ? intersectionCount / areaKm2 : 0,
    streetKmPerKm2: areaKm2 > 0 ? streetKm / areaKm2 : 0,
    streetLandShare: region.area > 0 ? widthAreaM2 / region.area : 0,
    widthHistogram,
    blockGrainP50: median(grains),
    avenueShare: streetLenM > 0 ? avenueLenM / streetLenM : 0,
    deadEndShare: nodeCount > 0 ? deadEndCount / nodeCount : 0,
    permeability: nodeCount > 0 ? linkCount / nodeCount : 0,
    intersectionCount,
    deadEndCount,
    nodeCount,
    linkCount,
    streetKm,
    blockCount: grains.length,
    areaKm2,
  };
}

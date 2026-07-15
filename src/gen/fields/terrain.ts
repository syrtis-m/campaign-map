/**
 * Global terrain composition (plan 036) — the campaign-wide elevation surface as
 * a single point-evaluable field:
 *
 *   T(x,y) = grade( carve( replace( add( B(x,y) ) ) ) )
 *
 * Every term is a pure function of the DURABLE SKETCH LAYER (seeds / rings /
 * spines / params carried on the fabric features) — no neighbourhood, no global
 * pass, analytic gradients composed by chain rule — the exact legality pattern
 * `elevationFieldFromFabric` established, generalised from "mountains only" to a
 * stack of terrain-modifier stamps.
 *
 *   B       — continental base fBm. DEFAULT AMPLITUDE 0 (flat): `campAmp === 0`
 *             ⇒ B ≡ seaDatum (default 0) with a zero gradient, so a campaign with
 *             no base opt-in and no stamps is EXACTLY flat and every existing
 *             elevation consumer is byte-stable until the GM opts in.
 *   add     — B + the sketched mountains' union (VERBATIM `elevationFieldFromFabric`
 *             — the migration is a call, not a re-derivation, so a mountain-only
 *             campaign is byte-identical to the pre-036 field) + Σ relief-polyline
 *             stamps (signed cross-profile ridges/valleys), id-sorted before the
 *             fold (FP addition is not associative).
 *   replace — lerp toward each landform stamp's target (plateau / basin / sea),
 *             folded in (priority, id) order so a later stamp wins where masks
 *             overlap (ratified Q4: id-order last-wins, priority the GM knob).
 *   carve   — river bed smooth-min (plan 036-B; identity here until a river carve
 *             is present).
 *   grade   — city-site flattening (plan 036-D; DEFAULT OFF).
 *
 * `terrainAt` ALWAYS returns a field (never null, unlike `elevationFieldFromFabric`)
 * — the base is defined everywhere. Consumers that need the old "null ⇒ skip
 * coupling" shortcut check `hasTerrainRelief` first.
 */
import { fbmEroded, type HeightSample, type ElevationField } from "./elevation";
import { elevationFieldFromFabric } from "./mountainField";
import { pointInRingClosed } from "./sdf";
import { SegmentHash } from "../segmentHash";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

// ─── Base surface ────────────────────────────────────────────────────────────

/** Campaign base-terrain params — the one whole-campaign invalidation, so they
 * live behind an explicit Apply (plan 036-D), never a live slider. Defaults keep
 * every existing campaign byte-stable (flat, at datum 0). */
export interface TerrainBaseParams {
  /** Continental relief amplitude, meters. 0 (default) ⇒ dead flat. */
  campAmp: number;
  /** Sea-level datum, meters — the flat base height and the `sea` landform
   * target. 0 by default. */
  seaDatum: number;
}

export const DEFAULT_TERRAIN_BASE: TerrainBaseParams = { campAmp: 0, seaDatum: 0 };

export interface TerrainOptions {
  base?: Partial<TerrainBaseParams>;
  /** Drives the base fBm; only consulted when `campAmp > 0`. */
  campaignSeed?: number;
  /** Select which operator classes compose (all default ON — the full visible
   * surface). A CONSUMER that wants the durable MACRO terrain reads it through
   * `macroTerrainField`, which passes `carve`/`grade` false while KEEPING
   * `relief`/`landform` on (ruling 2026-07-15: the composed global terrain field
   * — base + mountain + relief + landform — IS the terrain system a generator
   * reads; a mountain is just one stamp kind). Only carve/grade stay excluded:
   * carve is a river reading its OWN gorge (circular) and grade reads settlement
   * OUTPUT (output-like) — both self-referential, never a terrain input. */
  include?: { relief?: boolean; landform?: boolean; carve?: boolean; grade?: boolean };
}

/** Coarsest continental base-fBm octave cell (meters) — FIXED absolute-world
 * constant (never region-derived), the seam/edit-locality discipline the mountain
 * field already follows. */
const CONTINENTAL_CELL_M = 4000;
const CONTINENTAL_OCTAVES = 5;

/** The base field B. `campAmp === 0` short-circuits to an exact constant (v =
 * seaDatum, gradient 0) — the byte-stability guarantee: no fBm is evaluated, so
 * there is not even a `0 * noise` signed-zero to reason about. */
function baseField(base: TerrainBaseParams, campaignSeed: number): ElevationField {
  if (base.campAmp === 0) {
    const flat: HeightSample = { v: base.seaDatum, dx: 0, dy: 0 };
    return () => flat;
  }
  const opts = {
    octaves: CONTINENTAL_OCTAVES,
    damping: 0,
    ridged: false,
    baseCell: CONTINENTAL_CELL_M,
    salt: "terrain-base",
  };
  return (x, y): HeightSample => {
    const n = fbmEroded(campaignSeed, x, y, opts);
    return { v: base.seaDatum + base.campAmp * n.v, dx: base.campAmp * n.dx, dy: base.campAmp * n.dy };
  };
}

// ─── Relief polyline stamps (ADD) — signed cross-profile ridge / valley ──────

export const RELIEF_POLARITIES = ["ridge", "valley"] as const;
export type ReliefPolarity = (typeof RELIEF_POLARITIES)[number];

export interface ReliefParams {
  polarity: ReliefPolarity;
  /** Peak height (ridge) or depth (valley) at the spine, meters. */
  height: number;
  /** Cross-profile half-width, meters — the relief's INNER band. Without an
   * apron the profile fades to 0 by this distance from the spine. Also the base
   * corridor bound the host builds for this line kind. */
  halfWidth: number;
  /** Optional FOOTHILL APRON (meters, default 0/absent): a skirt that extends the
   * cross-profile so the relief decays to 0 over `halfWidth + apron` from the
   * spine instead of hitting 0 at `halfWidth`. In 3D a compact-support stamp
   * rises as a vertical-walled mesa off flat ground (make-it-look-real shortlist
   * item 2); a positive apron spreads the toe into foothills so peaks rise out of
   * a skirt rather than a wall. DEFAULT 0 ⇒ `reach === halfWidth` ⇒ the profile,
   * far-field reject, gradient, and support reach are ALL byte-identical to the
   * pre-apron stamp (no version bump — the absent-param-reproduces-old-bytes
   * discipline, 029). */
  apron?: number;
}

export const RELIEF_DEFAULTS: ReliefParams = { polarity: "ridge", height: 200, halfWidth: 150, apron: 0 };

/** A relief stamp's total cross-profile reach from the spine: `halfWidth + apron`
 * (apron default 0). The single source of truth for the compact-support radius —
 * the field is EXACTLY 0 beyond it, so it is simultaneously the corridor
 * half-width, the far-field-reject bound, and the variable-support invalidation
 * reach. */
export function reliefReach(params: ReliefParams): number {
  return Math.max(0, params.halfWidth) + Math.max(0, params.apron ?? 0);
}

/** The corridor half-width a relief stamp needs (host corridor + influence
 * margin): its full cross-profile band, apron included. */
export function reliefMaxOffset(params: ReliefParams): number {
  return reliefReach(params);
}

/**
 * VARIABLE-SUPPORT invalidation reach (ruling 2026-07-15). The support margin
 * (meters) of a durable terrain-STAMP feature: how far BEYOND its own geometry
 * bbox the stamp can still move the composed terrain field a consumer reads —
 * the per-FEATURE reach that replaces a fixed per-consumer margin for the
 * terrain kinds.
 *   - relief   → `params.halfWidth + params.apron` (apron default 0): `reliefField`
 *                is EXACTLY 0 past the spine's cross-profile reach, but a relief's
 *                spine bbox does NOT include that band, so a consumer within the
 *                reach of the spine still reads it. The reach IS `halfWidth + apron`
 *                (a foothill skirt extends the compact support, so the
 *                invalidation reach must extend with it — an apron'd relief past
 *                halfWidth but within the skirt still moves the field).
 *   - landform → 0: `ringMaskField`'s replace mask is nonzero only strictly
 *                INSIDE the ring, so the ring bbox already bounds the support —
 *                a landform disjoint from the region is byte-inert.
 *   - mountain → 0: `elevationFieldFromFabric` is compact-support inside the
 *                mountain ring (bbox-bounded) — disjoint ⇒ byte-inert.
 * Returns `null` for any non-terrain-stamp feature: those keep the consumer's
 * own `influenceMargin`. Defensive parse (persisted params may be malformed):
 * falls back to the relief default half-width, never throws. Keyed on
 * `procgen.algorithm` (the field itself keys on it), so a blockless stamp ⇒
 * `null` (invisible to the field AND to this reach — consistent). */
export function terrainStampSupport(feature: FabricFeature): number | null {
  const alg = feature.properties.procgen?.algorithm;
  if (alg === "relief") {
    const p = feature.properties.procgen!.params as Record<string, unknown>;
    const hw = typeof p.halfWidth === "number" && Number.isFinite(p.halfWidth) ? p.halfWidth : RELIEF_DEFAULTS.halfWidth;
    const apron = typeof p.apron === "number" && Number.isFinite(p.apron) ? p.apron : 0;
    return Math.max(0, hw) + Math.max(0, apron);
  }
  if (alg === "landform" || alg === "mountain") return 0;
  return null;
}

/** A relief stamp's ADD contribution: `sign·height·bump(d/reach)` where `d` is
 * the distance to the sketched spine (via the segment hash — the plan's polyline
 * binding), `reach = halfWidth + apron` (apron default 0), and `bump` is the
 * smoothstep hump (1 at the spine, 0 at the reach). The apron WIDENS the same
 * C1 smoothstep hump so the zero-crossing moves from `halfWidth` to
 * `halfWidth + apron` — the peak still tops out at the spine (`bump(0) === 1`),
 * the toe spreads into a foothill skirt (make-it-look-real shortlist item 2).
 * With apron 0 (default) `reach === halfWidth` and EVERY line below is the exact
 * pre-apron computation ⇒ byte-identical (no bump). Compact support: EXACTLY 0
 * beyond `reach` (so a disjoint relief stamp is byte-inert — the compact-support
 * property the 033 harness + `terrainStampSupport` ride on). Analytic gradient by
 * chain rule: ∇v = sign·height·bump'(t)·(1/reach)·∇d, ∇d the unit away-from-line
 * direction the hash returns. */
function reliefField(spine: Pt[], params: ReliefParams): ElevationField {
  const sign = params.polarity === "valley" ? -1 : 1;
  const H = params.height;
  const hw = Math.max(1e-6, params.halfWidth);
  // reach = hw + apron. apron 0 ⇒ reach === hw ⇒ byte-identical to pre-apron.
  const reach = hw + Math.max(0, params.apron ?? 0);
  // cellSize keyed on hw (NOT reach) so an apron never perturbs the segment
  // hash's bucketing — nearest() is exact regardless, but keeping the former
  // cellSize keeps apron 0 bit-for-bit identical to the pre-apron hash.
  const hash = new SegmentHash(spine, { cellSize: Math.max(32, hw) });
  const bnd = hash.bounds;
  return (x, y): HeightSample => {
    // FAR-FIELD FAST REJECT (compact support, BYTE-EXACT — the carve's idiom):
    // the bbox distance is a lower bound on the true nearest distance, and the
    // stamp is EXACTLY 0 at any dist ≥ reach, so a sample past the bbox by
    // ≥ reach takes the same zero branch without paying the O(dist²) spiral. The
    // bound uses `reach` (= hw + apron), so it only fires where the full path is
    // provably zero — the apron'd skirt is inside the reject band, never clipped.
    const dLBx = x < bnd.minX ? bnd.minX - x : x > bnd.maxX ? x - bnd.maxX : 0;
    const dLBy = y < bnd.minY ? bnd.minY - y : y > bnd.maxY ? y - bnd.maxY : 0;
    if (dLBx * dLBx + dLBy * dLBy >= reach * reach) return { v: 0, dx: 0, dy: 0 };
    const near = hash.nearest(x, y);
    if (near.dist >= reach) return { v: 0, dx: 0, dy: 0 };
    const t = near.dist / reach; // 0 at spine, 1 at the (apron'd) rim
    const bump = 1 - t * t * (3 - 2 * t); // 1 → 0, C1 at both ends
    const v = sign * H * bump;
    // bump'(t) = -6t(1-t); ∇v = sign·H·bump'(t)·(1/reach)·∇d.
    const dbump = -6 * t * (1 - t);
    const scale = (sign * H * dbump) / reach;
    return { v, dx: scale * near.gradX, dy: scale * near.gradY };
  };
}

// ─── Landform polygon stamps (REPLACE) — lerp toward a target ────────────────

export const LANDFORM_MODES = ["plateau", "basin", "sea"] as const;
export type LandformMode = (typeof LANDFORM_MODES)[number];

export interface LandformParams {
  mode: LandformMode;
  /** Replace target height, meters. When omitted the mode's default is used
   * (plateau raises, basin lowers, sea drops to the seaDatum). */
  target?: number;
  /** Falloff band (meters) inside the ring: the mask ramps 0 (rim) → 1 (this far
   * in), so the interior saturates to `target` and edits stay rim-local. */
  band: number;
  /** Later-applied stamp wins where masks overlap. Integer; id order breaks
   * ties (ratified Q4). */
  priority: number;
}

export const LANDFORM_DEFAULTS: Omit<LandformParams, "target"> = { mode: "plateau", band: 120, priority: 0 };
const LANDFORM_MODE_TARGET: Record<LandformMode, number> = { plateau: 400, basin: -200, sea: 0 };

/** Resolve a landform's replace target: the explicit `target`, else the mode
 * default — except `sea`, which always tracks the campaign `seaDatum`. */
function landformTarget(params: LandformParams, seaDatum: number): number {
  if (params.mode === "sea") return typeof params.target === "number" ? params.target : seaDatum;
  return typeof params.target === "number" ? params.target : LANDFORM_MODE_TARGET[params.mode];
}

interface MaskSample {
  m: number;
  dmx: number;
  dmy: number;
}

/** The ring's interior mask + gradient: smoothstep of the signed distance
 * (positive inside) over `band`. Nonzero gradient only in the open band
 * `0 < signedDist < band` (deep interior and exterior are flat, gradient 0 — the
 * clamp). Uses the segment hash over the closed ring (polyline binding). */
function ringMaskField(ring: Pt[], band: number): (x: number, y: number) => MaskSample {
  const closed = closeRing(ring);
  const hash = new SegmentHash(closed, { cellSize: Math.max(32, band) });
  const b = Math.max(1e-6, band);
  const bnd = hash.bounds;
  return (x, y): MaskSample => {
    // FAR-FIELD FAST REJECT (BYTE-EXACT): outside the ring's bbox ⇒ outside the
    // ring ⇒ signed distance < 0 ⇒ the full path returns the zero mask — take
    // that branch without the O(dist²) nearest-spiral (the DEM-fill stall).
    if (x < bnd.minX || x > bnd.maxX || y < bnd.minY || y > bnd.maxY) return { m: 0, dmx: 0, dmy: 0 };
    const near = hash.nearest(x, y);
    const inside = pointInRingClosed(closed, x, y);
    const sd = inside ? near.dist : -near.dist;
    if (sd <= 0) return { m: 0, dmx: 0, dmy: 0 };
    if (sd >= b) return { m: 1, dmx: 0, dmy: 0 };
    const t = sd / b;
    const m = t * t * (3 - 2 * t);
    // ∇m = smoothstep'(t)·(1/band)·∇(signedDist); inside the band signedDist > 0
    // so ∇(signedDist) = +∇d (the hash's away-from-line unit, which points inward
    // for an interior query).
    const f = (6 * t * (1 - t)) / b;
    return { m, dmx: f * near.gradX, dmy: f * near.gradY };
  };
}

// ─── River carve (REPLACE-stage successor) — smin toward a channel bed ───────

/** Carve tuning (meters), FIXED absolute-world constants. */
const CARVE_DEPTH_BASE = 60; // channel-floor incision below the surrounding surface
const CARVE_DEPTH_PER_WIDTH = 1.5; // wider rivers cut deeper
const CARVE_BANK_SLOPE = 2.2; // gorge-wall rise (meters up per meter out past the channel)
const CARVE_SMIN_K = 40; // smooth-min blend radius (soft banks, no hard crease)
const CARVE_RESAMPLE_M = 40; // densify the spine so the bed follows terrain finely

/** Resample a polyline so no segment exceeds `maxStep` meters — the bed floor is
 * sampled per vertex, so a coarse GM spine (km between clicks) would let the
 * incision drift off the terrain between vertices. Deterministic (pure geometry).
 */
function densify(line: Pt[], maxStep: number): Pt[] {
  const out: Pt[] = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / maxStep));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
  }
  return out;
}

interface RiverCarve {
  id: string;
  spine: Pt[];
  halfWidth: number;
  depth: number;
}

function riverCarvesFromFabric(features: FabricFeature[]): RiverCarve[] {
  const out: RiverCarve[] = [];
  for (const f of features) {
    if (f.properties.kind !== "river" || f.properties.procgen?.algorithm !== "river") continue;
    if (f.geometry.type !== "LineString") continue;
    const spine = f.geometry.coordinates as Pt[];
    if (!spine || spine.length < 2) continue;
    const p = f.properties.procgen.params as Record<string, unknown>;
    const width = Math.max(4, num(p.width, 12));
    out.push({
      id: String(f.id),
      spine,
      halfWidth: width,
      depth: CARVE_DEPTH_BASE + width * CARVE_DEPTH_PER_WIDTH,
    });
  }
  // id-sorted before the fold (FP determinism — smin is not order-independent).
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** iq polynomial smooth-min (min-blend over `k`): pulls `a` down toward the
 * lower `b` with a soft crease. Also returns the blend weight `h` so the caller
 * composes the gradient (∂smin/∂a and ∂smin/∂b) by chain rule. */
function polySmin(a: number, b: number, k: number): { v: number; h: number; smooth: boolean } {
  // iq polynomial smooth-min: h = clamp(0.5 + 0.5·(b−a)/k). h→1 ⇒ smin→a (bed
  // above the surface, no carve); h→0 ⇒ smin→b (bed well below, full carve).
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  const smooth = h > 0 && h < 1;
  return { v: b + (a - b) * h - k * h * (1 - h), h, smooth };
}

/**
 * A river carve as a fold step `smin(pre, bed)`. The BED is a memoized per-region
 * channel field (plan 023's sanctioned region-scoped exception): the pre-carve
 * surface is sampled ONCE at each spine vertex and incised by `depth`, so the
 * gorge FOLLOWS the terrain the river runs through (deeper where the ground is
 * higher). At query time the nearest spine point (via the segment hash — the
 * polyline binding) interpolates that per-vertex floor and the gorge wall rises
 * `CARVE_BANK_SLOPE` past the channel half-width. Compact support: beyond where
 * the wall clears the surface the bed exceeds `pre`, so `smin` returns `pre`
 * unchanged (a river far from its channel is inert). Simplification (main channel
 * only, per plan): the bed tracks local terrain rather than enforcing a global
 * monotone downstream descent — a hydrological grade correction is deferred (a
 * single low source point should not carve a canyon the length of the spine).
 */
function buildRiverCarve(carve: RiverCarve, pre: ElevationField): (s: HeightSample, x: number, y: number) => HeightSample {
  const spine = densify(carve.spine, CARVE_RESAMPLE_M);
  const hash = new SegmentHash(spine, { cellSize: Math.max(64, carve.halfWidth * 4) });
  // Memoize the bed floor at each (densified) spine vertex — region-scoped
  // whole-artifact pass: sample the pre-carve surface once per vertex, incise by
  // `depth`, so the gorge follows the terrain at ~CARVE_RESAMPLE_M resolution.
  const bedVert = new Float64Array(spine.length);
  let bedMin = Infinity; // lowest per-vertex floor — a lower bound on the bed floor anywhere
  for (let i = 0; i < spine.length; i++) {
    const [vx, vy] = spine[i];
    bedVert[i] = pre(vx, vy).v - carve.depth;
    if (bedVert[i] < bedMin) bedMin = bedVert[i];
  }
  const hw = carve.halfWidth;
  const bnd = hash.bounds;
  return (s: HeightSample, x: number, y: number): HeightSample => {
    // FAR-FIELD FAST REJECT (compact support, BYTE-EXACT). The segment hash's
    // nearest-query spirals cells outward, so a point far from THIS river's spine
    // (e.g. a DEM sample near a DIFFERENT river) is O(dist²) to answer — the
    // cold-carve blow-up plan 036-B calls out, and the reason a naive per-pixel
    // DEM fill over several rivers is unusably slow. But the carve has tiny
    // compact support: `smin(pre, bed)` returns `pre` UNCHANGED once `bed ≥ pre+k`
    // (h≥1). A cheap lower bound on the bed at (x,y) is `bedMin + slope·max(0,
    // dLB−hw)`, where `dLB` (distance from the point to the spine's bbox) ≤ the
    // true nearest distance and `bedMin` ≤ any per-vertex floor. If even that
    // lower bound already clears `pre+k`, the full carve is provably inert here —
    // return `s` and skip the hash query. Only short-circuits where the full path
    // would ALSO return `s` (h≥1), so it is byte-identical to evaluating the carve.
    const dLBx = x < bnd.minX ? bnd.minX - x : x > bnd.maxX ? x - bnd.maxX : 0;
    const dLBy = y < bnd.minY ? bnd.minY - y : y > bnd.maxY ? y - bnd.maxY : 0;
    const dLB = Math.hypot(dLBx, dLBy);
    if (bedMin + CARVE_BANK_SLOPE * Math.max(0, dLB - hw) >= s.v + CARVE_SMIN_K) return s;
    const near = hash.nearest(x, y);
    if (near.segIndex < 0) return s;
    const i = near.segIndex;
    const j = Math.min(i + 1, bedVert.length - 1);
    const bedFloor = bedVert[i] + (bedVert[j] - bedVert[i]) * near.t;
    const wall = CARVE_BANK_SLOPE * Math.max(0, near.dist - hw);
    const bed = bedFloor + wall;
    // smin(pre, bed). If the bed already sits above the surface, smin is exactly
    // `pre` (h === 1) — the compact-support inertness.
    const sm = polySmin(s.v, bed, CARVE_SMIN_K);
    if (sm.h >= 1) return s;
    // Gradient by chain rule. ∇bed ≈ CARVE_BANK_SLOPE·∇dist past the channel
    // (the per-vertex floor varies slowly along the spine — treated locally
    // constant, an acceptable approximation for hillshade, which Sobel-derives
    // slope from the raster anyway). Inside the flat floor ∇bed = 0.
    let bdx = 0;
    let bdy = 0;
    if (near.dist > hw) {
      bdx = CARVE_BANK_SLOPE * near.gradX;
      bdy = CARVE_BANK_SLOPE * near.gradY;
    }
    if (!sm.smooth) {
      // h === 0 ⇒ smin === bed.
      return { v: sm.v, dx: bdx, dy: bdy };
    }
    // Smooth region: ∂smin/∂x = b' + (a'−b')·h + (a−b)·h', h' = 0.5·(b'−a')/k
    // (h = 0.5 + 0.5·(b−a)/k).
    const dhx = (0.5 * (bdx - s.dx)) / CARVE_SMIN_K;
    const dhy = (0.5 * (bdy - s.dy)) / CARVE_SMIN_K;
    const ab = s.v - bed;
    const dx = bdx + (s.dx - bdx) * sm.h + ab * dhx - CARVE_SMIN_K * dhx * (1 - 2 * sm.h);
    const dy = bdy + (s.dy - bdy) * sm.h + ab * dhy - CARVE_SMIN_K * dhy * (1 - 2 * sm.h);
    return { v: sm.v, dx, dy };
  };
}

function closeRing(ring: Pt[]): Pt[] {
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring;
  }
  return ring.length >= 1 ? [...ring, ring[0]] : ring;
}

// ─── City-site grading (GRADE) — flatten toward the center's elevation ───────
// Ratified DEFAULT OFF (Q3): a city sits on the terrain as-is unless the GM opts
// in. When on, the district interior is levelled toward the elevation at its
// persisted center (a building platform), fading back to the natural ground at
// the rim.

const GRADE_DEFAULT_BAND = 150;

interface GradeStamp {
  id: string;
  ring: Pt[];
  cx: number;
  cy: number;
  band: number;
}

function ringCentroid(ring: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  let n = 0;
  // Skip the closing duplicate if present.
  const last = ring.length - (ring.length >= 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? 1 : 0);
  for (let i = 0; i < last; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
    n++;
  }
  return n > 0 ? [sx / n, sy / n] : [0, 0];
}

/** Grade stamps: district regions whose `city` procgen block opts INTO grading
 * (`params.grade === true`). Center is the persisted `params.center` (the same
 * anchor the city plaza uses) else the ring centroid. Default-off ⇒ empty ⇒ the
 * grade operator is a strict no-op (byte-identity). */
function gradeStampsFromFabric(features: FabricFeature[]): GradeStamp[] {
  const out: GradeStamp[] = [];
  for (const f of features) {
    const block = f.properties.procgen;
    if (f.properties.kind !== "district" || block?.algorithm !== "city") continue;
    if (f.geometry.type !== "Polygon") continue;
    const p = block.params as Record<string, unknown>;
    if (p.grade !== true) continue;
    const ring = f.geometry.coordinates[0] as Pt[] | undefined;
    if (!ring || ring.length < 3) continue;
    const center = Array.isArray(p.center) && p.center.length === 2 && typeof p.center[0] === "number" && typeof p.center[1] === "number"
      ? ([p.center[0], p.center[1]] as Pt)
      : ringCentroid(ring);
    out.push({
      id: String(f.id),
      ring,
      cx: center[0],
      cy: center[1],
      band: Math.max(0, num(p.gradeBand, GRADE_DEFAULT_BAND)),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ─── Stamp collection (defensive parse of the durable sketch layer) ──────────

interface ReliefStamp {
  id: string;
  spine: Pt[];
  params: ReliefParams;
}
interface LandformStamp {
  id: string;
  ring: Pt[];
  params: LandformParams;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function reliefStampsFromFabric(features: FabricFeature[]): ReliefStamp[] {
  const out: ReliefStamp[] = [];
  for (const f of features) {
    if (f.properties.kind !== "relief" || f.properties.procgen?.algorithm !== "relief") continue;
    if (f.geometry.type !== "LineString") continue;
    const spine = f.geometry.coordinates as Pt[];
    if (!spine || spine.length < 2) continue;
    const p = f.properties.procgen.params as Record<string, unknown>;
    const polarity = (
      typeof p.polarity === "string" && (RELIEF_POLARITIES as readonly string[]).includes(p.polarity)
        ? p.polarity
        : RELIEF_DEFAULTS.polarity
    ) as ReliefPolarity;
    out.push({
      id: String(f.id),
      spine,
      params: {
        polarity,
        height: num(p.height, RELIEF_DEFAULTS.height),
        halfWidth: Math.max(1e-6, num(p.halfWidth, RELIEF_DEFAULTS.halfWidth)),
        // apron: absent/malformed ⇒ 0 ⇒ byte-identical to the pre-apron stamp.
        apron: Math.max(0, num(p.apron, 0)),
      },
    });
  }
  // id-sorted BEFORE folding (FP determinism — a shuffled enumeration must sample
  // identically).
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function landformStampsFromFabric(features: FabricFeature[]): LandformStamp[] {
  const out: LandformStamp[] = [];
  for (const f of features) {
    if (f.properties.kind !== "landform" || f.properties.procgen?.algorithm !== "landform") continue;
    if (f.geometry.type !== "Polygon") continue;
    const ring = f.geometry.coordinates[0] as Pt[] | undefined;
    if (!ring || ring.length < 3) continue;
    const p = f.properties.procgen.params as Record<string, unknown>;
    const mode = (
      typeof p.mode === "string" && (LANDFORM_MODES as readonly string[]).includes(p.mode)
        ? p.mode
        : LANDFORM_DEFAULTS.mode
    ) as LandformMode;
    out.push({
      id: String(f.id),
      ring,
      params: {
        mode,
        target: typeof p.target === "number" && Number.isFinite(p.target) ? p.target : undefined,
        band: Math.max(0, num(p.band, LANDFORM_DEFAULTS.band)),
        priority: Math.trunc(num(p.priority, LANDFORM_DEFAULTS.priority)),
      },
    });
  }
  // (priority asc, id asc): folded in this order so the LAST stamp wins where
  // masks overlap — priority is the GM override, id order the stable tiebreak.
  out.sort((a, b) => a.params.priority - b.params.priority || a.id.localeCompare(b.id));
  return out;
}

/** True iff any terrain-relief stamp (mountain / relief / landform) or a non-flat
 * base is present — the "should I couple to terrain at all?" predicate consumers
 * use in place of `elevationFieldFromFabric`'s null return. */
export function hasTerrainRelief(features: FabricFeature[] | undefined, base?: Partial<TerrainBaseParams>): boolean {
  const campAmp = base?.campAmp ?? DEFAULT_TERRAIN_BASE.campAmp;
  if (campAmp !== 0) return true;
  if (!features) return false;
  return features.some(
    (f) =>
      (f.properties.procgen?.algorithm === "mountain" ||
        f.properties.procgen?.algorithm === "relief" ||
        f.properties.procgen?.algorithm === "landform") &&
      f.properties.procgen !== undefined
  );
}

// ─── The composed field ──────────────────────────────────────────────────────

/**
 * The campaign terrain field `T(x,y)` composed from the durable sketch layer.
 * Always returns a field (the base is everywhere-defined). On a mountain-only
 * campaign with a flat base this is BYTE-IDENTICAL to `elevationFieldFromFabric`
 * (the mountain term IS that function — the verbatim migration is a call).
 */
export function terrainAt(features: FabricFeature[] | undefined, opts: TerrainOptions = {}): ElevationField {
  const base: TerrainBaseParams = {
    campAmp: opts.base?.campAmp ?? DEFAULT_TERRAIN_BASE.campAmp,
    seaDatum: opts.base?.seaDatum ?? DEFAULT_TERRAIN_BASE.seaDatum,
  };
  const B = baseField(base, opts.campaignSeed ?? 0);
  const feats = features ?? [];

  const inc = {
    relief: opts.include?.relief ?? true,
    landform: opts.include?.landform ?? true,
    carve: opts.include?.carve ?? true,
    grade: opts.include?.grade ?? true,
  };

  // ADD: base + mountain union (verbatim) + Σ relief (id-sorted).
  const mountain = elevationFieldFromFabric(feats);
  const reliefs = inc.relief ? reliefStampsFromFabric(feats).map((s) => reliefField(s.spine, s.params)) : [];

  // REPLACE: landform lerp stamps, folded in (priority, id) order.
  const landforms = inc.landform
    ? landformStampsFromFabric(feats).map((s) => ({
        mask: ringMaskField(s.ring, s.params.band),
        target: landformTarget(s.params, base.seaDatum),
      }))
    : [];

  const carveStamps = inc.carve ? riverCarvesFromFabric(feats) : [];
  const gradeStamps = inc.grade ? gradeStampsFromFabric(feats) : [];

  // VERBATIM-MIGRATION FAST PATH: a flat datum-0 base with no add-relief, no
  // replace stamp, no river carve, and no city grading IS
  // `elevationFieldFromFabric` — return it (or the flat field) DIRECTLY, never
  // `0 + m.v`. This preserves the mountain field's signed zeros bit-for-bit
  // (`(+0) + (-0) === +0` would corrupt a −0 gradient outside a ring), the
  // byte-stability the migration + carve + grading-off gates all assert.
  if (
    reliefs.length === 0 &&
    landforms.length === 0 &&
    carveStamps.length === 0 &&
    gradeStamps.length === 0 &&
    base.campAmp === 0 &&
    base.seaDatum === 0
  ) {
    return mountain ?? (() => ({ v: 0, dx: 0, dy: 0 }));
  }

  // The pre-carve surface: base + mountain-union + relief (add), then landform
  // lerp (replace). The river carve samples THIS along each spine (memoized).
  const pre: ElevationField = (x, y): HeightSample => {
    const b = B(x, y);
    let v = b.v;
    let dx = b.dx;
    let dy = b.dy;
    if (mountain) {
      const m = mountain(x, y);
      v += m.v;
      dx += m.dx;
      dy += m.dy;
    }
    for (const r of reliefs) {
      const s = r(x, y);
      v += s.v;
      dx += s.dx;
      dy += s.dy;
    }
    for (const lf of landforms) {
      const mk = lf.mask(x, y);
      if (mk.m === 0) continue; // exact identity outside the band (compact support)
      const diff = lf.target - v;
      // newV = v + m·(target − v); ∇newV = ∇v·(1−m) + (target−v)·∇m.
      dx = dx * (1 - mk.m) + diff * mk.dmx;
      dy = dy * (1 - mk.m) + diff * mk.dmy;
      v = v + mk.m * diff;
    }
    return { v, dx, dy };
  };

  // CARVE: smin(pre, bed) per river, id-sorted; each bed is a memoized per-region
  // channel field (built here, once).
  const carves = carveStamps.map((c) => buildRiverCarve(c, pre));
  const t3: ElevationField =
    carves.length === 0
      ? pre
      : (x, y): HeightSample => {
          let s = pre(x, y);
          for (const carve of carves) s = carve(s, x, y);
          return s;
        };

  if (gradeStamps.length === 0) return t3;

  // GRADE: lerp(t3, t3(center), mask) per graded district — the center's
  // elevation is sampled ONCE (memoized, region-scoped exception, like the
  // carve). Folded in id order.
  const grades = gradeStamps.map((g) => ({
    mask: ringMaskField(g.ring, g.band),
    centerElev: t3(g.cx, g.cy).v,
  }));
  return (x, y): HeightSample => {
    const s = t3(x, y);
    let { v, dx, dy } = s;
    for (const g of grades) {
      const mk = g.mask(x, y);
      if (mk.m === 0) continue; // exact identity outside the band
      const diff = g.centerElev - v;
      dx = dx * (1 - mk.m) + diff * mk.dmx;
      dy = dy * (1 - mk.m) + diff * mk.dmy;
      v = v + mk.m * diff;
    }
    return { v, dx, dy };
  };
}

/**
 * The durable MACRO terrain field a slope/paddy/timberline consumer couples to
 * (ruling 2026-07-15): the FULL global terrain system — base fBm + mountain
 * add-stamps + relief add-stamps + landform replace-stamps — WITHOUT the river
 * carve or city grade (those two stay excluded: a carve is a river reading its
 * OWN gorge, circular; grade reads settlement OUTPUT). "No more mountain
 * polygons, only the global terrain system": a mountain is now just one stamp
 * kind feeding this field, never a special case.
 *
 * BIT-EXACT drop-in for `elevationFieldFromFabric` on the campaigns the goldens
 * cover: with a flat base and no relief/landform stamps it IS that function's
 * field (via `terrainAt`'s verbatim fast path — reliefs/landforms empty ⇒ same
 * signed-zero-preserving mountain union), so a mountain-only or no-stamp
 * campaign is byte-identical. Returns `null` on a trivially-flat campaign (no
 * terrain stamp of any kind AND flat base — exactly `!hasTerrainRelief`) so the
 * consumers keep their null-shortcut + perf skip.
 *
 * The campaign base (`base` = campAmp/seaDatum, `campaignSeed` for the base fBm)
 * is threaded so a consumer composes the SAME surface the DEM does. Both default
 * inert (campAmp 0 ⇒ flat datum-0 base) ⇒ byte-identical to a pre-ruling run.
 */
export function macroTerrainField(
  features: FabricFeature[] | undefined,
  base?: Partial<TerrainBaseParams>,
  campaignSeed?: number
): ElevationField | null {
  if (!hasTerrainRelief(features, base)) return null; // trivially flat ⇒ null shortcut
  return terrainAt(features, { base, campaignSeed, include: { relief: true, landform: true, carve: false, grade: false } });
}

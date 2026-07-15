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
  /** Cross-profile half-width, meters — the relief fades to 0 by this distance
   * from the spine. Also the corridor bound the host builds for this line kind. */
  halfWidth: number;
}

export const RELIEF_DEFAULTS: ReliefParams = { polarity: "ridge", height: 200, halfWidth: 150 };

/** The corridor half-width a relief stamp needs (host corridor + influence
 * margin): its full cross-profile band. */
export function reliefMaxOffset(params: ReliefParams): number {
  return Math.max(0, params.halfWidth);
}

/** A relief stamp's ADD contribution: `sign·height·bump(d/halfWidth)` where `d`
 * is the distance to the sketched spine (via the segment hash — the plan's
 * polyline binding) and `bump` is the smoothstep hump (1 at the spine, 0 at the
 * half-width). Compact support: EXACTLY 0 beyond `halfWidth` (so a disjoint relief
 * stamp is byte-inert — the compact-support margin-0 property the 033 harness
 * rides on). Analytic gradient by chain rule: ∇v = sign·height·bump'(t)·(1/hw)·∇d,
 * ∇d the unit away-from-line direction the hash returns. */
function reliefField(spine: Pt[], params: ReliefParams): ElevationField {
  const sign = params.polarity === "valley" ? -1 : 1;
  const H = params.height;
  const hw = Math.max(1e-6, params.halfWidth);
  const hash = new SegmentHash(spine, { cellSize: Math.max(32, hw) });
  return (x, y): HeightSample => {
    const near = hash.nearest(x, y);
    if (near.dist >= hw) return { v: 0, dx: 0, dy: 0 };
    const t = near.dist / hw; // 0 at spine, 1 at rim
    const bump = 1 - t * t * (3 - 2 * t); // 1 → 0, C1 at both ends
    const v = sign * H * bump;
    // bump'(t) = -6t(1-t); ∇v = sign·H·bump'(t)·(1/hw)·∇d.
    const dbump = -6 * t * (1 - t);
    const scale = (sign * H * dbump) / hw;
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
  return (x, y): MaskSample => {
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

function closeRing(ring: Pt[]): Pt[] {
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring;
  }
  return ring.length >= 1 ? [...ring, ring[0]] : ring;
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

  // ADD: base + mountain union (verbatim) + Σ relief (id-sorted).
  const mountain = elevationFieldFromFabric(feats);
  const reliefs = reliefStampsFromFabric(feats).map((s) => reliefField(s.spine, s.params));

  // REPLACE: landform lerp stamps, folded in (priority, id) order.
  const landforms = landformStampsFromFabric(feats).map((s) => ({
    mask: ringMaskField(s.ring, s.params.band),
    target: landformTarget(s.params, base.seaDatum),
  }));

  // VERBATIM-MIGRATION FAST PATH: a flat datum-0 base with no add-relief and no
  // replace stamps IS `elevationFieldFromFabric` — return it (or the flat field)
  // DIRECTLY, never `0 + m.v`. This preserves the mountain field's signed zeros
  // bit-for-bit (`(+0) + (-0) === +0` would corrupt a −0 gradient outside a
  // ring), the byte-stability the migration gate asserts to the float.
  if (reliefs.length === 0 && landforms.length === 0 && base.campAmp === 0 && base.seaDatum === 0) {
    return mountain ?? (() => ({ v: 0, dx: 0, dy: 0 }));
  }

  return (x, y): HeightSample => {
    // add
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
    // replace
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
}

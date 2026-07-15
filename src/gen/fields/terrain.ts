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
import { tileLngLatBounds, TERRAIN_FIELD_VERSION } from "./dem";
import { SegmentHash } from "../segmentHash";
import type { BBox } from "../spatialHash";
import type { FabricFeature } from "../../model/fabric";
import { buildRiverCenterline, type RiverParams } from "../river";
import { makeSpine, type Spine } from "../region";

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
 *                EXCEPT an INVERTED sea (plan 041 island-from-coastline), whose
 *                mask is `1 − ringMask`: nonzero EVERYWHERE outside the ring, so
 *                its support is the whole campaign box → `Infinity` (campaign-wide
 *                dirty, like the base params). Every consumer that folds this in
 *                (DEM per-tile digest, DAG source→region edge, fingerprint scoping)
 *                then treats an inverted sea as global — the byte-exact reflection
 *                of its global reach.
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
  if (alg === "landform") {
    // An inverted sea replaces the ring's EXTERIOR — global support. Every other
    // landform is compact-support inside its ring bbox (reach 0). Absent invert ⇒
    // 0 ⇒ byte-identical to the pre-041 reach.
    const p = feature.properties.procgen!.params as Record<string, unknown>;
    return p.mode === "sea" && p.invert === true ? Infinity : 0;
  }
  if (alg === "mountain") return 0;
  return null;
}

// ─── Per-tile terrain digest (scoped DEM cache invalidation) ─────────────────
// The DEM cache keyed every tile on a CAMPAIGN-WIDE digest: a single stamp edit
// (an extrude release) changed the digest, so EVERY cached DEM tile went stale
// and the whole viewport re-derived at res² samples/tile — the cheap contour
// leaves finished first, so an extrude "painted the topo lines long before the 3D
// height" (Jonah). Scoping the digest per-tile — hash only the durable inputs
// whose support intersects THAT tile — means an extrude re-derives ONLY the tiles
// the edited stamp touches; every other tile stays a cache hit and never
// recomputes. Same discipline the contour leaves already key on.

function stampBBox(f: FabricFeature): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const coords = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates;
  for (const pt of coords as Pt[]) {
    if (pt[0] < b.minX) b.minX = pt[0];
    if (pt[1] < b.minY) b.minY = pt[1];
    if (pt[0] > b.maxX) b.maxX = pt[0];
    if (pt[1] > b.maxY) b.maxY = pt[1];
  }
  return b;
}

/** Does `stamp` (grown by its support `reach`) touch `tile`? Inclusive on the
 * boundary — err on the side of INCLUDING a stamp (an unneeded recompute) rather
 * than dropping one (a stale-byte false hit). */
function bboxTouches(stamp: BBox, tile: BBox, reach: number): boolean {
  return (
    stamp.minX - reach <= tile.maxX &&
    stamp.maxX + reach >= tile.minX &&
    stamp.minY - reach <= tile.maxY &&
    stamp.maxY + reach >= tile.minY
  );
}

/** Fingerprint one terrain stamp's durable identity (matches `elevationDigest`'s
 * per-feature shape so the two digests move together on an edit). */
function stampFingerprint(f: FabricFeature): string {
  const p = f.properties.procgen!;
  return JSON.stringify({
    id: f.id,
    kind: f.properties.kind,
    algorithm: p.algorithm,
    seed: p.seed,
    params: p.params,
    geometry: f.geometry.coordinates,
  });
}

/**
 * The per-tile terrain digest: base params + K + campaign seed + grade-enable,
 * plus the id-sorted fingerprints of every durable terrain stamp whose
 * (support-expanded) bbox intersects the tile's gen-space extent. A cached DEM
 * record with a different digest is a stale miss.
 *
 * Support reach per kind (byte-exact compact support — a stamp beyond its reach
 * cannot move the field over this tile, so omitting it is a true no-op):
 *   - relief   → `terrainStampSupport` (halfWidth + apron; reliefField is exactly
 *                0 past it).
 *   - mountain / landform → 0 (compact-support inside their ring bbox), EXCEPT an
 *                inverted sea (plan 041) → `terrainStampSupport` returns Infinity,
 *                so `bboxTouches(..., Infinity)` is always true and the inverted
 *                sea folds into every tile's digest (its exterior reach is global).
 *   - graded district → the grade band (a safe over-estimate; grade fades to
 *                natural ground by the rim, so it is really bbox-bounded).
 *   - river carve → ALWAYS included (global). The carve's horizontal reach is
 *                terrain-dependent — a gorge wall can climb an adjacent massif for
 *                hundreds of metres — with no cheap sound UPPER bound, so scoping a
 *                river risks a false-miss (stale bytes, a determinism-law
 *                violation). Global inclusion is the maximally-inclusive safe
 *                choice, and it does NOT dilute the extrude win: an extrude edits a
 *                relief/landform stamp, never a river, so a far tile's river
 *                entries are unchanged ⇒ that tile still cache-hits. (A bounded
 *                carve reach could scope rivers later — a follow-up.)
 *
 * Enumeration-order-stable (id-sorted) — the fold discipline. Cheap string,
 * compared not persisted. Carries `TERRAIN_FIELD_VERSION` so a field-math change
 * re-derives every tile.
 */
export function perTileTerrainDigest(
  features: FabricFeature[],
  base: TerrainBaseParams,
  campaignSeed: number,
  gradeEnabled: boolean,
  z: number,
  x: number,
  y: number,
  scaleMetersPerUnit: number,
  k: number
): string {
  const { west, east, north, south } = tileLngLatBounds(z, x, y);
  const tile: BBox = {
    minX: Math.min(west, east) * scaleMetersPerUnit,
    maxX: Math.max(west, east) * scaleMetersPerUnit,
    minY: Math.min(south, north) * scaleMetersPerUnit,
    maxY: Math.max(south, north) * scaleMetersPerUnit,
  };
  const hits: string[] = [];
  for (const f of features) {
    const alg = f.properties.procgen?.algorithm;
    if (!alg) continue;
    if (alg === "river") {
      // Global (see doc): a river always contributes to every tile's digest.
      hits.push(stampFingerprint(f));
      continue;
    }
    let reach: number | null;
    if (alg === "mountain" || alg === "relief" || alg === "landform") {
      reach = terrainStampSupport(f); // 0 / halfWidth+apron
    } else if (
      gradeEnabled &&
      f.properties.kind === "district" &&
      alg === "city" &&
      (f.properties.procgen?.params as Record<string, unknown> | undefined)?.grade === true
    ) {
      reach = GRADE_DEFAULT_BAND; // conservative; grade fades to natural by the rim (bbox-bounded)
    } else {
      reach = null; // not a terrain-field input ⇒ never in the digest
    }
    if (reach === null) continue;
    if (bboxTouches(stampBBox(f), tile, reach)) hits.push(stampFingerprint(f));
  }
  hits.sort();
  return `t${TERRAIN_FIELD_VERSION}|k${k}|b${base.campAmp}:${base.seaDatum}|s${campaignSeed}|g${gradeEnabled ? 1 : 0}|${hits.join("|")}`;
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
  /** Island-from-coastline (plan 041): on a `sea` stamp, the drawn ring is the
   * LAND boundary (the coast) and the effective sea is the ring's EXTERIOR. The
   * mask becomes `1 − ringMask` — 1 (full sea) everywhere outside the ring, fading
   * across `band` INWARD from the coast to 0 deep inland. Absent/false ⇒ the
   * interior is the sea (pre-041 behavior), byte-identical. Only meaningful for
   * `mode === "sea"`. */
  invert?: boolean;
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

/**
 * Island-from-coastline exterior mask (plan 041): `1 − ringMask`. The drawn ring
 * is the COAST (land boundary); the sea replaces its EXTERIOR. So the mask is 1
 * (full sea) everywhere outside the ring, fades across `band` INWARD from the coast
 * to 0 deep inland — the byte-exact complement of the interior mask, gradient
 * negated. The far-field reject flips for free: `ringMaskField` returns m=0 outside
 * the bbox (⇒ this returns m=1, full sea) WITHOUT the nearest-spiral, so a sample
 * far out in the ocean is O(1). Support is therefore GLOBAL (see
 * `terrainStampSupport` → Infinity for an inverted sea). */
function exteriorMaskField(ring: Pt[], band: number): (x: number, y: number) => MaskSample {
  const inner = ringMaskField(ring, band);
  return (x, y): MaskSample => {
    const s = inner(x, y);
    return { m: 1 - s.m, dmx: -s.dmx, dmy: -s.dmy };
  };
}

// ─── River carve (REPLACE-stage successor) — smin toward a channel bed ───────

/** Carve tuning (meters), FIXED absolute-world constants. */
const CARVE_DEPTH_BASE = 60; // channel-floor incision below the surrounding surface
const CARVE_DEPTH_PER_WIDTH = 1.5; // wider rivers cut deeper
const CARVE_BANK_SLOPE = 2.2; // gorge-wall rise (meters up per meter out past the channel)
const CARVE_SMIN_K = 40; // smooth-min blend radius (soft banks, no hard crease)

/** The uniform channel incision (m) a river of base `width` cuts below the
 * surrounding surface — the depth used when a river carries no per-vertex
 * `depths` override, and the value each GM depth grip starts at (plan 040 river
 * depths). Clamps `width` the same way the carve does so the UI default matches
 * the field exactly. */
export function riverCarveDepth(width: number): number {
  return CARVE_DEPTH_BASE + Math.max(4, width) * CARVE_DEPTH_PER_WIDTH;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** TEST SEAM ONLY: disable the carve fast-reject (bbox + occupancy grid) so every
 * sample runs the full nearest-spiral + smin. The reject is engineered to be
 * byte-identical to full evaluation (it only short-circuits where the full path
 * ALSO returns `s`); the property test flips this off to PROVE that on a dense
 * lattice. Default ON — production never touches it. */
let carveFastReject = true;
export function __setCarveFastReject(enabled: boolean): void {
  carveFastReject = enabled;
}

/**
 * Per-river coarse OCCUPANCY GRID + Chebyshev clearance transform — the
 * inside-bbox half of the far-field reject. The bbox reject only bites OUTSIDE the
 * spine's bounding box; a sample INSIDE a large meandering river's bbox but far
 * from the spine still paid the O(dist²) `nearest` spiral (measured ~79% of a
 * dense-terrain DEM-tile fill). Every cell any spine segment's BBOX overlaps is
 * marked (a conservative SUPERSET — an unmarked cell provably contains no spine
 * point), then a two-pass chessboard distance transform gives each cell its
 * Chebyshev clearance to the nearest marked cell. A query in a cell whose nearest
 * marked cell is `D` cells away has an empty `(D−1)`-ring neighbourhood, so the
 * nearest spine point is ≥ `(D−1)·cellSize` metres away — a strictly-better lower
 * bound than the bbox one, folded into the SAME byte-exact reject. */
interface SpineClearance {
  c: number; // cell size (m)
  gx0: number;
  gy0: number; // min cell indices (absolute `floor(coord/c)`)
  w: number;
  h: number;
  dist: Int32Array; // Chebyshev cells to the nearest marked (spine) cell; 0 = marked
}

function buildSpineClearance(spine: Pt[], bnd: BBox): SpineClearance | null {
  if (spine.length < 2 || !Number.isFinite(bnd.minX)) return null;
  // Cell size = the carve-hash cell, coarsened so the grid stays ≤ CAP² cells
  // (bounds the one-time transform + memory). A coarser cell is still a valid —
  // just grainier — lower bound, so correctness never depends on CAP.
  const CAP = 256;
  const span = Math.max(bnd.maxX - bnd.minX, bnd.maxY - bnd.minY);
  const c = Math.max(64, Math.ceil(span / CAP) || 1);
  const gx0 = Math.floor(bnd.minX / c);
  const gy0 = Math.floor(bnd.minY / c);
  const w = Math.floor(bnd.maxX / c) - gx0 + 1;
  const h = Math.floor(bnd.maxY / c) - gy0 + 1;
  const BIG = 1 << 29;
  const dist = new Int32Array(w * h).fill(BIG);
  for (let i = 0; i < spine.length - 1; i++) {
    const ax = spine[i][0];
    const ay = spine[i][1];
    const bx = spine[i + 1][0];
    const by = spine[i + 1][1];
    const cx0 = Math.floor(Math.min(ax, bx) / c) - gx0;
    const cx1 = Math.floor(Math.max(ax, bx) / c) - gx0;
    const cy0 = Math.floor(Math.min(ay, by) / c) - gy0;
    const cy1 = Math.floor(Math.max(ay, by) / c) - gy0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) dist[cx + cy * w] = 0;
  }
  // Forward pass: min over the 4 already-visited chessboard neighbours + 1.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = x + y * w;
      let d = dist[idx];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[idx - 1] + 1);
      if (y > 0) d = Math.min(d, dist[idx - w] + 1);
      if (x > 0 && y > 0) d = Math.min(d, dist[idx - w - 1] + 1);
      if (x < w - 1 && y > 0) d = Math.min(d, dist[idx - w + 1] + 1);
      dist[idx] = d;
    }
  }
  // Backward pass: the other 4 neighbours.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const idx = x + y * w;
      let d = dist[idx];
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[idx + 1] + 1);
      if (y < h - 1) d = Math.min(d, dist[idx + w] + 1);
      if (x < w - 1 && y < h - 1) d = Math.min(d, dist[idx + w + 1] + 1);
      if (x > 0 && y < h - 1) d = Math.min(d, dist[idx + w - 1] + 1);
      dist[idx] = d;
    }
  }
  return { c, gx0, gy0, w, h, dist };
}

interface RiverCarve {
  id: string;
  seed: number;
  /** The `makeSpine`'d sketch spine — the EXACT input the river generator's
   * `region.spine` carries, so the carve reproduces the generator's centerline. */
  spine: Spine;
  /** The RAW sketch vertices (pre-`makeSpine`) — per-vertex `depths` anchor to
   * these, the same vertices the GM's depth grips edit. */
  rawSpine: Pt[];
  params: RiverParams;
  halfWidth: number;
  /** Uniform incision (m) — the depth used at every vertex when `depths` is null. */
  uniformDepth: number;
  /** Per-vertex incision (m), aligned to `rawSpine`; null ⇒ uniform everywhere
   * (byte-identical to a river with no `depths` param). */
  depths: number[] | null;
}

/** Per-vertex carve depths aligned to the RAW sketch spine. Honoured ONLY when
 * present, all-finite, and length-matched to the sketch vertex count — a
 * malformed / mismatched array is ignored (⇒ uniform depth, byte-identical to a
 * river with no `depths` at all: the absent-param-reproduces-old-bytes rule). */
function readDepths(v: unknown, rawVertexCount: number): number[] | null {
  if (!Array.isArray(v) || v.length !== rawVertexCount || rawVertexCount < 2) return null;
  const out: number[] = [];
  for (const d of v) {
    if (typeof d !== "number" || !Number.isFinite(d)) return null;
    out.push(d);
  }
  return out;
}

function riverCarvesFromFabric(features: FabricFeature[]): RiverCarve[] {
  const out: RiverCarve[] = [];
  for (const f of features) {
    if (f.properties.kind !== "river" || f.properties.procgen?.algorithm !== "river") continue;
    if (f.geometry.type !== "LineString") continue;
    const rawSpine = f.geometry.coordinates as Pt[];
    if (!rawSpine || rawSpine.length < 2) continue;
    const id = String(f.id);
    const spine = makeSpine(id, rawSpine);
    if (spine.points.length < 2) continue;
    const p = f.properties.procgen.params as Record<string, unknown>;
    const width = Math.max(4, num(p.width, 12));
    // Full river params, parsed defensively (the durable sketch layer may be
    // malformed) — drives the SAME meandered centerline the generator paints via
    // `buildRiverCenterline`, so the trench matches the visible channel. Defaults
    // mirror the river zod schema (all 0) so an unset param reproduces old bytes.
    const params: RiverParams = {
      windiness: clamp01(num(p.windiness, 0)),
      braiding: clamp01(num(p.braiding, 0)),
      width,
      widthGrowth: Math.max(0, num(p.widthGrowth, 0)),
      braidBias: clamp01(num(p.braidBias, 0)),
      slopeSensitivity: clamp01(num(p.slopeSensitivity, 0)),
    };
    const seed = typeof f.properties.procgen.seed === "number" ? f.properties.procgen.seed : 0;
    out.push({
      id,
      seed,
      spine,
      rawSpine,
      params,
      halfWidth: width,
      uniformDepth: riverCarveDepth(width),
      depths: readDepths(p.depths, rawSpine.length),
    });
  }
  // id-sorted before the fold (FP determinism — smin is not order-independent).
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** The per-vertex depth interpolator for a carve: a pure function of the sketch
 * DEPTH FRACTION `f` (0 = source, 1 = mouth). Absent `depths` ⇒ a constant
 * `uniformDepth` (byte-identical to the pre-depths carve). Present ⇒ the depth
 * linearly interpolated between the two bracketing sketch vertices by arc-length
 * fraction (anchored on the RAW spine, the vertices the GM's grips edit), held
 * flat past the endpoints. */
function makeDepthAt(carve: RiverCarve): (f: number) => number {
  const depths = carve.depths;
  if (!depths) {
    const d = carve.uniformDepth;
    return () => d;
  }
  const raw = carve.rawSpine;
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < raw.length; i++) {
    total += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    cum.push(total);
  }
  const fr = total > 0 ? cum.map((c) => c / total) : cum.map(() => 0);
  return (f: number): number => {
    if (f <= fr[0]) return depths[0];
    const n = fr.length;
    if (f >= fr[n - 1]) return depths[n - 1];
    let j = 0;
    while (j < n - 1 && f > fr[j + 1]) j++;
    const span = fr[j + 1] - fr[j];
    const t = span > 0 ? (f - fr[j]) / span : 0;
    return depths[j] + (depths[j + 1] - depths[j]) * t;
  };
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
 * unchanged (a river far from its channel is inert).
 *
 * WATER FLOWS DOWNHILL (Jonah 2026-07-15 — the deferred 036-B grade correction,
 * now asked for): a raw `pre(v_i) − depth` bed inherits every base-fBm/valley bump
 * along the spine, so the draped river ribbon visibly climbs and dips. The bed is
 * therefore MONOTONE NON-INCREASING in flow order — the cumulative min of
 * `pre − depth` walked downstream. FLOW DIRECTION is the spine's own vertex order:
 * river.ts grows channel width with global arc-length from `spine[0]`, so
 * `spine[0]` is the (narrow) source and the last vertex the (wide) mouth; walking
 * 0→last and holding the running minimum means the bed never rises toward the
 * mouth. Confluences fall out for free — overlapping carves `smin` toward the
 * lower bed. Trade-off (accepted): a spine sketched to run uphill holds its source
 * floor as a flat canyon rather than climbing — downhill flow wins over following
 * a mis-sketched grade.
 */
function buildRiverCarve(carve: RiverCarve, pre: ElevationField): (s: HeightSample, x: number, y: number) => HeightSample {
  // Incise the MEANDERED CENTERLINE the generator paints, not the straight
  // sketched spine (plan 036-B): `buildRiverCenterline` is the ONE shared math
  // (river.ts), so the trench low-point tracks the same bends the visible channel
  // does. `pre` is the durable macro-terrain surface (base + mountain + relief +
  // landform, no carve) — the exact field the generator's slope coupling reads
  // via `macroTerrainField`, so the carve's centerline is byte-identical to the
  // generator's. Sampled at RESAMPLE_STEP_M (6 m) — finer than the old 40 m
  // densify, so the bed follows terrain at least as closely.
  const centerline = buildRiverCenterline(carve.seed, carve.spine, carve.params, pre).center;
  if (centerline.length < 2) return (s: HeightSample): HeightSample => s; // degenerate ⇒ inert
  const spine: Pt[] = centerline.map((c) => [c.x, c.y]);
  const hash = new SegmentHash(spine, { cellSize: Math.max(64, carve.halfWidth * 4) });
  const depthAt = makeDepthAt(carve);
  // Memoize the bed floor at each centerline vertex — region-scoped whole-artifact
  // pass: sample the pre-carve surface once per vertex, incise by the (GM-editable,
  // per-vertex) depth, then take the cumulative min DOWNSTREAM (centerline[0] =
  // source) so the bed is monotone non-increasing toward the mouth (water flows
  // downhill, no bumps — and no vertex's bed can climb above an upstream one,
  // regardless of the GM's per-vertex depth input). Depth is interpolated by the
  // centerline sample's arc-length fraction `f` (0 = source, 1 = mouth).
  const bedVert = new Float64Array(spine.length);
  let running = Infinity; // running min of (pre − depth) from the source downstream
  for (let i = 0; i < spine.length; i++) {
    const [vx, vy] = spine[i];
    const local = pre(vx, vy).v - depthAt(centerline[i].f);
    if (local < running) running = local;
    bedVert[i] = running;
  }
  // The bed is monotone non-increasing, so its global floor is the mouth vertex.
  // `bedMin` is the far-field reject's lower bound on the bed floor anywhere.
  const bedMin = spine.length > 0 ? bedVert[spine.length - 1] : Infinity;
  const hw = carve.halfWidth;
  const bnd = hash.bounds;
  const clearance = buildSpineClearance(spine, bnd);
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
    // `dLB` = max of two valid lower bounds on the nearest-spine distance: the
    // distance to the spine's BBOX (bites outside it), and the OCCUPANCY-GRID
    // clearance `(D−1)·cellSize` (bites INSIDE the bbox but far from the spine —
    // the ~79% the bbox reject missed). Both under-estimate the true distance, so
    // their max still does ⇒ the reject stays byte-exact.
    const dLBx = x < bnd.minX ? bnd.minX - x : x > bnd.maxX ? x - bnd.maxX : 0;
    const dLBy = y < bnd.minY ? bnd.minY - y : y > bnd.maxY ? y - bnd.maxY : 0;
    let dLB = Math.hypot(dLBx, dLBy);
    if (clearance) {
      const gx = Math.floor(x / clearance.c) - clearance.gx0;
      const gy = Math.floor(y / clearance.c) - clearance.gy0;
      if (gx >= 0 && gx < clearance.w && gy >= 0 && gy < clearance.h) {
        const d = clearance.dist[gx + gy * clearance.w]; // Chebyshev cells to nearest spine cell
        if (d >= 1) {
          const gridLB = (d - 1) * clearance.c;
          if (gridLB > dLB) dLB = gridLB;
        }
      }
    }
    if (carveFastReject && bedMin + CARVE_BANK_SLOPE * Math.max(0, dLB - hw) >= s.v + CARVE_SMIN_K) return s;
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
        // Island-from-coastline (plan 041): only sea inverts; absent/false ⇒ the
        // interior-is-sea path, byte-identical to pre-041.
        invert: p.invert === true,
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

  // REPLACE: landform lerp stamps, folded in (priority, id) order. An inverted sea
  // (plan 041 island-from-coastline) uses the ring's EXTERIOR mask so the drawn
  // coast bounds LAND and the sea fills outside; every other landform keeps the
  // interior mask (absent invert ⇒ byte-identical).
  const landforms = inc.landform
    ? landformStampsFromFabric(feats).map((s) => ({
        mask:
          s.params.mode === "sea" && s.params.invert
            ? exteriorMaskField(s.ring, s.params.band)
            : ringMaskField(s.ring, s.params.band),
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

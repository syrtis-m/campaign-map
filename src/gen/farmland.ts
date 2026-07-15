/**
 * Farmland generator — the `farmland` polygon kind. Pure/headless (no
 * DOM/map/Obsidian imports; reads only its arguments): a sketched `farmland`
 * polygon is the region; this fills it with tilled fields, a sparse lane web,
 * field-edge hedges/fences, farmstead footprints at lane junctions, and (for
 * the orchard preset) regular tree rows — everything strictly inside the
 * sketched ring.
 *
 * Five field types (a `fieldType` param, never a presetId — mirrors the city
 * algorithm's `profile` / park's `variety`): `open-field-strips` (medieval long
 * strips off a central lane), `enclosed-patchwork` (irregular hedged fields),
 * `grid-quarters` (rectilinear sections + straight section roads), `orchard`
 * (regular tree rows in a grid), and `paddy-terraces`: contour-following terrace
 * bank lines (`farm-bank`) traced by marching squares over the ELEVATION FIELD
 * the sketched mountains define (fields/mountainField.ts — a pure function of the
 * durable sketch layer via `constraints.fabricFeatures`; the raw sketch, never
 * another generator's OUTPUT) over a region-wide paddy wash. Where no usable
 * relief exists (< PADDY_MIN_RELIEF_M), banks fall back to concentric
 * interior-distance bands (terraces following the sketched boundary inward).
 * ONLY paddy-terraces reads the constraints — the four other field types never
 * touch them, so their output is identical with or without mountains.
 *
 * Design (the park/forest precedent): NOT the parcels.ts OBB splitter oriented
 * to the region. Two deviations:
 *  1. The field lattice is keyed on ABSOLUTE WORLD POSITION and aligned to the
 *     WORLD axes, not to the region's oriented bounding box. Orienting the grid
 *     to the region OBB would mean a single vertex edit changes the OBB angle
 *     and rotates the WHOLE field grid — an edit would look like a re-roll and
 *     fail the edit-locality gate. World-axis alignment keeps every interior
 *     field unchanged under an edit (forest/park's identity property).
 *     Real grid/strip farmland is axis-aligned anyway.
 *  2. Field subdivision is a self-contained recursive rectangle splitter rather
 *     than importing `parcels.subdivideBlocks`, which is tightly coupled to
 *     CityProfile / CitynessFn / BlockFace — a fake city to grow fields, more
 *     fragile than a purpose-built closed-form generator, not less (park set
 *     this precedent).
 *
 * Determinism:
 *  - Closed-form arithmetic on an absolute-world lattice; every roll comes from
 *    `hashSeed(seed, salt, …integer world indices/paths)`; every emitted
 *    coordinate is mm-quantized before it leaves.
 *  - Identity property: fields/lanes/farmsteads/trees all key on ABSOLUTE world
 *    position (lattice indices + split path), so a ring vertex edit changes only
 *    which boundary rectangles pass containment — every interior field is
 *    unchanged, while a re-roll (new seed) re-splits/re-classifies everything
 *    (edit overlap ≫ re-roll overlap).
 *  - Containment: fields aren't jittered, so a rectangle emits only when all
 *    four corners are ≥ FIELD_MARGIN_M inside the ring AND no edge crosses the
 *    boundary (a straight edge between two contained corners can still bridge a
 *    concave notch — the edge check catches it). Rim/notch-straddling fields
 *    drop → graceful degradation doubles as the concave containment guarantee.
 *  - Feature ids hash positions (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort stays stable.
 *
 * The CITY sees the farmland SKETCH (its outskirt fields are suppressed inside
 * a raw farmland ring — see `citynet/outskirts.ts`: "ring = land claim, output
 * = interior dressing", unchanged by plan 035); farmland — a STAGE-4 PERI-URBAN
 * consumer since plan 035 — sees the city's GENERATED street network
 * (`constraints.upstream.settlement`): gate lanes radiate from the arterial
 * exits and a field-size gradient runs toward the wall line (both pure
 * functions of the upstream data + absolute position, zero rng draws — no
 * upstream ⇒ byte-identical to the uncoupled generator). It also reads the raw
 * mountain SKETCH for paddy elevation. There is NO farmland → city output edge
 * (the cycle guard). Farmland-vs-city overlap is legal (overlap keys on the
 * algorithm id — MapController.overlappingRegion).
 */
import { hashSeed, mulberry32 } from "./rng";
import {
  distanceToBoundary,
  segmentCrossesBoundary,
  clipPolylineToRegion,
  type ProcgenRegion,
} from "./region";
import { marchingSquares, sdfPolygon, type Field } from "./fields";
import { macroTerrainField } from "./fields/terrain";
import { q, blobFeature } from "./waterEmit";
import { buildUpstreamConstraints, buildUpstreamWaterField, insideUpstreamChannel, splitLineOutsideChannel } from "./upstream";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const FARMLAND_TYPES = [
  "open-field-strips",
  "enclosed-patchwork",
  "grid-quarters",
  "orchard",
  "paddy-terraces",
] as const;
export type FarmlandType = (typeof FARMLAND_TYPES)[number];

export const HEDGING_KINDS = ["none", "fences", "hedgerows"] as const;
export type Hedging = (typeof HEDGING_KINDS)[number];

/** Farmland params. `fieldType` drives layout AND is carried
 * onto every feature for theme tinting (never a presetId branch). `fieldSize`
 * 0–1 scales the base field dimension; `hedging` picks field-edge treatment;
 * `laneDensity` 0–1 scales the lane web; `farmsteads` 0–1 is the per-junction
 * chance of a farm building cluster. */
export interface FarmlandParams {
  fieldType: FarmlandType;
  fieldSize: number;
  hedging: Hedging;
  laneDensity: number;
  farmsteads: number;
}

// Base field dimension (world meters): fieldSize 0 → ~44 m smallholdings,
// 1 → ~150 m sections. The coarse world lattice everything keys on.
const FIELD_MIN_M = 44;
const FIELD_MAX_M = 150;
// Containment margin (meters) — fields aren't jittered, so a few meters of
// slack keeps a straight field edge clear of the boundary.
const FIELD_MARGIN_M = 3;
const LANE_HALF_M = 2.5; // farm-lane / section-road half-width
const HEDGE_QUANT_M = 0.5; // shared-edge dedup bucket for hedges
const FARMSTEAD_M = 9; // farm building footprint size
const ORCHARD_ROW_M = 13; // orchard tree row/column spacing (regular rows, kept light)
const STRIP_COUNT = 4; // strips per coarse cell (open-field-strips)
const PATCHWORK_MAX_DEPTH = 3; // recursive split cap (D3 budget, not convergence)
// ── Peri-urban coupling (plan 035) ───────────────────────────────────────────
// Farmland is a STAGE-4 consumer of the generated city street network
// (`constraints.upstream.settlement` — stage-3 output as DATA). Two reads, both
// pure functions of that data + absolute world position (ZERO rng draws), so a
// farmland with NO upstream is byte-identical to the uncoupled generator
// through the same arithmetic:
//  1. GATE LANES — where a generated ARTERIAL ends against this region's ring
//     (city output is clipped to ITS district, so an arterial exits by ENDING
//     at the shared boundary rather than crossing into ours), a fan of lanes
//     runs from that gate into the lane web: field access radiates from the
//     city gates.
//  2. FIELD-SIZE GRADIENT — coarse cells whose center is within NEAR_CITY_M of
//     the city fabric subdivide one step finer (market gardens against the
//     wall line, full sections further out — the von Thünen ring).
/** An arterial vertex this near the farmland ring (projected) is a gate entry. */
const GATE_ENTRY_THRESH_M = 45;
/** Entries closer than this collapse to one (first in feature order wins). */
const GATE_ENTRY_DEDUPE_M = 40;
/** Lanes fanning from each gate entry to the nearest lane-web junctions. */
const GATE_LANE_FAN = 2;
/** Field-size gradient reach, meters from the nearest generated street. */
const NEAR_CITY_M = 240;
// ── Paddy terraces ───────────────────────────────────────────────────────────
// World-aligned marching-squares lattice for the terrace banks. Finer than the
// mountain's 20 m contour lattice — banks are field-scale features and the run
// is explicit + cached, never per-frame. ABSOLUTE-world (seam rule + edits stay
// local for the elevation-coupled case: the field ignores the farmland ring).
const PADDY_LATTICE_M = 10;
// Deterministic relief scan lattice (coarse; picks the bank interval).
const PADDY_SCAN_M = 40;
// Below this much relief inside the region, the elevation field is effectively
// flat here (region doesn't meaningfully overlap a mountain) → concentric
// interior-distance fallback bands.
const PADDY_MIN_RELIEF_M = 8;
// Bank cadence: smallest "nice" ladder step giving ≤ TARGET bands across the
// scanned range (adaptive interval — consistent visual density
// whatever the relief/region size). Shared by both the elevation levels
// (meters of height) and the fallback bands (meters of inward distance).
// The ladder is deliberately CAPPED at 25 m: terraces are agricultural steps,
// not topo iso-lines — on a big alpine overlap an uncapped ladder converges on
// the mountain contours' own 50/100 m cadence and the banks just DUPLICATE the
// contour layer (caught on the first gate screenshots). Capped, paddy banks
// always read denser than the relief's topo lines; steeper relief honestly
// means more terraces.
const PADDY_TARGET_BANDS = 14;
const PADDY_INTERVAL_LADDER = [1, 2, 5, 10, 20, 25] as const;
// ── Riverine long-lots (Quebec rang / arpent — plan 038 item 2) ──────────────
// Where the GENERATED river channel is present, the fields WITHIN ~1–2 field
// depths of the bank become long, narrow lots run PERPENDICULAR to the water
// (the rang pattern): each holding fronts the river and stretches inland. The
// wettest riparian sub-band (the near end of each lot) carries a `waterMeadow`
// tag (a theme-painted property — flood-meadow / grazing marsh). All keyed on
// the bank geometry + absolute position (no rng); `channel === null` (no
// upstream water) ⇒ the whole path is skipped and farmland is byte-identical to
// the uncoupled generator. paddy-terraces is excluded (its riverine culture is
// terraced paddies, not rangs — the wash/contour banks own that band).
const RANG_ARPENT_MIN_M = 12; // narrowest long-lot width (river frontage)
const RANG_LEN_CAP_M = 180; // deepest a long-lot reaches inland (≈1–2 field depths)
const RANG_WM_FRAC = 0.42; // near fraction of each lot tagged `waterMeadow`
const RANG_BASE_OFFSET_M = 2; // start the lot just inland of the bank (field < 0)
// ── Slope-gating (plan 038 item 4, needs 036) ────────────────────────────────
// A field whose ground is too steep to plough is left as untilled PASTURE (a
// `crop: "pasture"` + `pasture: true` tag themes can paint rough grazing). The
// slope is |∇terrain| from the MACRO terrain field (mountains + base) — 0 on
// flat ground, so a flat campaign/region never tags a field ⇒ byte-identical to
// the uncoupled generator with no explicit relief gate. (Contour-ORIENTED strips
// on moderate slopes are deferred: orienting a field to the local gradient
// conflicts with farmland's world-aligned edit-locality invariant — deviation #1.)
const FARM_STEEP_SLOPE = 0.3; // |∇elev| (m/m, ≈17°) above which tillage → pasture

/** Nice-round bank interval for a scanned range `maxV`. Smallest ladder step
 * giving ≤ PADDY_TARGET_BANDS bands; the coarsest as a floor. */
function paddyInterval(maxV: number): number {
  const raw = maxV / PADDY_TARGET_BANDS;
  for (const step of PADDY_INTERVAL_LADDER) if (step >= raw) return step;
  return PADDY_INTERVAL_LADDER[PADDY_INTERVAL_LADDER.length - 1];
}

function fieldCellM(fieldSize: number): number {
  const f = Math.min(1, Math.max(0, fieldSize));
  return FIELD_MIN_M + f * (FIELD_MAX_M - FIELD_MIN_M);
}

/** All four corners ≥ margin inside the ring AND no edge crosses the boundary
 * (concave-safe). Rectangles are convex, so a vertex-plus-edge check is a full
 * containment guarantee. `rect` is an OPEN 4-corner list (world meters). */
function rectContained(region: ProcgenRegion, rect: Pt[], margin: number): boolean {
  for (const [x, y] of rect) {
    if (distanceToBoundary(region, x, y) < margin) return false;
  }
  for (let i = 0; i < rect.length; i++) {
    const a = rect[i];
    const b = rect[(i + 1) % rect.length];
    if (segmentCrossesBoundary(region, a[0], a[1], b[0], b[1])) return false;
  }
  return true;
}

/** Does a world-axis rectangle touch the generated river channel (plan 037)?
 * Samples the four corners, the center, and the four edge midpoints — a field
 * (44–150 m) that straddles a ~20–50 m channel has at least one of these inside.
 * `channel === null` (no upstream water) ⇒ always false ⇒ byte-identical to the
 * uncoupled generator. */
function rectHitsChannel(rect: Pt[], channel: Field | null): boolean {
  if (channel === null) return false;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of rect) {
    if (channel(x, y) >= 0) return true;
    cx += x;
    cy += y;
  }
  if (channel(cx / rect.length, cy / rect.length) >= 0) return true;
  for (let i = 0; i < rect.length; i++) {
    const a = rect[i];
    const b = rect[(i + 1) % rect.length];
    if (channel((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) >= 0) return true;
  }
  return false;
}

/** Resample a polyline to ≤ `step` m segments (so a vertex-granular channel
 * split catches a crossing between far-apart lane endpoints). Endpoints
 * preserved. Used only on the coupled (upstream-present) path. */
function resampleLine(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** A closed, mm-quantized field polygon from an OPEN rect corner list. */
function fieldFeature(seed: number, rect: Pt[], props: Record<string, unknown>): GeoJSON.Feature {
  const ring: Pt[] = rect.map(([x, y]) => [q(x), q(y)] as Pt);
  ring.push([ring[0][0], ring[0][1]]);
  return blobFeature(seed, "farm-field", ring, props);
}

/** A world-axis rectangle from its min/max corners (CCW open list). */
function rectOf(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Recursively split a world-axis rectangle into sub-rectangles, keyed on the
 * coarse cell's world indices + the split path (so the whole sub-tree is
 * position-derived → inherits the base lattice's edit-locality). Irregular
 * patchwork: hashed cut axis + fraction; stops at a min size / depth cap.
 */
function patchworkSplit(
  seed: number,
  ix: number,
  iy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minM: number,
  path: string,
  out: Pt[][],
  maxDepth: number = PATCHWORK_MAX_DEPTH
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  const rng = mulberry32(hashSeed(seed, "farm-split", ix, iy, path.length, path.charCodeAt(path.length - 1) || 0));
  const canSplit = path.length < maxDepth && Math.max(w, h) > minM * 1.6;
  // A hashed chance to stop early even when splittable — the varied field sizes.
  if (!canSplit || rng() < 0.28) {
    out.push(rectOf(x0, y0, x1, y1));
    return;
  }
  const cutAlongX = w >= h; // cut the long side
  const frac = 0.38 + rng() * 0.24; // 38–62% cut
  if (cutAlongX) {
    const cx = x0 + w * frac;
    patchworkSplit(seed, ix, iy, x0, y0, cx, y1, minM, path + "0", out, maxDepth);
    patchworkSplit(seed, ix, iy, cx, y0, x1, y1, minM, path + "1", out, maxDepth);
  } else {
    const cy = y0 + h * frac;
    patchworkSplit(seed, ix, iy, x0, y0, x1, cy, minM, path + "0", out, maxDepth);
    patchworkSplit(seed, ix, iy, x0, cy, x1, y1, minM, path + "1", out, maxDepth);
  }
}

/** Deterministic crop variety for a field, keyed on its world position — a
 * theme-texture hook (`crop` property), never a paint branch in the generator. */
const CROPS = ["wheat", "barley", "fallow", "pasture", "root"] as const;
function cropAt(seed: number, ix: number, iy: number, sub: number): string {
  const r = mulberry32(hashSeed(seed, "farm-crop", ix, iy, sub))();
  return CROPS[Math.min(CROPS.length - 1, Math.floor(r * CROPS.length))];
}

/**
 * Generate farmland inside a sketched polygon region. Emits `farm-field`
 * polygons (+ `crop`/`fieldType` props), `farm-lane` lines, `farm-hedge` lines,
 * `farm-building` footprints, (orchard) `orchard-tree` points and
 * (paddy-terraces) `farm-bank` terrace lines — all strictly inside
 * `region.ring`. `constraints` feed ONE thing: the sketched MOUNTAIN features,
 * from which paddy-terraces composes its elevation field (the raw sketch layer —
 * farmland never sees the city or any other generator's output). The four other
 * field types never read the constraints at all.
 */
export function generateFarmland(
  seed: number,
  region: ProcgenRegion,
  params: FarmlandParams,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { fieldType, fieldSize, hedging, laneDensity, farmsteads } = params;
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  const cell = fieldCellM(fieldSize);
  // River channel (plan 037): the generated meandered channel as an SDF
  // (positive inside). null with no upstream water ⇒ every coupled path below is
  // a no-op and the farmland is byte-identical to the uncoupled generator. No
  // field/lane/bank geometry crosses the channel. A stage-0 OUTPUT edge (added
  // to `consumes`), never a raw sketch read.
  const channel = buildUpstreamWaterField(constraints.upstream);
  // Riverine long-lot band (plan 038 item 2): a lot reaches ~1.6 cells inland,
  // capped. Non-paddy field types near the bank become rang lots — the normal
  // lattice fields there are suppressed (below) so the two never double-paint.
  const rangEnabled = channel !== null && fieldType !== "paddy-terraces";
  const rangLen = Math.min(1.6 * cell, RANG_LEN_CAP_M);
  /** A point in the riparian band: outside the channel but within `rangLen` of
   * the bank. Always false with no channel (byte-identity). */
  const inRangBand = (x: number, y: number): boolean => {
    if (channel === null) return false;
    const v = channel(x, y);
    return v < 0 && v > -rangLen;
  };
  // Slope-gating terrain (plan 038 item 4): the macro terrain field, for the
  // non-paddy field types (paddy reads it separately, below). null on a flat
  // campaign ⇒ no field is ever re-tagged (byte-identical).
  const slopeTerrain = fieldType !== "paddy-terraces" ? macroTerrainField(constraints.fabricFeatures) : null;
  const LANE_STEP_M = 8; // resample step for lane channel-splitting (coupled path only)
  /** Emit a lane run, truncated at the channel when there is upstream water. */
  const emitLaneRun = (run: Pt[]): void => {
    if (channel === null) {
      if (run.length >= 2) out.push(laneLine(seed, run, fieldType));
      return;
    }
    for (const piece of splitLineOutsideChannel(resampleLine(run, LANE_STEP_M), channel)) {
      if (piece.length >= 2) out.push(laneLine(seed, piece, fieldType));
    }
  };

  // ── Peri-urban read (plan 035): the generated city street network as DATA.
  //    `streetSegs` drive the field-size gradient; `arterials` mint the gate
  //    entries. Empty when there is no upstream — every coupled step below is
  //    then a no-op through the same arithmetic (byte-identity). Feature order
  //    is the host's `(stage, id)`-deterministic collection order.
  const streetSegs: [Pt, Pt][] = [];
  const arterials: Pt[][] = [];
  for (const f of constraints.upstream?.settlement ?? []) {
    const g = f.geometry;
    if (!g || g.type !== "LineString") continue;
    // A city canal rides in `settlement` (plan 038 item 8) so the wall can read
    // it as water; it is NOT a street — skip it here so field-size gradient +
    // gate lanes never treat a canal line as city fabric (byte-neutral: canals
    // were simply absent from `settlement` before the wall-water wiring).
    if ((f.properties as { type?: string } | null)?.type === "canal") continue;
    const line = g.coordinates as Pt[];
    if (line.length < 2) continue;
    for (let i = 0; i + 1 < line.length; i++) streetSegs.push([line[i], line[i + 1]]);
    if ((f.properties as { roadClass?: string } | null)?.roadClass === "arterial") arterials.push(line);
  }
  const distToCity = (x: number, y: number): number => {
    let best = Infinity;
    for (const [a, b] of streetSegs) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
      if (d < best) best = d;
    }
    return best;
  };
  /** Field-size gradient predicate, evaluated ONCE per coarse cell center —
   * pure f(upstream data, absolute position), zero rng draws. */
  const cellNearCity = (cx: number, cy: number): boolean =>
    streetSegs.length > 0 && distToCity(cx, cy) <= NEAR_CITY_M;

  const ix0 = Math.floor(bbox.minX / cell) - 1;
  const ix1 = Math.ceil(bbox.maxX / cell) + 1;
  const iy0 = Math.floor(bbox.minY / cell) - 1;
  const iy1 = Math.ceil(bbox.maxY / cell) + 1;

  // Hedges dedup shared field edges (a boundary shared by two fields would else
  // double-paint). Keyed on the quantized endpoint pair (order-independent).
  const hedgeSeen = new Set<string>();
  const wantHedges = hedging !== "none";
  const emitHedge = (a: Pt, b: Pt): void => {
    if (!wantHedges) return;
    const ka = `${Math.round(a[0] / HEDGE_QUANT_M)},${Math.round(a[1] / HEDGE_QUANT_M)}`;
    const kb = `${Math.round(b[0] / HEDGE_QUANT_M)},${Math.round(b[1] / HEDGE_QUANT_M)}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (hedgeSeen.has(key)) return;
    hedgeSeen.add(key);
    // Only the run inside the region (a shared interior edge is fully inside;
    // an outer edge near the rim clips cleanly). Position-hashed id.
    for (const run of clipPolylineToRegion(region, [a, b])) {
      if (run.length < 2) continue;
      out.push({
        type: "Feature",
        id: hashSeed(seed, "farm-hedge", q(run[0][0]), q(run[0][1]), q(run[run.length - 1][0]), q(run[run.length - 1][1])),
        geometry: { type: "LineString", coordinates: run.map(([x, y]) => [q(x), q(y)] as Pt) },
        properties: { generatorId: "farm-hedge", type: "farm-hedge", fieldType, hedging },
      });
    }
  };

  const emitField = (ix: number, iy: number, sub: number, rect: Pt[]): void => {
    if (!rectContained(region, rect, FIELD_MARGIN_M)) return;
    if (rectHitsChannel(rect, channel)) return; // no field across the channel (plan 037)
    // Riverine long-lots (plan 038 item 2): a lattice field whose CENTER sits in
    // the riparian band is replaced by the perpendicular rang lots emitted below
    // — suppress it here so they don't overlap. Gated on `rangEnabled` ⇒ no-op
    // (byte-identical) with no upstream channel.
    const fcx = (rect[0][0] + rect[2][0]) / 2;
    const fcy = (rect[0][1] + rect[2][1]) / 2;
    if (rangEnabled && inRangBand(fcx, fcy)) return;
    const props: Record<string, unknown> = { crop: cropAt(seed, ix, iy, sub), fieldType };
    // Slope-gating (plan 038 item 4): steep ground is untilled pasture. Slope 0
    // (flat) ⇒ never tagged ⇒ byte-identical.
    if (slopeTerrain) {
      const g = slopeTerrain(fcx, fcy);
      if (Math.hypot(g.dx, g.dy) > FARM_STEEP_SLOPE) {
        props.crop = "pasture";
        props.pasture = true;
      }
    }
    out.push(fieldFeature(seed, rect, props));
    for (let i = 0; i < rect.length; i++) emitHedge(rect[i], rect[(i + 1) % rect.length]);
  };

  // ── Fields on the absolute-world lattice, subdivided per fieldType ─────────
  // Strips run along a CONSTANT world axis (X), never the region's longer bbox
  // axis: a bbox-derived orientation would flip when a vertex edit changes which
  // axis dominates, re-orienting EVERY strip → an edit indistinguishable from a
  // re-roll (the same trap the docstring's deviation #1 avoids for the lattice).
  // A furlong is `cell` long × `cell/STRIP_COUNT` deep regardless of region
  // shape, so a fixed axis reads as proper open-field strips and keeps the
  // identity property total for all four presets. (Medieval strips are
  // axis-aligned anyway; a manor's furlong orientation is arbitrary.)
  const stripAlongX = true;
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      const x0 = ix * cell;
      const y0 = iy * cell;
      const x1 = x0 + cell;
      const y1 = y0 + cell;
      // Field-size gradient (plan 035): a cell against the city fabric splits
      // one step finer. `near` is a pure function of the cell center + the
      // upstream data — ALWAYS false with no upstream, so the uncoupled paths
      // below are bit-unchanged.
      const near = cellNearCity(x0 + cell / 2, y0 + cell / 2);
      if (fieldType === "enclosed-patchwork") {
        const pieces: Pt[][] = [];
        // Near the city: a finer min size + one more split level — smaller,
        // denser closes. Same hashes (node rngs key on ix/iy/path), so the
        // shared split-tree PREFIX is identical; only depth extends.
        patchworkSplit(
          seed, ix, iy, x0, y0, x1, y1,
          cell * (near ? 0.24 : 0.42), "r", pieces,
          near ? PATCHWORK_MAX_DEPTH + 1 : PATCHWORK_MAX_DEPTH
        );
        pieces.forEach((rect, si) => emitField(ix, iy, si, rect));
      } else if (fieldType === "open-field-strips") {
        // Long thin strips along the longer world axis (one furlong per cell).
        for (let k = 0; k < STRIP_COUNT; k++) {
          const rect = stripAlongX
            ? rectOf(x0, y0 + (cell * k) / STRIP_COUNT, x1, y0 + (cell * (k + 1)) / STRIP_COUNT)
            : rectOf(x0 + (cell * k) / STRIP_COUNT, y0, x0 + (cell * (k + 1)) / STRIP_COUNT, y1);
          if (near) {
            // Half-length furlongs against the wall line. Sub indices offset
            // past the uncoupled 0..STRIP_COUNT-1 range (distinct crop rolls).
            const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
            const halves = stripAlongX
              ? [rectOf(rect[0][0], rect[0][1], mx, rect[2][1]), rectOf(mx, rect[0][1], rect[2][0], rect[2][1])]
              : [rectOf(rect[0][0], rect[0][1], rect[2][0], my), rectOf(rect[0][0], my, rect[2][0], rect[2][1])];
            halves.forEach((h, hi) => emitField(ix, iy, 100 + k * 2 + hi, h));
          } else {
            emitField(ix, iy, k, rect);
          }
        }
      } else if (fieldType === "grid-quarters" || fieldType === "orchard") {
        // grid-quarters / orchard: one rectilinear section per cell — quartered
        // against the city fabric (the market-garden scale).
        // (paddy-terraces skips the rectangle lattice entirely — its fields
        // are the wash + contour banks below.)
        if (near) {
          const mx = x0 + cell / 2;
          const my = y0 + cell / 2;
          const quarters = [
            rectOf(x0, y0, mx, my),
            rectOf(mx, y0, x1, my),
            rectOf(x0, my, mx, y1),
            rectOf(mx, my, x1, y1),
          ];
          quarters.forEach((qr, qi) => emitField(ix, iy, 100 + qi, qr));
        } else {
          emitField(ix, iy, 0, rectOf(x0, y0, x1, y1));
        }
      }
    }
  }

  // ── Riverine long-lots (Quebec rang / arpent — plan 038 item 2): along each
  //    generated river bank, narrow holdings run PERPENDICULAR to the water and
  //    stretch ~rangLen inland (fronting the river). Each lot splits into a near
  //    `waterMeadow` cell (flood meadow) + a far tilled cell. Determinism: the
  //    bank ring is walked by arc length (pure geometry), the inland direction is
  //    the channel SDF's downhill gradient (pure f(channel)), the crop keys on
  //    the quantized base position — zero rng. Only non-paddy types, only with an
  //    upstream channel ⇒ byte-identical to the uncoupled generator otherwise. ──
  if (rangEnabled) {
    const banks = buildUpstreamConstraints(constraints.upstream).waterRings;
    const arpentW = Math.max(RANG_ARPENT_MIN_M, cell * 0.18);
    const halfW = arpentW / 2;
    const wmLen = rangLen * RANG_WM_FRAC;
    // Inland unit direction at (x,y): the channel SDF (positive inside) DECREASES
    // away from the water, so −∇channel points inland. Central differences.
    const inward = (x: number, y: number): Pt => {
      const e = 1;
      const gx = channel!(x + e, y) - channel!(x - e, y);
      const gy = channel!(x, y + e) - channel!(x, y - e);
      const l = Math.hypot(gx, gy) || 1;
      return [-gx / l, -gy / l];
    };
    const emitLotCell = (p0: Pt, p1: Pt, t: Pt, sub: number, waterMeadow: boolean): void => {
      const corners: Pt[] = [
        [p0[0] - t[0] * halfW, p0[1] - t[1] * halfW],
        [p1[0] - t[0] * halfW, p1[1] - t[1] * halfW],
        [p1[0] + t[0] * halfW, p1[1] + t[1] * halfW],
        [p0[0] + t[0] * halfW, p0[1] + t[1] * halfW],
      ];
      if (!rectContained(region, corners, FIELD_MARGIN_M)) return;
      if (rectHitsChannel(corners, channel)) return;
      const ci = Math.round(p0[0] / cell);
      const cj = Math.round(p0[1] / cell);
      const props: Record<string, unknown> = {
        crop: waterMeadow ? "water-meadow" : cropAt(seed, ci, cj, sub),
        fieldType,
        bankLot: true,
      };
      if (waterMeadow) props.waterMeadow = true;
      out.push(fieldFeature(seed, corners, props));
    };
    const grow = rangLen + arpentW;
    for (const ring of banks) {
      // Arc-length carry so lots are spaced `arpentW` continuously across the
      // whole bank (not restarted per segment).
      let carry = 0;
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        // Skip bank segments far from this farmland region (perf; correctness is
        // still guarded by rectContained).
        if (
          Math.max(a[0], b[0]) < bbox.minX - grow ||
          Math.min(a[0], b[0]) > bbox.maxX + grow ||
          Math.max(a[1], b[1]) < bbox.minY - grow ||
          Math.min(a[1], b[1]) > bbox.maxY + grow
        ) {
          carry = 0;
          continue;
        }
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (segLen <= 0) continue;
        const tx = (b[0] - a[0]) / segLen;
        const ty = (b[1] - a[1]) / segLen;
        for (let s = arpentW - carry; s < segLen; s += arpentW) {
          const bx = a[0] + tx * s;
          const by = a[1] + ty * s;
          const d = inward(bx, by);
          const base: Pt = [bx + d[0] * RANG_BASE_OFFSET_M, by + d[1] * RANG_BASE_OFFSET_M];
          const mid: Pt = [base[0] + d[0] * wmLen, base[1] + d[1] * wmLen];
          const tip: Pt = [base[0] + d[0] * rangLen, base[1] + d[1] * rangLen];
          const t: Pt = [tx, ty];
          emitLotCell(base, mid, t, 0, true); // riparian water-meadow (near)
          emitLotCell(mid, tip, t, 1, false); // tilled long-lot (far)
        }
        carry = (carry + segLen) % arpentW;
      }
    }
  }

  // ── Paddy terraces: a region-wide paddy wash + contour-following terrace
  //    banks. Bank lines are marching-squares iso-lines (world-aligned lattice
  //    → seam-safe) over the elevation field composed from the SKETCHED
  //    mountains; where that field is essentially flat inside this region,
  //    concentric interior-distance bands (the no-mountain fallback).
  //    Determinism: elevation is f(mountain seeds/params/rings) and the
  //    fallback is f(region ring); both are pure functions of durable inputs.
  //    Containment: every traced line is clipped to the ring (the linear
  //    lattice interpolant can nick a curved boundary). ──────────────────────
  if (fieldType === "paddy-terraces") {
    // The wash IS the ring (mountain-massif precedent: contained by
    // construction, already normalized; mm-quantized on emit).
    const washRing: Pt[] = region.ring.map(([x, y]) => [q(x), q(y)] as Pt);
    out.push(blobFeature(seed, "farm-field", washRing, { crop: "paddy", fieldType }));

    // Candidate bank field #1: the durable MACRO terrain (mountains + base) read
    // through the one composed source of truth (`terrainAt` via
    // `macroTerrainField`) — bit-exact drop-in for `elevationFieldFromFabric`
    // (mountain-only ⇒ byte-identical; no relief/landform/carve coupling).
    const elev = macroTerrainField(constraints.fabricFeatures);
    // Deterministic relief scan: world-aligned coarse lattice, contained nodes
    // only (pure f(region, field) — no RNG, no iteration-to-convergence).
    const scan = (f: (x: number, y: number) => number): number => {
      let max = 0;
      const sx0 = Math.floor(bbox.minX / PADDY_SCAN_M) * PADDY_SCAN_M;
      const sy0 = Math.floor(bbox.minY / PADDY_SCAN_M) * PADDY_SCAN_M;
      for (let x = sx0; x <= bbox.maxX; x += PADDY_SCAN_M) {
        for (let y = sy0; y <= bbox.maxY; y += PADDY_SCAN_M) {
          if (distanceToBoundary(region, x, y) <= 0) continue;
          const v = f(x, y);
          if (v > max) max = v;
        }
      }
      return max;
    };
    const elevValue = elev ? (x: number, y: number): number => elev(x, y).v : null;
    const relief = elevValue ? scan(elevValue) : 0;
    // Pick the bank field: real relief → elevation contours; else concentric
    // interior-distance bands (sdf is + inside — same marching machinery).
    const useElev = elevValue !== null && relief >= PADDY_MIN_RELIEF_M;
    const bankField = useElev ? elevValue! : sdfPolygon(region.ring);
    const maxV = useElev ? relief : scan(bankField);
    const interval = paddyInterval(maxV);
    const levels: number[] = [];
    for (let lv = interval; lv < maxV; lv += interval) levels.push(lv);
    if (levels.length > 0) {
      for (const c of marchingSquares(bankField, { bbox, step: PADDY_LATTICE_M, levels })) {
        // Position-derived ids (never emission order): the level (dm) + the
        // clipped run's mm first vertex at 0.1 m resolution.
        const levelKey = Math.round(c.level * 10);
        for (const clipped of clipPolylineToRegion(region, c.points)) {
          // No terrace bank runs through the channel (plan 037); the contour
          // lattice is already dense (10 m) so a vertex-granular split suffices.
          for (const run of splitLineOutsideChannel(clipped, channel)) {
          if (run.length < 2) continue;
          const coords = run.map(([x, y]) => [q(x), q(y)] as Pt);
          const [fx, fy] = coords[0];
          out.push({
            type: "Feature",
            id: hashSeed(seed, "farm-bank", levelKey, Math.round(fx * 10), Math.round(fy * 10)),
            geometry: { type: "LineString", coordinates: coords },
            properties: {
              generatorId: "farm-bank",
              type: "farm-bank",
              fieldType,
              // Meters of height (coupled) or inward distance (fallback) — a
              // theme/debug hook, mirrors mountain-contour's `elevation`.
              elevation: Math.round(c.level),
            },
          });
          }
        }
      }
    }
  }

  // ── Lane web: coarse-grid lines, sparser as laneDensity drops, clipped to
  //    the region. Every field type gets straight section lanes (medieval
  //    strips run off them; the grid's are its section roads). ───────────────
  const laneEvery = laneDensity >= 0.66 ? 1 : laneDensity >= 0.33 ? 2 : 3;
  const laneXs: number[] = [];
  const laneYs: number[] = [];
  for (let ix = ix0; ix <= ix1; ix++) {
    if (((ix % laneEvery) + laneEvery) % laneEvery !== 0) continue;
    const x = ix * cell;
    laneXs.push(x);
    for (const run of clipPolylineToRegion(region, [[x, bbox.minY - cell], [x, bbox.maxY + cell]])) {
      emitLaneRun(run);
    }
  }
  for (let iy = iy0; iy <= iy1; iy++) {
    if (((iy % laneEvery) + laneEvery) % laneEvery !== 0) continue;
    const y = iy * cell;
    laneYs.push(y);
    for (const run of clipPolylineToRegion(region, [[bbox.minX - cell, y], [bbox.maxX + cell, y]])) {
      emitLaneRun(run);
    }
  }

  // ── Gate lanes (plan 035): where a generated ARTERIAL ends against this
  //    ring, a fan of lanes runs from that gate into the lane web — field
  //    access radiates from the city gates. The entry is the ring-projection of
  //    the arterial's nearest vertex (within GATE_ENTRY_THRESH_M); junction
  //    ranking is distance with a coordinate tiebreak (deterministic); every
  //    lane clips to the region; ids are `laneLine`'s position hashes. Empty
  //    arterials ⇒ nothing (the no-upstream byte-identity). ───────────────────
  if (arterials.length > 0) {
    const ring = region.ring; // closed (first === last)
    const projectToRing = (p: Pt): { pt: Pt; d: number } => {
      let best: { pt: Pt; d: number } = { pt: p, d: Infinity };
      for (let j = 0; j + 1 < ring.length; j++) {
        const a = ring[j];
        const b = ring[j + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a[0] + t * dx;
        const py = a[1] + t * dy;
        const d = Math.hypot(p[0] - px, p[1] - py);
        if (d < best.d) best = { pt: [px, py], d };
      }
      return best;
    };
    const entries: Pt[] = [];
    for (const line of arterials) {
      let best: { pt: Pt; d: number } | null = null;
      for (const v of line) {
        const pr = projectToRing(v);
        if (!best || pr.d < best.d) best = pr;
      }
      if (!best || best.d > GATE_ENTRY_THRESH_M) continue;
      const e = best.pt;
      if (entries.some(([ex, ey]) => Math.hypot(ex - e[0], ey - e[1]) < GATE_ENTRY_DEDUPE_M)) continue;
      entries.push(e);
    }
    if (entries.length > 0 && laneXs.length > 0 && laneYs.length > 0) {
      const junctions: Pt[] = [];
      for (const x of laneXs) for (const y of laneYs) junctions.push([x, y]);
      for (const e of entries) {
        const ranked = junctions
          .map((j) => ({ j, d: Math.hypot(j[0] - e[0], j[1] - e[1]) }))
          .sort((a, b) => a.d - b.d || a.j[0] - b.j[0] || a.j[1] - b.j[1]);
        for (const { j } of ranked.slice(0, GATE_LANE_FAN)) {
          for (const run of clipPolylineToRegion(region, [e, j])) emitLaneRun(run);
        }
      }
    }
  }

  // ── Farmsteads: at lane junctions, a position-hashed cluster of 1–2 building
  //    footprints when the roll clears (1 − farmsteads). ──────────────────────
  if (farmsteads > 0) {
    for (const x of laneXs) {
      for (const y of laneYs) {
        const ix = Math.round(x / cell);
        const iy = Math.round(y / cell);
        const rng = mulberry32(hashSeed(seed, "farm-stead", ix, iy));
        if (rng() >= farmsteads) continue;
        const n = 1 + (rng() < 0.5 ? 0 : 1);
        for (let b = 0; b < n; b++) {
          // Offset into the quadrant off the junction so the building sits in a
          // field, not on the lane crossing.
          const ox = (rng() < 0.5 ? 1 : -1) * (LANE_HALF_M + FARMSTEAD_M * (0.7 + rng()));
          const oy = (rng() < 0.5 ? 1 : -1) * (LANE_HALF_M + FARMSTEAD_M * (0.7 + rng()));
          const cx = x + ox;
          const cy = y + oy;
          const half = FARMSTEAD_M / 2;
          const rect = rectOf(cx - half, cy - half, cx + half, cy + half);
          if (!rectContained(region, rect, FIELD_MARGIN_M)) continue;
          if (rectHitsChannel(rect, channel)) continue; // no farmstead in the channel
          const ring: Pt[] = rect.map(([px, py]) => [q(px), q(py)] as Pt);
          ring.push([ring[0][0], ring[0][1]]);
          out.push({
            type: "Feature",
            id: hashSeed(seed, "farm-building", ix, iy, b),
            geometry: { type: "Polygon", coordinates: [ring] },
            properties: { generatorId: "farm-building", type: "farm-building", fieldType },
          });
        }
      }
    }
  }

  // ── Orchard trees: regular row-grid of points inside the region (orchard
  //    fieldType only), on the absolute-world lattice so rows are edit-local. ─
  if (fieldType === "orchard") {
    const rx0 = Math.floor(bbox.minX / ORCHARD_ROW_M) - 1;
    const rx1 = Math.ceil(bbox.maxX / ORCHARD_ROW_M) + 1;
    const ry0 = Math.floor(bbox.minY / ORCHARD_ROW_M) - 1;
    const ry1 = Math.ceil(bbox.maxY / ORCHARD_ROW_M) + 1;
    for (let ix = rx0; ix <= rx1; ix++) {
      for (let iy = ry0; iy <= ry1; iy++) {
        const px = ix * ORCHARD_ROW_M;
        const py = iy * ORCHARD_ROW_M;
        if (distanceToBoundary(region, px, py) < FIELD_MARGIN_M) continue;
        if (insideUpstreamChannel(channel, px, py)) continue; // no orchard tree in the channel
        // Skip trees sitting on a lane (leave the section roads clear).
        if (nearLane(px, py, laneXs, laneYs, LANE_HALF_M + 1)) continue;
        out.push({
          type: "Feature",
          id: hashSeed(seed, "orchard-tree", ix, iy),
          geometry: { type: "Point", coordinates: [q(px), q(py)] },
          properties: { generatorId: "orchard-tree", type: "orchard-tree", fieldType },
        });
      }
    }
  }

  return out;
}

function laneLine(seed: number, run: Pt[], fieldType: FarmlandType): GeoJSON.Feature {
  const coords = run.map(([x, y]) => [q(x), q(y)] as Pt);
  return {
    type: "Feature",
    id: hashSeed(seed, "farm-lane", coords[0][0], coords[0][1], coords[coords.length - 1][0], coords[coords.length - 1][1]),
    geometry: { type: "LineString", coordinates: coords },
    properties: { generatorId: "farm-lane", type: "farm-lane", fieldType },
  };
}

function nearLane(x: number, y: number, laneXs: number[], laneYs: number[], tol: number): boolean {
  for (const lx of laneXs) if (Math.abs(x - lx) < tol) return true;
  for (const ly of laneYs) if (Math.abs(y - ly) < tol) return true;
  return false;
}

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
 * (`constraints.upstream.settlement`): tamed gate lanes hang off the arterial
 * exits (a short jittered stub to the first field boundary, then field-edge
 * legs), a field-size gradient runs toward the wall line, and a FAUBOURG band of
 * `faubourg: true` orchard rows + garden plots lines the ring where it faces the
 * city (all pure functions of the upstream data + absolute position, zero rng
 * draws — no upstream ⇒ byte-identical to the uncoupled generator). It also reads
 * the raw mountain SKETCH for paddy elevation. There is NO farmland → city output edge
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
import { sharedBoundaryHedges, collectAdjacentRings, HEDGE_ADJ_EPS } from "./sharedBoundary";
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
/** Max deterministic per-lane angle jitter (radians, ≈±18°) applied to the gate
 * stub's inward heading — breaks the razor-straight radial fan (shortlist item 8)
 * so multiple stubs off nearby gates read as lanes, not rays. */
const GATE_LANE_JITTER_RAD = 0.32;
/** The gate stub (the ONLY diagonal run of a gate lane) is clipped at the first
 * field-cell boundary it meets; if none is within this many cells (a shallow
 * heading), the march stops here — so a stub never crosses more than ~1.5 cells
 * in a straight run (the spoke-fan metric). Past the stub the lane FOLLOWS field
 * edges (axis-aligned legs along the cell gridlines) to the target junction. */
const GATE_STUB_MAX_CELLS = 1.5;
/** Field-size gradient reach, meters from the nearest generated street. */
const NEAR_CITY_M = 240;
// ── Faubourg transition band (plan 035 peri-urban, shortlist item 9) ──────────
// Where the belt's ring FACES the generated city, a narrow strip of orchard rows
// + garden plots (tagged `faubourg: true`) sits between the wall/city edge and
// the first fields — the built-up suburb that grows against a town wall. Reads
// ONLY the settlement streets farmland already consumes; no upstream city ⇒ zero
// faubourg features (byte-identity). All keyed on absolute position (zero rng).
/** A ring point this near the generated city fabric faces the wall/city edge. */
const FAUBOURG_REACH_M = 120;
/** Spacing along the city-facing ring between faubourg garden plots. */
const FAUBOURG_STEP_M = 22;
/** Garden-plot square size (meters). */
const FAUBOURG_PLOT_M = 16;
/** Plot-centre offset inward from the ring (keeps the strip just inside the wall). */
const FAUBOURG_INSET_M = 12;
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
//
// REACHES (v7, 2026-07-15). A real rang shares ONE orientation over a river
// REACH — the whole range of holdings runs parallel, packed edge-to-edge,
// perpendicular to the AVERAGE bank direction over a few hundred metres. The
// v4–v6 code instead gave every lot its OWN per-sample bank normal, so a
// meandering bank sprayed ribbons at every rotation, crossing each other and
// the underlying lattice fields (Jonah, Vailmarch Marnside — twice). v7 cuts
// each bank into `RANG_REACH_LEN_M` arc-length windows; within a reach the
// inland normal N is a single shared vector (the reach's average tangent turned
// perpendicular), every lot's side edges are parallel to N (so no two lots can
// ever cross — parallel offset lines), and the frontage is snapped so the lots
// tile the reach with no gaps. The lattice fields AND lanes inside the whole
// rang band footprint are suppressed so nothing paints through the strips.
const RANG_REACH_LEN_M = 400; // arc-length window that shares one rang orientation (~300–500 m)
const RANG_ARPENT_MIN_M = 12; // narrowest long-lot width (river frontage)
// Lot DEPTH is a fixed multiple of the lot's own FRONTAGE (`arpentW`), never of
// the coarse lattice `cell`. The old `1.6·cell` reach read `cell` as "one field
// depth", but the emitted field for most presets is a FRACTION of a cell (an
// open-field strip is `cell/STRIP_COUNT` deep, a patchwork leaf ~0.4·cell), so a
// cell-scaled reach ran the lots 4–6× deeper than the fields they sit among —
// against a river that crosses the region the band then covered the WHOLE patch,
// and each long straight lot amplified a meandering bank's swinging normal into a
// sweeping fan of crossing ribbons (Jonah, Vailmarch Marnside, 2026-07-15).
// Anchoring depth to frontage keeps a bounded, self-consistent aspect (a genuine
// bank-local long-lot band of ~1–2 field depths) whatever the preset/fieldSize.
const RANG_DEPTH_ARPENTS = 4; // lot reaches this many frontages inland (≈4:1 lot)
const RANG_LEN_CAP_M = 110; // hard ceiling on inland reach (big-field regions)
const RANG_WM_FRAC = 0.42; // near fraction of each lot tagged `waterMeadow`
const RANG_BASE_OFFSET_M = 2; // start the lot just inland of the bank (field < 0)
/** Long-lot FRONTAGE (river-facing width) for a field-cell size. The narrowest
 * arpent floors at `RANG_ARPENT_MIN_M`; otherwise it scales gently with the cell
 * so bigger-field regions get proportionally wider holdings. */
function arpentWidthM(cell: number): number {
  return Math.max(RANG_ARPENT_MIN_M, cell * 0.18);
}
/** Inland DEPTH of a long-lot: a fixed multiple of its frontage, capped. Depends
 * only on the cell size, so `inRangBand` (suppression) and the lot emission share
 * one reach. */
function rangDepthM(cell: number): number {
  return Math.min(RANG_DEPTH_ARPENTS * arpentWidthM(cell), RANG_LEN_CAP_M);
}
/** The riparian rang band depth (metres inland of the bank) for a `fieldSize` —
 * the reach the lattice fields + lanes are suppressed within and the rang lots
 * span. Exported for the composition metrics/tests. */
export function rangBandDepthM(fieldSize: number): number {
  return rangDepthM(fieldCellM(fieldSize));
}
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

/** The coarse world-lattice cell size (meters) for a `fieldSize` — the unit the
 * gate-lane spoke-fan metric measures straight runs in. Exported for that metric. */
export function fieldCellM(fieldSize: number): number {
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
  // Riverine long-lot band (plan 038 item 2): a lot reaches a fixed multiple of
  // its own frontage inland (`rangDepthM` — bank-local, ~1–2 field depths), NOT a
  // multiple of the coarse cell (which over-ran the band across the whole region;
  // see RANG_DEPTH_ARPENTS). Non-paddy field types near the bank become rang lots
  // — the normal lattice fields there are suppressed (below) so the two never
  // double-paint.
  const rangEnabled = channel !== null && fieldType !== "paddy-terraces";
  const rangLen = rangDepthM(cell);
  /** A point in the riparian band: outside the channel but within `rangLen` of
   * the bank. Always false with no channel (byte-identity). */
  const inRangBand = (x: number, y: number): boolean => {
    if (channel === null) return false;
    const v = channel(x, y);
    return v < 0 && v > -rangLen;
  };
  /** Does a world-axis rectangle touch the rang band (v7 suppression)? Samples the
   * corners, centre and edge midpoints — the same probe cloud as `rectHitsChannel`
   * — so a lattice field that OVERLAPS the band (not just centres in it) is
   * dropped and no grid ever paints through the strips. `rangEnabled === false`
   * (no channel / paddy) ⇒ always false ⇒ byte-identical to the uncoupled path. */
  const rectHitsRangBand = (rect: Pt[]): boolean => {
    if (!rangEnabled) return false;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of rect) {
      if (inRangBand(x, y)) return true;
      cx += x;
      cy += y;
    }
    if (inRangBand(cx / rect.length, cy / rect.length)) return true;
    for (let i = 0; i < rect.length; i++) {
      const a = rect[i];
      const b = rect[(i + 1) % rect.length];
      if (inRangBand((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) return true;
    }
    return false;
  };
  // Slope-gating terrain (plan 038 item 4): the macro terrain field, for the
  // non-paddy field types (paddy reads it separately, below). null on a flat
  // campaign ⇒ no field is ever re-tagged (byte-identical).
  const slopeTerrain =
    fieldType !== "paddy-terraces"
      ? macroTerrainField(constraints.fabricFeatures, constraints.terrainBase, constraints.campaignSeed)
      : null;
  const LANE_STEP_M = 8; // resample step for lane channel-splitting (coupled path only)
  // Lanes stop at the channel; where the rang band is active they stop at the
  // BAND's inland edge too (a lane inside the rang footprint would cut across the
  // strips). Encoded as a shifted field: `channel + rangLen` is ≥ 0 throughout the
  // channel AND the band, so `splitLineOutsideChannel` keeps only the runs at
  // least `rangLen` inland of the water. Paddy / no-channel ⇒ `laneCutField` is
  // the plain channel (or null) ⇒ byte-identical to the pre-v7 behaviour.
  const laneCutField = rangEnabled ? (x: number, y: number): number => channel!(x, y) + rangLen : channel;
  /** Emit a lane run, truncated at the channel (and the rang band, when active). */
  const emitLaneRun = (run: Pt[]): void => {
    if (laneCutField === null) {
      if (run.length >= 2) out.push(laneLine(seed, run, fieldType));
      return;
    }
    for (const piece of splitLineOutsideChannel(resampleLine(run, LANE_STEP_M), laneCutField)) {
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
    // Riverine long-lots (plan 038 item 2, v7): a lattice field that OVERLAPS the
    // riparian band is replaced by the perpendicular rang lots emitted below —
    // suppress it here so nothing grid ever paints through the strips (v6 tested
    // only the centre, so a field straddling the band still double-painted; Jonah
    // Marnside). Gated on `rangEnabled` ⇒ no-op (byte-identical) with no channel.
    const fcx = (rect[0][0] + rect[2][0]) / 2;
    const fcy = (rect[0][1] + rect[2][1]) / 2;
    if (rectHitsRangBand(rect)) return;
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

  // ── Riverine long-lots (Quebec rang / arpent — plan 038 item 2, REACH rewrite
  //    v7): along each generated river bank, narrow holdings run PERPENDICULAR to
  //    the water and stretch ~rangLen inland (fronting the river). Each lot splits
  //    into a near `waterMeadow` cell (flood meadow) + a far tilled cell.
  //
  //    The bank is cut into REACHES — `RANG_REACH_LEN_M` arc-length windows. Every
  //    lot in a reach shares ONE inland normal `N` (the reach's average bank
  //    tangent turned perpendicular), so the whole range runs parallel — no
  //    per-sample fan. Because every lot's side edges are parallel to `N`, two
  //    lots can never cross (parallel offset lines), and a monotone-advance guard
  //    on the frontage keeps their footprints disjoint ⇒ zero strip-strip overlap.
  //    Frontage is snapped so the lots tile the reach with no gaps.
  //
  //    Determinism: reaches are cut by arc length (pure geometry), `N` is the
  //    average of the reach's unit segment tangents + a channel-gradient sign test
  //    (pure f(ring, channel)), the crop keys on the quantized frontage position —
  //    zero rng. Only non-paddy types, only with an upstream channel ⇒
  //    byte-identical to the uncoupled generator otherwise. ─────────────────────
  if (rangEnabled) {
    const banks = buildUpstreamConstraints(constraints.upstream).waterRings;
    const arpentW = arpentWidthM(cell);
    const wmLen = rangLen * RANG_WM_FRAC;
    const grow = rangLen + RANG_BASE_OFFSET_M + arpentW;
    /** Emit one lot cell (a parallelogram sheared along the shared reach normal).
     * `base` is the bank frontage point used to key the crop; `reach` tags the lot
     * so the metric can prove the per-reach orientation is uniform. */
    const emitLotCell = (corners: Pt[], base: Pt, sub: number, waterMeadow: boolean, reach: number): void => {
      if (!rectContained(region, corners, FIELD_MARGIN_M)) return;
      if (rectHitsChannel(corners, channel)) return;
      const ci = Math.round(base[0] / cell);
      const cj = Math.round(base[1] / cell);
      const props: Record<string, unknown> = {
        crop: waterMeadow ? "water-meadow" : cropAt(seed, ci, cj, sub),
        fieldType,
        bankLot: true,
        reach,
      };
      if (waterMeadow) props.waterMeadow = true;
      out.push(fieldFeature(seed, corners, props));
    };
    let reachIdx = 0;
    for (const ring of banks) {
      const nv = ring.length;
      if (nv < 2) continue;
      // Walk the ring, cutting it into contiguous reaches of ~RANG_REACH_LEN_M arc
      // length. Reaches share their boundary vertex so bank coverage is continuous.
      let ri = 0;
      while (ri + 1 < nv) {
        let arc = 0;
        let j = ri;
        while (j + 1 < nv && arc < RANG_REACH_LEN_M) {
          arc += Math.hypot(ring[j + 1][0] - ring[j][0], ring[j + 1][1] - ring[j][1]);
          j++;
        }
        const reachPts = ring.slice(ri, j + 1);
        ri = j;
        if (reachPts.length < 2) continue;
        // Perf reject: skip a reach whose bbox is far from this farmland region
        // (correctness is still guarded per-lot by rectContained).
        let rMinX = Infinity;
        let rMinY = Infinity;
        let rMaxX = -Infinity;
        let rMaxY = -Infinity;
        for (const [x, y] of reachPts) {
          if (x < rMinX) rMinX = x;
          if (y < rMinY) rMinY = y;
          if (x > rMaxX) rMaxX = x;
          if (y > rMaxY) rMaxY = y;
        }
        if (rMaxX < bbox.minX - grow || rMinX > bbox.maxX + grow || rMaxY < bbox.minY - grow || rMinY > bbox.maxY + grow) {
          continue;
        }
        // Average bank tangent T = normalized sum of the reach's UNIT segment
        // tangents (a heading average that a long straight segment can't dominate).
        let tx = 0;
        let ty = 0;
        let reachArc = 0;
        for (let k = 0; k + 1 < reachPts.length; k++) {
          const dx = reachPts[k + 1][0] - reachPts[k][0];
          const dy = reachPts[k + 1][1] - reachPts[k][1];
          const l = Math.hypot(dx, dy);
          if (l <= 0) continue;
          tx += dx / l;
          ty += dy / l;
          reachArc += l;
        }
        const tl = Math.hypot(tx, ty);
        if (tl < 1e-6 || reachArc <= 0) continue; // degenerate (hairpin) reach — skip
        const Tx = tx / tl;
        const Ty = ty / tl;
        // Shared inland normal N ⟂ T: the perpendicular whose small step LOWERS the
        // channel field (channel is + inside, decreasing away from the water, so
        // inland is the descending side). One vector for the whole reach.
        const mid = reachPts[Math.floor(reachPts.length / 2)];
        let Nx = -Ty;
        let Ny = Tx;
        if (channel!(mid[0] + Nx, mid[1] + Ny) > channel!(mid[0] - Nx, mid[1] - Ny)) {
          Nx = -Nx;
          Ny = -Ny;
        }
        const thisReach = reachIdx++;
        // Snap frontage so an integer number of lots tiles the reach exactly.
        const nLots = Math.max(1, Math.round(reachArc / arpentW));
        const w = reachArc / nLots;
        // Interpolate the bank position at arc length `t` within the reach.
        const at = (t: number): Pt => {
          let acc = 0;
          for (let k = 0; k + 1 < reachPts.length; k++) {
            const dx = reachPts[k + 1][0] - reachPts[k][0];
            const dy = reachPts[k + 1][1] - reachPts[k][1];
            const l = Math.hypot(dx, dy);
            if (l <= 0) continue;
            if (acc + l >= t) {
              const f = (t - acc) / l;
              return [reachPts[k][0] + dx * f, reachPts[k][1] + dy * f];
            }
            acc += l;
          }
          return reachPts[reachPts.length - 1];
        };
        let prev = at(0);
        for (let li = 0; li < nLots; li++) {
          const cur = at((li + 1) * w);
          // Monotone-advance guard: the frontage must move in +T. A doubling-back
          // chord (a tight bend inside the reach) would let two parallel lots share
          // a T-interval and overlap — skip it (a small realistic gap at the bend).
          if ((cur[0] - prev[0]) * Tx + (cur[1] - prev[1]) * Ty <= 0) {
            prev = cur;
            continue;
          }
          // Near edge sits RANG_BASE_OFFSET_M inland of the bank (just clear of the
          // channel); the lot then runs `wmLen` (water-meadow) + on to `rangLen`.
          const n0: Pt = [prev[0] + Nx * RANG_BASE_OFFSET_M, prev[1] + Ny * RANG_BASE_OFFSET_M];
          const n1: Pt = [cur[0] + Nx * RANG_BASE_OFFSET_M, cur[1] + Ny * RANG_BASE_OFFSET_M];
          const m0: Pt = [n0[0] + Nx * wmLen, n0[1] + Ny * wmLen];
          const m1: Pt = [n1[0] + Nx * wmLen, n1[1] + Ny * wmLen];
          const t0: Pt = [n0[0] + Nx * rangLen, n0[1] + Ny * rangLen];
          const t1: Pt = [n1[0] + Nx * rangLen, n1[1] + Ny * rangLen];
          emitLotCell([n0, n1, m1, m0], prev, 0, true, thisReach); // riparian water-meadow (near)
          emitLotCell([m0, m1, t1, t0], prev, 1, false, thisReach); // tilled long-lot (far)
          prev = cur;
        }
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

    // Candidate bank field #1: the durable MACRO terrain read through the one
    // composed source of truth (`terrainAt` via `macroTerrainField`) — the full
    // global terrain system (base + mountain + relief + landform stamps, no
    // carve/grade; ruling 2026-07-15). Bit-exact drop-in for
    // `elevationFieldFromFabric` where the goldens run (mountain-only / no-stamp ⇒
    // byte-identical). A landform PLATEAU edge banks paddies with no mountain.
    const elev = macroTerrainField(constraints.fabricFeatures, constraints.terrainBase, constraints.campaignSeed);
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
      const stubMax = GATE_STUB_MAX_CELLS * cell;
      for (const e of entries) {
        const ranked = junctions
          .map((j) => ({ j, d: Math.hypot(j[0] - e[0], j[1] - e[1]) }))
          .sort((a, b) => a.d - b.d || a.j[0] - b.j[0] || a.j[1] - b.j[1]);
        for (const { j } of ranked.slice(0, GATE_LANE_FAN)) {
          // The gate lane no longer rays straight across the belt to a distant
          // junction (the spoke fan). Instead: a short DIAGONAL stub from the gate
          // heading toward `j` (with deterministic per-lane angle jitter) clipped
          // at the first field-cell boundary it meets, then AXIS-ALIGNED legs that
          // FOLLOW the field edges (cell gridlines) to `j`. The stub is the only
          // diagonal run and it is capped at ~1.5 cells (the metric).
          const path = gateLanePath(seed, e, j, cell, stubMax);
          for (const run of clipPolylineToRegion(region, path)) emitLaneRun(run);
        }
      }
    }
  }

  // ── Faubourg transition band (plan 035 peri-urban, shortlist item 9): where the
  //    belt's ring FACES the generated city, a narrow strip of orchard rows +
  //    garden plots (tagged `faubourg: true`) sits between the wall/city edge and
  //    the first fields. Walks the ring by arc length; a ring point within
  //    FAUBOURG_REACH_M of the city fabric drops a garden plot just inside the ring
  //    (inward normal chosen by which side lands deeper inside — winding-robust)
  //    plus an orchard-row tree at its centre. Pure f(ring, streets, position),
  //    zero rng; `streetSegs` empty (no upstream city, or city out of reach) ⇒ no
  //    faubourg feature ⇒ byte-identical to the uncoupled generator. ─────────────
  if (streetSegs.length > 0) {
    const fring = region.ring; // closed (first === last)
    let carry = 0;
    for (let i = 0; i + 1 < fring.length; i++) {
      const a = fring[i];
      const b = fring[i + 1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (segLen <= 1e-6) continue; // degenerate edge: keep the arc-length carry
      const tx = (b[0] - a[0]) / segLen;
      const ty = (b[1] - a[1]) / segLen;
      // Inward unit normal: pick the perpendicular whose short step lands DEEPER
      // inside the region (robust to ring winding).
      let nx = -ty;
      let ny = tx;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      if (
        distanceToBoundary(region, mx + nx * FAUBOURG_INSET_M, my + ny * FAUBOURG_INSET_M) <
        distanceToBoundary(region, mx - nx * FAUBOURG_INSET_M, my - ny * FAUBOURG_INSET_M)
      ) {
        nx = -nx;
        ny = -ny;
      }
      for (let s = FAUBOURG_STEP_M - carry; s < segLen; s += FAUBOURG_STEP_M) {
        const px = a[0] + tx * s;
        const py = a[1] + ty * s;
        if (distToCity(px, py) > FAUBOURG_REACH_M) continue; // not a city-facing stretch
        const cx = px + nx * FAUBOURG_INSET_M;
        const cy = py + ny * FAUBOURG_INSET_M;
        const half = FAUBOURG_PLOT_M / 2;
        const rect = rectOf(cx - half, cy - half, cx + half, cy + half);
        if (!rectContained(region, rect, FIELD_MARGIN_M)) continue;
        if (rectHitsChannel(rect, channel)) continue; // no garden across the channel
        out.push(fieldFeature(seed, rect, { crop: "garden", fieldType, faubourg: true }));
        out.push({
          type: "Feature",
          id: hashSeed(seed, "faubourg-tree", q(cx), q(cy)),
          geometry: { type: "Point", coordinates: [q(cx), q(cy)] },
          properties: { generatorId: "orchard-tree", type: "orchard-tree", fieldType, faubourg: true },
        });
      }
      carry = (carry + segLen) % FAUBOURG_STEP_M;
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

  // ── Sketch-adjacency hedgerow (plan 038 item 7): where this farmland's sketch
  //    ring abuts a forest or park sketch, a hedgerow line runs along the shared
  //    edge — the SAME line the neighbour's forest-canopy-rim / park-canopy-rim
  //    derives (symmetric hashed agreement). SKETCH-only (raw fabric rings);
  //    emitted directly (NOT via the region-clipping emitHedge — the seam line
  //    must stay bit-exact with the neighbour). No adjacent forest/park in reach
  //    ⇒ [] ⇒ byte-identical to the uncoupled generator. ────────────────────────
  const adj = collectAdjacentRings(constraints.fabricFeatures, region.id, ["forest", "park"]);
  for (const line of sharedBoundaryHedges(adj.selfRing, region.id, adj.others, HEDGE_ADJ_EPS)) {
    out.push({
      type: "Feature",
      id: hashSeed(seed, "farm-woodland-bank", Math.round(line[0][0] * 10), Math.round(line[0][1] * 10), line.length),
      geometry: { type: "LineString", coordinates: line },
      properties: { generatorId: "farm-hedge", type: "farm-hedge", fieldType, hedging, woodlandBank: true },
    });
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

/**
 * A gate lane routed to READ as a lane, not a ray (plan 035 gate-lanes,
 * shortlist item 8). From gate entry `e` (on the ring) heading toward junction
 * `j`:
 *  1. a short DIAGONAL stub along the jittered heading, CLIPPED at the first
 *     field-cell gridline (multiple of `cell`) it crosses — the only diagonal run
 *     of the lane, and capped at `stubMax` so it never crosses more than ~1.5
 *     cells in a straight line (the deterministic per-lane angle jitter breaks the
 *     razor fan without lengthening the run);
 *  2. AXIS-ALIGNED legs that FOLLOW the field edges (the cell gridlines) from that
 *     first boundary point to `j`: first along the gridline the stub landed on,
 *     then along `j`'s cross-gridline — so past the stub the lane hugs field
 *     boundaries instead of cutting across cells.
 * Pure geometry + a position-hashed jitter angle (zero shared rng draws), so a
 * farmland with no upstream never calls this and stays byte-identical. Returns a
 * polyline starting at `e`; the caller clips it to the region.
 */
function gateLanePath(seed: number, e: Pt, j: Pt, cell: number, stubMax: number): Pt[] {
  const dx0 = j[0] - e[0];
  const dy0 = j[1] - e[1];
  const len0 = Math.hypot(dx0, dy0);
  if (len0 < 1e-6) return [e];
  // Deterministic per-lane angle jitter, keyed on the gate entry + target so
  // every gate stub gets its own heading (breaks the radial alignment).
  const jr = mulberry32(hashSeed(seed, "farm-gate-jitter", q(e[0]), q(e[1]), q(j[0]), q(j[1])))();
  const ang = (jr - 0.5) * 2 * GATE_LANE_JITTER_RAD;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const ux = (dx0 * ca - dy0 * sa) / len0;
  const uy = (dx0 * sa + dy0 * ca) / len0;
  // Distance along the jittered heading to the next vertical / horizontal cell
  // gridline (the first field boundary the stub meets).
  const nextGrid = (p: number, d: number): number => {
    if (Math.abs(d) < 1e-9) return Infinity;
    const k = d > 0 ? Math.floor(p / cell) + 1 : Math.ceil(p / cell) - 1;
    return (k * cell - p) / d;
  };
  const tX = nextGrid(e[0], ux);
  const tY = nextGrid(e[1], uy);
  const tGrid = Math.min(tX, tY);
  // Stub end: the first gridline crossing, but never past the cap (a shallow
  // heading that would cross many cells stops at the cap instead).
  const t = Math.min(tGrid, stubMax);
  const stubEnd: Pt = [e[0] + ux * t, e[1] + uy * t];
  const path: Pt[] = [e, stubEnd];
  // If we actually landed ON a gridline (not the cap), follow field edges to j:
  // snap onto the exact gridline coordinate, then dog-leg along gridlines to j.
  if (tGrid <= stubMax && Number.isFinite(tGrid)) {
    const onVertical = tX <= tY; // landed on x = k·cell
    if (onVertical) {
      const gx = Math.round(stubEnd[0] / cell) * cell; // exact vertical gridline
      const corner: Pt = [gx, e[1] + uy * t]; // snap x; keep the stub's y
      // Leg 1: along the vertical field edge to j's row; Leg 2: along j's row to j.
      path[1] = corner;
      path.push([gx, j[1]]);
      path.push([j[0], j[1]]);
    } else {
      const gy = Math.round(stubEnd[1] / cell) * cell; // exact horizontal gridline
      const corner: Pt = [e[0] + ux * t, gy]; // snap y; keep the stub's x
      path[1] = corner;
      path.push([j[0], gy]);
      path.push([j[0], j[1]]);
    }
  }
  return path;
}

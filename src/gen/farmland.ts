/**
 * Farmland generator (plan 022 §3.5) — wires up the new `farmland` polygon
 * kind. Pure/headless (no DOM/map/Obsidian imports; reads only its arguments,
 * D6): a sketched `farmland` polygon is the region; this fills it with tilled
 * fields, a sparse lane web, field-edge hedges/fences, farmstead footprints at
 * lane junctions, and (for the orchard preset) regular tree rows — everything
 * strictly inside the sketched ring.
 *
 * Four field types (a `fieldType` param, never a presetId — mirrors the city
 * algorithm's `profile` / park's `variety`): `open-field-strips` (medieval long
 * strips off a central lane), `enclosed-patchwork` (irregular hedged fields),
 * `grid-quarters` (rectilinear sections + straight section roads), `orchard`
 * (regular tree rows in a grid). `paddy-terraces` is DEFERRED to plan 023 (the
 * field-coupled elevation variant) and is deliberately not implemented here.
 *
 * Design (advisor 2026-07-13, the park/forest precedent): NOT the parcels.ts
 * OBB splitter oriented to the region. Two plan-literal deviations, logged in
 * DECISIONS + flagged to Jonah:
 *  1. The field lattice is keyed on ABSOLUTE WORLD POSITION and aligned to the
 *     WORLD axes, not to the region's oriented bounding box. Orienting the grid
 *     to the region OBB would mean a single vertex edit changes the OBB angle
 *     and rotates the WHOLE field grid — an edit would look like a re-roll and
 *     fail the edit-locality gate. World-axis alignment keeps every interior
 *     field byte-identical under an edit (forest/park's identity property).
 *     Real grid/strip farmland is axis-aligned anyway.
 *  2. Field subdivision is a self-contained recursive rectangle splitter (the
 *     "OBB/strip splitter at field scale" in spirit) rather than importing
 *     `parcels.subdivideBlocks`, which is tightly coupled to CityProfile /
 *     CitynessFn / BlockFace — a fake city to grow fields, more fragile than a
 *     purpose-built closed-form generator, not less (park set this precedent).
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic on an absolute-world lattice; every roll
 *    comes from `hashSeed(seed, salt, …integer world indices/paths)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property: fields/lanes/farmsteads/trees all key on ABSOLUTE world
 *    position (lattice indices + split path), so a ring vertex edit changes only
 *    which boundary rectangles pass containment — every interior field is
 *    byte-identical, while a re-roll (new seed) re-splits/re-classifies
 *    everything (measured in the gate: edit overlap ≫ re-roll overlap).
 *  - Containment: fields aren't jittered, so a rectangle emits only when all
 *    four corners are ≥ FIELD_MARGIN_M inside the ring AND no edge crosses the
 *    boundary (a straight edge between two contained corners can still bridge a
 *    concave notch — the edge check catches it). Rim/notch-straddling fields
 *    drop → graceful degradation doubles as the concave containment guarantee.
 *  - Feature ids hash positions (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort stays stable.
 *
 * Stage 2 (agriculture) in plan 024: the CITY sees farmland (its outskirt
 * fields are suppressed inside a raw farmland sketch — see
 * `citynet/outskirts.ts`); farmland NEVER sees the city (`_constraints` unused,
 * like forest/park). Farmland-vs-city overlap is legal (overlap keys on the
 * algorithm id — MapController.overlappingRegion).
 */
import { hashSeed, mulberry32 } from "./rng";
import {
  distanceToBoundary,
  segmentCrossesBoundary,
  clipPolylineToRegion,
  type ProcgenRegion,
} from "./region";
import { q, blobFeature } from "./waterEmit";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const FARMLAND_TYPES = ["open-field-strips", "enclosed-patchwork", "grid-quarters", "orchard"] as const;
export type FarmlandType = (typeof FARMLAND_TYPES)[number];

export const HEDGING_KINDS = ["none", "fences", "hedgerows"] as const;
export type Hedging = (typeof HEDGING_KINDS)[number];

/** Farmland params (plan 022 §3.5). `fieldType` drives layout AND is carried
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
  out: Pt[][]
): void {
  const w = x1 - x0;
  const h = y1 - y0;
  const rng = mulberry32(hashSeed(seed, "farm-split", ix, iy, path.length, path.charCodeAt(path.length - 1) || 0));
  const canSplit = path.length < PATCHWORK_MAX_DEPTH && Math.max(w, h) > minM * 1.6;
  // A hashed chance to stop early even when splittable — the varied field sizes.
  if (!canSplit || rng() < 0.28) {
    out.push(rectOf(x0, y0, x1, y1));
    return;
  }
  const cutAlongX = w >= h; // cut the long side
  const frac = 0.38 + rng() * 0.24; // 38–62% cut
  if (cutAlongX) {
    const cx = x0 + w * frac;
    patchworkSplit(seed, ix, iy, x0, y0, cx, y1, minM, path + "0", out);
    patchworkSplit(seed, ix, iy, cx, y0, x1, y1, minM, path + "1", out);
  } else {
    const cy = y0 + h * frac;
    patchworkSplit(seed, ix, iy, x0, y0, x1, cy, minM, path + "0", out);
    patchworkSplit(seed, ix, iy, x0, cy, x1, y1, minM, path + "1", out);
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
 * Generate farmland inside a sketched polygon region (plan 022 §3.5). Emits
 * `farm-field` polygons (+ `crop`/`fieldType` props), `farm-lane` lines,
 * `farm-hedge` lines, `farm-building` footprints, and (orchard) `orchard-tree`
 * points — all strictly inside `region.ring`. `_constraints` accepted for
 * signature parity, never consumed (farmland never sees the city — stage
 * layering, plan 022 §3.5 / plan 024).
 */
export function generateFarmland(
  seed: number,
  region: ProcgenRegion,
  params: FarmlandParams,
  _constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { fieldType, fieldSize, hedging, laneDensity, farmsteads } = params;
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  const cell = fieldCellM(fieldSize);

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
    out.push(fieldFeature(seed, rect, { crop: cropAt(seed, ix, iy, sub), fieldType }));
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
      if (fieldType === "enclosed-patchwork") {
        const pieces: Pt[][] = [];
        patchworkSplit(seed, ix, iy, x0, y0, x1, y1, cell * 0.42, "r", pieces);
        pieces.forEach((rect, si) => emitField(ix, iy, si, rect));
      } else if (fieldType === "open-field-strips") {
        // Long thin strips along the longer world axis (one furlong per cell).
        for (let k = 0; k < STRIP_COUNT; k++) {
          const rect = stripAlongX
            ? rectOf(x0, y0 + (cell * k) / STRIP_COUNT, x1, y0 + (cell * (k + 1)) / STRIP_COUNT)
            : rectOf(x0 + (cell * k) / STRIP_COUNT, y0, x0 + (cell * (k + 1)) / STRIP_COUNT, y1);
          emitField(ix, iy, k, rect);
        }
      } else {
        // grid-quarters / orchard: one rectilinear section per cell.
        emitField(ix, iy, 0, rectOf(x0, y0, x1, y1));
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
      if (run.length >= 2) out.push(laneLine(seed, run, fieldType));
    }
  }
  for (let iy = iy0; iy <= iy1; iy++) {
    if (((iy % laneEvery) + laneEvery) % laneEvery !== 0) continue;
    const y = iy * cell;
    laneYs.push(y);
    for (const run of clipPolylineToRegion(region, [[bbox.minX - cell, y], [bbox.maxX + cell, y]])) {
      if (run.length >= 2) out.push(laneLine(seed, run, fieldType));
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

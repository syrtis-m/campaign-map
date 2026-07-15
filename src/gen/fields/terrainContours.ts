/**
 * Viewport-keyed, LAZILY computed contour leaves of the composed terrain field
 * (plan 036-C). Contours used to be per-mountain-region features baked by
 * `generateMountain`; a campaign-wide terrain surface (base + stamps + carve)
 * has no single region to hang them on, and eagerly tracing a 30×30 km field is
 * ~2.4 M samples ≈ 10–30 s on the Surface Pro. The fix (binding): trace contours
 * per fixed WORLD-ALIGNED tile, only when a viewport first touches that tile, and
 * hold a BOUNDED LRU of leaves keyed on the DURABLE TERRAIN INPUTS INTERSECTING
 * the tile — so a sketch edit far from a tile leaves its cached leaf valid, and
 * only touched tiles are ever computed.
 *
 * Seam-safety rides entirely on `marchingSquares` being world-aligned: adjacent
 * tiles share the boundary lattice line, sample the identical world points there,
 * and interpolate identical crossings — so a contour crossing a tile edge meets
 * its neighbour to the mm (the 2×2 seam gate). Pure/headless: the field is a pure
 * function of the durable sketch layer, so a leaf is a pure memo.
 */
import { marchingSquares } from "./marchingSquares";
import { terrainAt, DEFAULT_TERRAIN_BASE, type TerrainBaseParams, type TerrainOptions } from "./terrain";
import type { BBox } from "../spatialHash";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

/** The sketch kinds whose durable data drives `terrainAt` — the inputs a leaf's
 * cache key hashes (intersecting the tile). */
const TERRAIN_INPUT_ALGORITHMS = new Set(["mountain", "relief", "landform", "river"]);

// ─── Relief range (drives the contour-INTERVAL cap) ──────────────────────────
// Why: the LOD picks a coarser contour interval as you zoom out, but a FIXED
// interval ladder that climbs past the campaign's actual relief makes every iso-
// level fall outside the terrain — the lines vanish at overview zoom (Jonah
// 2026-07-15: "topographic lines should be visible at all zoom levels"). The fix
// is to CAP the interval at `range / TARGET_LINES`, so the visible relief always
// yields a cartographic line count. That cap needs the campaign's real relief
// range, measured DETERMINISTICALLY from the durable terrain inputs (never the
// viewport — a pan must not change the interval), so it fingerprints with the
// same digest the leaves do.

export interface ReliefRangeOptions {
  base?: Partial<TerrainBaseParams>;
  campaignSeed?: number;
  include?: TerrainOptions["include"];
  /** Grid samples per axis over the input union bbox (default 64). Only affects
   * the interval CHOICE, never traced geometry — a coarse estimate is fine. */
  samples?: number;
}

function reliefInputBBox(features: FabricFeature[]): BBox | null {
  let any = false;
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const f of features) {
    if (!f.properties.procgen || !TERRAIN_INPUT_ALGORITHMS.has(f.properties.procgen.algorithm)) continue;
    any = true;
    const fb = bboxOf(f);
    if (fb.minX < b.minX) b.minX = fb.minX;
    if (fb.minY < b.minY) b.minY = fb.minY;
    if (fb.maxX > b.maxX) b.maxX = fb.maxX;
    if (fb.maxY > b.maxY) b.maxY = fb.maxY;
  }
  return any ? b : null;
}

/**
 * The composed terrain field's approximate relief RANGE (max − min elevation, in
 * meters) over the campaign — the durable input the contour-interval cap keys on.
 * Deterministic and viewport-independent: a fixed lattice over the union bbox of
 * every terrain-input feature, plus the input geometry vertices (ridge spines are
 * the peaks a coarse grid can otherwise straddle), unioned with the base fBm's own
 * peak-to-peak (~2·campAmp) so a stamp-free non-flat base still reports a sane
 * range. Returns 0 for a wholly flat campaign (no stamps, flat base) — the caller
 * then leaves the interval on its ladder (there are no contours to draw anyway).
 */
export function estimateReliefRange(features: FabricFeature[] | undefined, opts: ReliefRangeOptions = {}): number {
  const feats = features ?? [];
  const base = opts.base ?? {};
  const campAmp = Math.abs(base.campAmp ?? DEFAULT_TERRAIN_BASE.campAmp);
  const baseRange = 2 * campAmp; // fBm normalized ≈ [−1,1] ⇒ peak-to-peak ≈ 2·campAmp
  const bbox = reliefInputBBox(feats);
  if (!bbox) return baseRange; // no stamps ⇒ only the base contributes relief

  const field = terrainAt(feats, { base, campaignSeed: opts.campaignSeed, include: opts.include });
  let lo = Infinity;
  let hi = -Infinity;
  const sample = (x: number, y: number): void => {
    const v = field(x, y).v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  const n = Math.max(2, Math.trunc(opts.samples ?? 64));
  for (let i = 0; i <= n; i++) {
    const x = bbox.minX + ((bbox.maxX - bbox.minX) * i) / n;
    for (let j = 0; j <= n; j++) {
      sample(x, bbox.minY + ((bbox.maxY - bbox.minY) * j) / n);
    }
  }
  // Sample the input vertices too — a ridge spine's peak sits ON the polyline, so
  // a coarse grid can straddle it and under-read the range.
  for (const f of feats) {
    if (!f.properties.procgen || !TERRAIN_INPUT_ALGORITHMS.has(f.properties.procgen.algorithm)) continue;
    const coords = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates;
    for (const [x, y] of coords as Pt[]) sample(x, y);
  }
  const sampled = hi - lo;
  return Math.max(sampled, baseRange);
}

export interface TerrainContourOptions {
  base?: Partial<TerrainBaseParams>;
  campaignSeed?: number;
  /** Which composed-field operators to include — MUST match the DEM's
   * `campaignElevationSnapshot` (relief/landform/carve on, grade per config) so
   * the contour lines trace the SAME surface the hillshade/3D shades. Omitted ⇒
   * the `terrainAt` default (all on). */
  include?: TerrainOptions["include"];
  /** Lattice spacing (meters). World-aligned; adjacent tiles agree on it. */
  step: number;
  /** Tile edge (meters) — MUST be a multiple of `step` so tiles align to the
   * lattice and share boundary samples (seam-safety). */
  tileSpan: number;
  /** Contour interval (meters of relief between iso-lines). */
  interval: number;
  /** Lowest / highest iso-level traced (meters). Levels are `interval` apart. */
  levelMin: number;
  levelMax: number;
  /** Every N-th level (from the datum) is a "major" index line. Default 5. */
  majorEvery?: number;
  /** LRU capacity in leaves. */
  maxLeaves: number;
  /** How far (meters) a terrain input's bbox can reach beyond a tile and still
   * change its contours (falloff bands / carve gorges). Any input within this
   * margin is in the tile's cache key. Default 600. */
  inputMargin?: number;
}

interface Leaf {
  key: string;
  features: GeoJSON.Feature[];
}

function bboxOf(feature: FabricFeature): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const coords = feature.geometry.type === "Polygon" ? feature.geometry.coordinates[0] : feature.geometry.coordinates;
  for (const [x, y] of coords as Pt[]) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

function bboxIntersects(a: BBox, b: BBox, margin: number): boolean {
  return a.minX - margin <= b.maxX && a.maxX + margin >= b.minX && a.minY - margin <= b.maxY && a.maxY + margin >= b.minY;
}

/** Stable digest of a terrain input's durable identity (id, algorithm, seed,
 * params, geometry). Cheap string hash — cache keys are compared, not stored as
 * a determinism surface. */
function inputDigest(f: FabricFeature): string {
  const p = f.properties.procgen!;
  return `${f.id}~${p.algorithm}~${p.seed}~${JSON.stringify(p.params)}~${JSON.stringify(f.geometry.coordinates)}`;
}

export class TerrainContourLeaves {
  private readonly opts: Required<Omit<TerrainContourOptions, "include">>;
  private readonly field: (x: number, y: number) => { v: number };
  private readonly inputs: { feature: FabricFeature; bbox: BBox }[];
  private readonly leaves = new Map<string, Leaf>();
  private readonly inflight = new Map<string, Promise<GeoJSON.Feature[]>>();
  computedLeaves = 0;
  evictedLeaves = 0;

  constructor(features: FabricFeature[] | undefined, opts: TerrainContourOptions) {
    this.opts = {
      base: opts.base ?? {},
      campaignSeed: opts.campaignSeed ?? 0,
      step: opts.step,
      tileSpan: opts.tileSpan,
      interval: opts.interval,
      levelMin: opts.levelMin,
      levelMax: opts.levelMax,
      majorEvery: opts.majorEvery ?? 5,
      maxLeaves: Math.max(1, opts.maxLeaves),
      inputMargin: opts.inputMargin ?? 600,
    };
    const feats = features ?? [];
    this.field = terrainAt(feats, { base: this.opts.base, campaignSeed: this.opts.campaignSeed, include: opts.include });
    this.inputs = feats
      .filter((f) => f.properties.procgen && TERRAIN_INPUT_ALGORITHMS.has(f.properties.procgen.algorithm))
      .map((f) => ({ feature: f, bbox: bboxOf(f) }));
  }

  get leafCount(): number {
    return this.leaves.size;
  }

  private tileBBox(tx: number, ty: number): BBox {
    const span = this.opts.tileSpan;
    return { minX: tx * span, minY: ty * span, maxX: (tx + 1) * span, maxY: (ty + 1) * span };
  }

  /** The durable-input digest for the tile: the sorted digests of every terrain
   * input whose (margin-expanded) bbox touches the tile. Empty ⇒ a flat tile. */
  private tileKey(tx: number, ty: number): string {
    const tile = this.tileBBox(tx, ty);
    const hits: string[] = [];
    for (const inp of this.inputs) {
      if (bboxIntersects(inp.bbox, tile, this.opts.inputMargin)) hits.push(inputDigest(inp.feature));
    }
    hits.sort();
    return `${tx}:${ty}|${hits.join("|")}`;
  }

  /**
   * The contour features for tile (tx,ty), computed lazily on first touch and
   * cached in the LRU. Re-touching a still-cached, still-valid tile is free; a
   * tile whose intersecting inputs changed gets a new key ⇒ recompute.
   */
  leafFor(tx: number, ty: number): { features: GeoJSON.Feature[]; cached: boolean } {
    const key = this.tileKey(tx, ty);
    const mapKey = `${tx}:${ty}`;
    const hit = this.leaves.get(mapKey);
    if (hit && hit.key === key) {
      // Touch (LRU): move to most-recent.
      this.leaves.delete(mapKey);
      this.leaves.set(mapKey, hit);
      return { features: hit.features, cached: true };
    }
    const features = this.traceTile(tx, ty);
    this.store(mapKey, key, features);
    return { features, cached: false };
  }

  /**
   * Async leaf resolution with an INJECTED tracer — the SAME laziness / LRU /
   * counter bookkeeping as `leafFor`, but the heavy trace runs through `trace`
   * (e.g. the generation worker, off the main thread — Jonah 2026-07-15). Falls
   * back to the synchronous `traceTile` when `trace` is absent (worker
   * unavailable). Concurrent misses for the same tile+key are de-duped so a
   * viewport that touches a tile twice before it resolves computes it once.
   */
  async leafForAsync(
    tx: number,
    ty: number,
    trace?: (tx: number, ty: number) => Promise<GeoJSON.Feature[]>
  ): Promise<{ features: GeoJSON.Feature[]; cached: boolean }> {
    const key = this.tileKey(tx, ty);
    const mapKey = `${tx}:${ty}`;
    const hit = this.leaves.get(mapKey);
    if (hit && hit.key === key) {
      this.leaves.delete(mapKey);
      this.leaves.set(mapKey, hit);
      return { features: hit.features, cached: true };
    }
    const inflightKey = `${mapKey}|${key}`;
    let pending = this.inflight.get(inflightKey);
    if (!pending) {
      pending = trace ? trace(tx, ty) : Promise.resolve(this.traceTile(tx, ty));
      this.inflight.set(inflightKey, pending);
    }
    let features: GeoJSON.Feature[];
    try {
      features = await pending;
    } finally {
      this.inflight.delete(inflightKey);
    }
    this.store(mapKey, key, features);
    return { features, cached: false };
  }

  /** Insert a freshly-computed leaf, bump the compute counter, evict the LRU. */
  private store(mapKey: string, key: string, features: GeoJSON.Feature[]): void {
    this.leaves.delete(mapKey);
    this.leaves.set(mapKey, { key, features });
    this.computedLeaves++;
    if (this.leaves.size > this.opts.maxLeaves) {
      const oldest = this.leaves.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.leaves.delete(oldest);
        this.evictedLeaves++;
      }
    }
  }

  private traceTile(tx: number, ty: number): GeoJSON.Feature[] {
    const elev = (x: number, y: number): number => this.field(x, y).v;
    return traceTerrainContourTile(elev, tx, ty, {
      step: this.opts.step,
      tileSpan: this.opts.tileSpan,
      interval: this.opts.interval,
      levelMin: this.opts.levelMin,
      levelMax: this.opts.levelMax,
      majorEvery: this.opts.majorEvery,
    });
  }
}

/** The world-aligned tile parameters a single contour leaf is traced from. A
 * multiple-of-`step` `tileSpan` keeps adjacent tiles sharing their boundary
 * lattice line (seam safety). */
export interface ContourTileParams {
  step: number;
  tileSpan: number;
  interval: number;
  levelMin: number;
  levelMax: number;
  majorEvery: number;
}

/**
 * Trace ONE world-aligned contour tile from an elevation-VALUE field — the pure
 * primitive shared by the main-thread `TerrainContourLeaves` LRU AND the
 * generation worker (`worker vs fallback byte-identical`). Deterministic: the
 * lattice is world-aligned (marchingSquares samples identical shared points), the
 * output is clipped to the tile and id-sorted, and ids hash POSITION (level + mm
 * first vertex), never emission order. Emits `terrain-contour` features with a
 * numeric `elevation` and a `minor|major` index cadence (the paint hooks).
 */
export function traceTerrainContourTile(
  elev: (x: number, y: number) => number,
  tx: number,
  ty: number,
  p: ContourTileParams
): GeoJSON.Feature[] {
  const bbox: BBox = {
    minX: tx * p.tileSpan,
    minY: ty * p.tileSpan,
    maxX: (tx + 1) * p.tileSpan,
    maxY: (ty + 1) * p.tileSpan,
  };
  const levels: number[] = [];
  for (let lv = p.levelMin; lv <= p.levelMax; lv += p.interval) {
    if (lv === 0) continue; // the datum itself is a coastline, not a relief line
    levels.push(lv);
  }
  const contours = marchingSquares(elev, { bbox, step: p.step, levels });
  const out: GeoJSON.Feature[] = [];
  for (const c of contours) {
    // Clip each traced line to the tile bbox so a leaf owns only its own tile
    // (a contour that wandered a lattice cell past the edge is trimmed — the
    // neighbour tile owns that run). Endpoints ON the shared edge are kept, so
    // the two tiles' runs meet.
    const band = Math.round(c.level / p.interval);
    const index = band % p.majorEvery === 0 ? "major" : "minor";
    const elevation = Math.round(c.level);
    for (const run of clipToTile(c.points, bbox)) {
      if (run.length < 2) continue;
      const [fx, fy] = run[0];
      out.push({
        type: "Feature",
        id: `terrain-contour:${elevation}:${Math.round(fx * 10)}:${Math.round(fy * 10)}`,
        geometry: { type: "LineString", coordinates: run },
        properties: { generatorId: "terrain-contour", type: "terrain-contour", elevation, index },
      });
    }
  }
  // Deterministic order (marchingSquares already sorts; re-sort after clipping).
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

/** Split a polyline into the runs that lie within `bbox` (inclusive). A vertex on
 * the boundary counts as inside, so adjacent tiles keep the shared-edge crossing.
 * Simple: keep maximal runs of in-bbox vertices (the lattice step is fine enough
 * that a segment never skips across the tile). */
function clipToTile(points: Pt[], bbox: BBox): Pt[][] {
  const inside = (p: Pt): boolean => p[0] >= bbox.minX && p[0] <= bbox.maxX && p[1] >= bbox.minY && p[1] <= bbox.maxY;
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of points) {
    if (inside(p)) {
      cur.push(p);
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

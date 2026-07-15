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
import { terrainAt, type TerrainBaseParams } from "./terrain";
import type { BBox } from "../spatialHash";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

/** The sketch kinds whose durable data drives `terrainAt` — the inputs a leaf's
 * cache key hashes (intersecting the tile). */
const TERRAIN_INPUT_ALGORITHMS = new Set(["mountain", "relief", "landform", "river"]);

export interface TerrainContourOptions {
  base?: Partial<TerrainBaseParams>;
  campaignSeed?: number;
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
  private readonly opts: Required<TerrainContourOptions>;
  private readonly field: (x: number, y: number) => { v: number };
  private readonly inputs: { feature: FabricFeature; bbox: BBox }[];
  private readonly levels: number[];
  private readonly leaves = new Map<string, Leaf>();
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
    this.field = terrainAt(feats, { base: this.opts.base, campaignSeed: this.opts.campaignSeed });
    this.inputs = feats
      .filter((f) => f.properties.procgen && TERRAIN_INPUT_ALGORITHMS.has(f.properties.procgen.algorithm))
      .map((f) => ({ feature: f, bbox: bboxOf(f) }));
    this.levels = [];
    for (let lv = this.opts.levelMin; lv <= this.opts.levelMax; lv += this.opts.interval) {
      if (lv === 0) continue; // the datum itself is a coastline, not a relief line
      this.levels.push(lv);
    }
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
    const leaf: Leaf = { key, features };
    this.leaves.delete(mapKey);
    this.leaves.set(mapKey, leaf);
    this.computedLeaves++;
    if (this.leaves.size > this.opts.maxLeaves) {
      const oldest = this.leaves.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.leaves.delete(oldest);
        this.evictedLeaves++;
      }
    }
    return { features, cached: false };
  }

  private traceTile(tx: number, ty: number): GeoJSON.Feature[] {
    const bbox = this.tileBBox(tx, ty);
    const elev = (x: number, y: number): number => this.field(x, y).v;
    const contours = marchingSquares(elev, { bbox, step: this.opts.step, levels: this.levels });
    const out: GeoJSON.Feature[] = [];
    for (const c of contours) {
      // Clip each traced line to the tile bbox so a leaf owns only its own tile
      // (a contour that wandered a lattice cell past the edge is trimmed — the
      // neighbour tile owns that run). Endpoints ON the shared edge are kept, so
      // the two tiles' runs meet.
      const band = Math.round(c.level / this.opts.interval);
      const index = band % this.opts.majorEvery === 0 ? "major" : "minor";
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

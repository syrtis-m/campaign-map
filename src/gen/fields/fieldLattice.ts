/**
 * Chunked field-sample lattice with LRU eviction (plan 036-B lattice
 * discipline). Sampling the composed terrain field over a whole campaign is
 * ~millions of points (a 30×30 km base-noise campaign ≈ 2.4 M samples) — eager
 * evaluation is 10–30 s on the Surface Pro. The fix (binding): sample LAZILY per
 * fixed-size tile into a `Float32Array`, cache a BOUNDED number of tiles in an
 * LRU, and NEVER hold a global 10 m `Map` (0.5–1 GB at 30×30 km). A tile is
 * computed only the first time a query touches it; the least-recently-used tile
 * is dropped once the cap is hit.
 *
 * Pure/headless: values come from the wrapped `ElevationField` (a pure function
 * of the durable sketch layer), so the cache is a pure memo — two lattices over
 * the same field + tiling give byte-identical samples. `computedTiles` and
 * `tileCount` are the observability the 036-B/036-C laziness + memory gates
 * assert against.
 */
import type { ElevationField } from "./elevation";

export interface FieldLatticeOptions {
  /** Spacing between samples within a tile, meters (the lattice resolution). */
  step: number;
  /** Samples per tile edge (a tile spans `tileEdge · step` meters). */
  tileEdge: number;
  /** LRU capacity: at most this many tiles are held; the least-recently-used is
   * evicted on overflow. The memory bound (`tileEdge² · 4 · maxTiles` bytes). */
  maxTiles: number;
  /** World origin the tile grid aligns to (meters). Fixed per campaign so
   * abutting viewports share tile boundaries (seam rule). Defaults to (0,0). */
  originX?: number;
  originY?: number;
}

export class FieldLattice {
  private readonly field: ElevationField;
  private readonly step: number;
  private readonly tileEdge: number;
  private readonly maxTiles: number;
  private readonly originX: number;
  private readonly originY: number;
  private readonly span: number; // meters a tile covers per edge
  /** Insertion/most-recent order is the Map iteration order (JS Maps preserve
   * it); we delete+set on touch to move a tile to the most-recent end. */
  private readonly tiles = new Map<string, Float32Array>();
  /** Tiles filled since construction — the laziness counter (only touched tiles
   * are ever computed). */
  computedTiles = 0;
  /** Tiles evicted since construction — LRU observability. */
  evictedTiles = 0;

  constructor(field: ElevationField, opts: FieldLatticeOptions) {
    this.field = field;
    this.step = opts.step;
    this.tileEdge = opts.tileEdge;
    this.maxTiles = Math.max(1, opts.maxTiles);
    this.originX = opts.originX ?? 0;
    this.originY = opts.originY ?? 0;
    this.span = this.tileEdge * this.step;
  }

  /** Live tile count (≤ maxTiles). */
  get tileCount(): number {
    return this.tiles.size;
  }

  private tileKey(tx: number, ty: number): string {
    return `${tx}:${ty}`;
  }

  /** Fill (or fetch from the LRU) the tile containing world grid cell
   * (tx,ty) → cache, evicting the LRU tile past the cap. */
  private tileFor(tx: number, ty: number): Float32Array {
    const key = this.tileKey(tx, ty);
    const hit = this.tiles.get(key);
    if (hit) {
      // Touch: move to most-recent (delete + re-set).
      this.tiles.delete(key);
      this.tiles.set(key, hit);
      return hit;
    }
    const buf = new Float32Array(this.tileEdge * this.tileEdge);
    const x0 = this.originX + tx * this.span;
    const y0 = this.originY + ty * this.span;
    for (let j = 0; j < this.tileEdge; j++) {
      const wy = y0 + j * this.step;
      for (let i = 0; i < this.tileEdge; i++) {
        buf[j * this.tileEdge + i] = this.field(x0 + i * this.step, wy).v;
      }
    }
    this.computedTiles++;
    this.tiles.set(key, buf);
    if (this.tiles.size > this.maxTiles) {
      // Evict the oldest (first) entry — the least-recently-used.
      const oldest = this.tiles.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.tiles.delete(oldest);
        this.evictedTiles++;
      }
    }
    return buf;
  }

  /**
   * The lattice value at the nearest grid node to (x,y) (nearest-node, no
   * interpolation — callers that need sub-node accuracy align their query grid
   * to `step`). Computes the containing tile lazily on first touch.
   */
  sampleNode(x: number, y: number): number {
    const gx = Math.round((x - this.originX) / this.step);
    const gy = Math.round((y - this.originY) / this.step);
    const tx = Math.floor(gx / this.tileEdge);
    const ty = Math.floor(gy / this.tileEdge);
    const tile = this.tileFor(tx, ty);
    const li = ((gx % this.tileEdge) + this.tileEdge) % this.tileEdge;
    const lj = ((gy % this.tileEdge) + this.tileEdge) % this.tileEdge;
    return tile[lj * this.tileEdge + li];
  }
}

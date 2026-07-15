import type maplibregl from "maplibre-gl";
import {
  TerrainContourLeaves,
  type ContourTileParams,
} from "../../gen/fields/terrainContours";
import type { SerializableTerrainInputs } from "../../gen/worker/generationWorker";
import type { GenerationWorkerClient } from "./workerClient";

/**
 * Feeds the global `terrain-contour` GeoJSON source per viewport (Jonah
 * 2026-07-15: "relief lines should be showing everywhere, since we have a global
 * terrain system"). On each map settle it computes the world-aligned contour
 * tiles the viewport touches, LAZILY (only tiles first seen), from the SAME
 * composed terrain field the DEM samples (`campaignElevationSnapshot`), and
 * setData's the union.
 *
 * The heavy trace runs in the generation WORKER (`computeContourLeaf`) with a
 * main-thread fallback, so a cold contour fill never stalls the renderer — same
 * discipline as the DEM lattice fill. Laziness / LRU / compute+evict counters are
 * the `TerrainContourLeaves` engine's (wired in here as the per-digest cache);
 * the engine is rebuilt when the terrain DIGEST or the zoom LOD changes, so a
 * stamp edit invalidates precisely and a pan reuses cached leaves.
 *
 * COORDINATES: the field (and thus every traced leaf) is in gen-space METERS; the
 * map renders in DISPLAY units (fake lng/lat). Display = meters / scale — the
 * exact inverse of `demTileLattice`'s `lng·scale` sampling, so contours register
 * on the hillshade to the meter.
 */

/** World-aligned tile-span ladder (meters). Quantized so nearby zooms share a
 * tiling (and thus cached leaves); `contourLOD` picks the smallest span giving
 * ~TILES_ACROSS tiles across the viewport, bounding the per-settle work. */
const TILE_SPAN_LADDER = [125, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000] as const;
const TILES_ACROSS = 6;
/** 25 lattice nodes per tile edge — `tileSpan / step === 25` exactly, so tiles
 * share their boundary lattice line (seam safety) at every LOD. */
const NODES_PER_TILE = 25;
/** Contour interval (meters of RELIEF between iso-lines) selected per LOD — the
 * ruling's "LOD via contour INTERVAL selection per zoom, never a minzoom gate":
 * far-out (big tiles) → coarse interval, close-in → fine. */
function intervalForSpan(tileSpan: number): number {
  if (tileSpan <= 250) return 10;
  if (tileSpan <= 500) return 20;
  if (tileSpan <= 1000) return 25;
  if (tileSpan <= 2000) return 50;
  if (tileSpan <= 4000) return 100;
  if (tileSpan <= 8000) return 200;
  if (tileSpan <= 16000) return 250;
  return 500;
}
/** Plausible relief band traced (meters). Generous enough for mountains
 * (AMP_MAX 1200), relief spines (≤4000), landform basins (≤ −a few hundred) and a
 * continental base; levels outside the band are absent (marching-squares
 * fast-skips them per tile, so a wide band is cheap). Tunable. */
const CONTOUR_LEVEL_MIN = -3000;
const CONTOUR_LEVEL_MAX = 6000;
const MAJOR_EVERY = 5;
/** Safety cap on tiles filled per settle (the ladder keeps it ~TILES_ACROSS²;
 * this guards a pathological aspect ratio). */
const MAX_TILES_PER_UPDATE = 96;

interface ContourLOD extends ContourTileParams {}

function contourLOD(viewportMeters: number): ContourLOD {
  const target = Math.max(1, viewportMeters) / TILES_ACROSS;
  let tileSpan = TILE_SPAN_LADDER[TILE_SPAN_LADDER.length - 1];
  for (const s of TILE_SPAN_LADDER) {
    if (s >= target) {
      tileSpan = s;
      break;
    }
  }
  return {
    tileSpan,
    step: tileSpan / NODES_PER_TILE,
    interval: intervalForSpan(tileSpan),
    levelMin: CONTOUR_LEVEL_MIN,
    levelMax: CONTOUR_LEVEL_MAX,
    majorEvery: MAJOR_EVERY,
  };
}

export interface TerrainContourManagerOptions {
  sourceId: string;
  scaleMetersPerUnit: number;
  getMap: () => maplibregl.Map | null;
  /** The composed field + digest + plain-data inputs (the DEM's own snapshot). */
  getSnapshot: () => { digest: string; inputs: SerializableTerrainInputs } | null;
  getWorker: () => Promise<GenerationWorkerClient | null>;
  /** LRU capacity in leaves (bounded per 036-B). Default 256. */
  maxLeaves?: number;
}

export class TerrainContourManager {
  private engine: TerrainContourLeaves | null = null;
  private engineKey: string | null = null; // digest + LOD signature the engine was built for
  private runId = 0;
  private readonly maxLeaves: number;

  constructor(private readonly opts: TerrainContourManagerOptions) {
    this.maxLeaves = Math.max(1, opts.maxLeaves ?? 256);
  }

  /** Observability (mirrors the engine counters) — leaves computed / evicted so
   * far, for the laziness + LRU assertions. */
  get computedLeaves(): number {
    return this.engine?.computedLeaves ?? 0;
  }
  get evictedLeaves(): number {
    return this.engine?.evictedLeaves ?? 0;
  }

  /** Recompute the contour surface for the current viewport and setData the
   * source. Safe to call on every `moveend`/`idle`; overlapping calls coalesce
   * (a stale run never clobbers a newer one). */
  async update(): Promise<void> {
    const map = this.opts.getMap();
    const snapshot = this.opts.getSnapshot();
    if (!map || !snapshot) {
      this.setData([]);
      return;
    }
    const scale = this.opts.scaleMetersPerUnit;
    const bounds = map.getBounds();
    // Display bounds → gen-space meters (the inverse of demTileLattice sampling).
    const minXm = bounds.getWest() * scale;
    const maxXm = bounds.getEast() * scale;
    // getSouth() < getNorth(); latitude·scale is monotone, so south→minY.
    const minYm = bounds.getSouth() * scale;
    const maxYm = bounds.getNorth() * scale;
    const viewportMeters = Math.max(maxXm - minXm, maxYm - minYm);
    const lod = contourLOD(viewportMeters);

    const engineKey = `${snapshot.digest}|span${lod.tileSpan}|int${lod.interval}`;
    if (!this.engine || this.engineKey !== engineKey) {
      const t = snapshot.inputs;
      this.engine = new TerrainContourLeaves(t.features, {
        base: t.base,
        campaignSeed: t.campaignSeed,
        include: t.include,
        maxLeaves: this.maxLeaves,
        inputMargin: Math.max(600, lod.tileSpan), // a stamp can reach ~a tile out
        ...lod,
      });
      this.engineKey = engineKey;
    }
    const engine = this.engine;
    const inputs = snapshot.inputs;

    const worker = await this.opts.getWorker();
    const trace = worker
      ? (tx: number, ty: number): Promise<GeoJSON.Feature[]> =>
          worker.computeContourLeaf(inputs, tx, ty, lod)
      : undefined;

    const span = lod.tileSpan;
    const tx0 = Math.floor(minXm / span);
    const tx1 = Math.floor((maxXm - 1e-6) / span);
    const ty0 = Math.floor(minYm / span);
    const ty1 = Math.floor((maxYm - 1e-6) / span);

    const runId = ++this.runId;
    const jobs: Promise<GeoJSON.Feature[]>[] = [];
    let count = 0;
    for (let ty = ty0; ty <= ty1 && count < MAX_TILES_PER_UPDATE; ty++) {
      for (let tx = tx0; tx <= tx1 && count < MAX_TILES_PER_UPDATE; tx++) {
        count++;
        jobs.push(engine.leafForAsync(tx, ty, trace).then((r) => r.features));
      }
    }
    const leaves = await Promise.all(jobs);
    // A newer settle superseded us while we awaited — drop this stale paint.
    if (runId !== this.runId) return;

    const out: GeoJSON.Feature[] = [];
    for (const feats of leaves) {
      for (const f of feats) out.push(this.toDisplay(f, scale));
    }
    this.setData(out);
  }

  /** Convert one meter-space leaf feature to a fresh display-unit feature (never
   * mutating the cached leaf). */
  private toDisplay(f: GeoJSON.Feature, scale: number): GeoJSON.Feature {
    const coords = (f.geometry as GeoJSON.LineString).coordinates.map(
      ([x, y]) => [x / scale, y / scale] as [number, number]
    );
    return { ...f, geometry: { type: "LineString", coordinates: coords } };
  }

  private setData(features: GeoJSON.Feature[]): void {
    const map = this.opts.getMap();
    const source = map?.getSource(this.opts.sourceId) as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData({ type: "FeatureCollection", features });
  }

  /** Drop the cached engine (e.g. on campaign switch) so the next update rebuilds
   * from the new campaign's field. */
  reset(): void {
    this.engine = null;
    this.engineKey = null;
  }
}

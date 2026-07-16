import type maplibregl from "maplibre-gl";
import {
  TerrainContourLeaves,
  estimateReliefRange,
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
 * far-out (big tiles) → coarse interval, close-in → fine. This ladder alone is
 * unaware of the campaign's actual relief, so its coarse rungs can exceed the
 * relief range and vanish every line — `intervalFor` caps it (see below). */
export function ladderInterval(tileSpan: number): number {
  if (tileSpan <= 250) return 10;
  if (tileSpan <= 500) return 20;
  if (tileSpan <= 1000) return 25;
  if (tileSpan <= 2000) return 50;
  if (tileSpan <= 4000) return 100;
  if (tileSpan <= 8000) return 200;
  if (tileSpan <= 16000) return 250;
  return 500;
}

/** Target contour-line count across the visible relief (cartographic ~10 lines —
 * index + intermediate). The interval cap is `range / TARGET_CONTOUR_LINES`. */
const TARGET_CONTOUR_LINES = 10;
/** Finest interval (m) — the ladder's own minimum. The cap never goes below it,
 * so close-zoom (`ladderInterval` already ≤ this) is ALWAYS `min(ladder, cap) ===
 * ladder` ⇒ byte-identical to the pre-cap output. */
const CONTOUR_INTERVAL_FLOOR = 10;
/** Nice-number ladder (1 / 2 / 2.5 / 5 per decade) the range-derived cap snaps
 * DOWN to, so an iso-interval reads as a round elevation step. */
const NICE_INTERVALS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000] as const;

/** The largest nice interval that still yields ≥ `TARGET_CONTOUR_LINES` lines
 * across `range` (snap `range/target` DOWN to a nice number), floored at
 * `CONTOUR_INTERVAL_FLOOR`. `range ≤ 0` (flat campaign — no contours anyway) ⇒
 * `Infinity`, i.e. no cap, so the interval stays on its ladder. */
function reliefIntervalCap(range: number): number {
  if (!(range > 0)) return Infinity;
  const raw = range / TARGET_CONTOUR_LINES;
  let cap = CONTOUR_INTERVAL_FLOOR;
  for (const n of NICE_INTERVALS) {
    if (n <= raw) cap = n;
  }
  return cap;
}

/** The contour interval for a LOD: the per-zoom ladder, CAPPED so the campaign's
 * relief range always yields a cartographic line count. The cap only ever LOWERS
 * the coarse (zoomed-out) rungs — where a fixed ladder would climb past the
 * relief and vanish the lines — and never touches the fine rungs (cap ≥ floor =
 * ladder min), keeping close-zoom output byte-stable. */
export function intervalFor(tileSpan: number, reliefRange: number): number {
  return Math.min(ladderInterval(tileSpan), reliefIntervalCap(reliefRange));
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

/**
 * The LOD for a viewport, given the campaign's relief RANGE (from the durable
 * terrain inputs — never the viewport, so a pan never re-intervals). `tileSpan`
 * (and thus `step`) key on the viewport; `interval` keys on span AND range so the
 * lines stay visible at every zoom.
 *
 * SAMPLING FLOOR (pane-independent, NOT a bug): `step = tileSpan/NODES_PER_TILE`
 * and the ladder holds `tileSpan ≈ viewportMeters/TILES_ACROSS`, so `step ≈
 * viewportMeters/150`. Marching-squares only resolves a feature spanning more than
 * a few lattice cells, i.e. while the campaign occupies more than ~3% of the
 * viewport. Zoomed out past that the campaign is a sub-~20px dot with no room to
 * draw contours anyway — the interval cap keeps lines visible across the whole
 * range where the campaign is actually legible; we deliberately do NOT shrink
 * `step` there (it would re-golden the seam lattice for zero visible gain).
 */
function contourLOD(viewportMeters: number, reliefRange: number): ContourLOD {
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
    interval: intervalFor(tileSpan, reliefRange),
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
  // Relief range drives the contour-interval cap; it keys on the DURABLE inputs
  // (digest), never the viewport, so it's memoized per digest — recomputed only
  // when the terrain is edited, never on a pan/zoom.
  private rangeDigest: string | null = null;
  private reliefRange = 0;

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
    // Relief range for the interval cap — memoized per digest (durable inputs).
    if (this.rangeDigest !== snapshot.digest) {
      const t = snapshot.inputs;
      this.reliefRange = estimateReliefRange(t.features, {
        base: t.base,
        campaignSeed: t.campaignSeed,
        include: t.include,
      });
      this.rangeDigest = snapshot.digest;
    }
    const lod = contourLOD(viewportMeters, this.reliefRange);

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
   * from the new campaign's field. Bumps `runId` so an update() still awaiting the
   * OLD campaign's leaves fails its post-await staleness check and never paints
   * those leaves into the new campaign's (restyled, repopulated) source. */
  reset(): void {
    this.engine = null;
    this.engineKey = null;
    this.rangeDigest = null;
    this.reliefRange = 0;
    this.runId++;
  }
}

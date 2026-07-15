import maplibregl from "maplibre-gl";
import type { App } from "obsidian";
import { demTileLattice, latticeToRGBA, type ElevationField } from "../gen/fields";
import type { SerializableTerrainInputs } from "../gen/worker/generationWorker";
import { appendDemTile, getDemTile, demTileKey, type DemTile } from "../model/demCache";

/**
 * Custom protocol serving generated raster-DEM tiles for hillshade + 3D
 * terrain, precedent `pmtilesVaultProtocol.ts`. Fictional campaigns only
 * (real-city elevation isn't supported yet). MapLibre requests
 * `campaigndem://<campaignId>/{z}/{x}/{y}`; we sample the campaign elevation
 * field on that tile's lattice, cache the QUANTIZED INTEGER lattice (the durable
 * determinism record), and encode a terrarium PNG at SERVE time via a canvas —
 * PNG bytes are re-derived, never cached or byte-compared.
 *
 * Serving is entirely OFF the region-generation path: DEM tiles fetch on
 * pan/zoom by design (on demand), but that is field EVALUATION, not
 * procgen — `generatorRunCount` never moves. A DEM tile is just a view over the
 * elevation the mountain sketches already define (no new request surface).
 */

/** DEM raster resolution (px per tile edge). 256 = the terrarium convention;
 * the cached lattice is res² ints. Tunable — the field is smooth, so a coarser
 * lattice would cut cache size at some hillshade crispness. */
export const DEM_TILE_RES = 256;

/** What the handler needs per campaign, re-read live on every tile request so a
 * terrain edit is reflected once the source is refreshed. `snapshot()` returns
 * the FULL composed campaign terrain field (`terrainAt`: base + mountain/relief/
 * landform stamps + river carves + optional grading — plan 036-C/036-D) + a
 * digest fingerprinting every input that can move the field (each stamp's
 * id/seed/params/geometry, river spines, base params, campaign seed, grade-enable,
 * and the vertical scale K); a cached tile whose digest differs is a stale miss. */
export interface DemProvider {
  app: App;
  campaignFolder: string;
  scaleMetersPerUnit: number;
  /** Vertical scale K (demVerticalScale) — constant per campaign. */
  k: number;
  snapshot: () => { field: ElevationField; digest: string; inputs: SerializableTerrainInputs };
  /** Off-thread lattice fill (Jonah 2026-07-15): sample the 256² terrain lattice
   * in the generation worker so a cold DEM fill never stalls the renderer.
   * Returns `null` when the worker is unavailable so the caller falls back to the
   * main-thread `demTileLattice` (byte-identical — same pure function, same
   * inputs). Absent entirely ⇒ always main-thread (e.g. the headless test path). */
  computeLatticeOffThread?: (
    inputs: SerializableTerrainInputs,
    z: number,
    x: number,
    y: number,
    res: number,
    scaleMetersPerUnit: number,
    k: number
  ) => Promise<number[] | null>;
}

const providers = new Map<string, DemProvider>();
let registered = false;

/** Blank (all-zero-height) terrarium RGBA — served when no provider/field is
 * available so MapLibre gets a valid flat DEM instead of an error. */
function flatRGBA(): Uint8ClampedArray {
  // height 0 → terrarium value 32768 → R=128, G=0, B=0.
  const rgba = new Uint8ClampedArray(DEM_TILE_RES * DEM_TILE_RES * 4);
  for (let p = 0; p < DEM_TILE_RES * DEM_TILE_RES; p++) {
    rgba[p * 4] = 128;
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

/** Encode an RGBA lattice to PNG bytes via a canvas (host API; not determinism-
 * bearing). OffscreenCanvas where available (worker-safe), else a DOM canvas. */
async function encodePng(rgba: Uint8ClampedArray, res: number): Promise<ArrayBuffer> {
  // `new Uint8ClampedArray(n)` is ArrayBuffer-backed; the lib typing's generic
  // (`ArrayBufferLike`) just can't prove it for ImageData's parameter.
  const image = new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, res, res);
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(res, res);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("dem: no 2d context (OffscreenCanvas)");
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return blob.arrayBuffer();
  }
  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("dem: no 2d context (canvas)");
  ctx.putImageData(image, 0, 0);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("dem: toBlob failed"))), "image/png")
  );
  return blob.arrayBuffer();
}

/** Parse `campaigndem://<campaignId>/<z>/<x>/<y>` (+ optional `.png`). */
function parseUrl(url: string): { campaignId: string; z: number; x: number; y: number } | null {
  const rest = url.replace(/^campaigndem:\/\//, "");
  const parts = rest.split("/");
  if (parts.length < 4) return null;
  const campaignId = decodeURIComponent(parts[0]);
  const z = parseInt(parts[1], 10);
  const x = parseInt(parts[2], 10);
  const y = parseInt(parts[3].replace(/\.png$/, ""), 10);
  if (!campaignId || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { campaignId, z, x, y };
}

/** An AbortController's signal as a never-resolving promise that REJECTS with an
 * `AbortError` when the controller aborts (matching MapLibre's own abort error
 * name). Lets the protocol handler bail out of a doomed request the instant the
 * camera moves on, instead of holding the (serialized) worker to finish a tile no
 * one will draw. */
function abortError(): Error {
  const e = new Error("AbortError");
  e.name = "AbortError";
  return e;
}
function abortSignalPromise(ac: AbortController): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (ac.signal.aborted) return reject(abortError());
    ac.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

/** Belt-and-suspenders ceiling on how long a single worker DEM job may hold a
 * tile before we give up and fall back to the (byte-identical) main-thread fill.
 * The priority queue (workerClient) already keeps DEM jobs from starving; this
 * only fires if the worker genuinely wedges, so a tile ALWAYS eventually resolves
 * rather than hanging "loading" forever (the "doesn't reliably reappear" report).
 * Generous — main-thread fill is the very stall we moved off-thread, so we only
 * pay it when the worker has clearly failed us. */
const WORKER_DEM_TIMEOUT_MS = 8000;

/**
 * In-flight DEDUPE for lattice computation. Two MapLibre requests can race the
 * same tile (a quick pan-away-and-back, or overlapping raster-dem + hillshade
 * reads); without this both would compute (and, pre-worker, both hit the single
 * worker). Keyed by `campaign:key:digest` so a stale-digest re-fill is a distinct
 * entry. CRITICALLY the entry is cleared in a `finally`, so a FAILED compute
 * leaves nothing behind — the next request retries from scratch (a poisoned entry
 * that never cleared is exactly the "aborted/failed tile never reappears" trap).
 * The shared compute runs to completion regardless of any one requester aborting,
 * so an abort never cancels a tile a concurrent requester still wants. */
const inFlightLattice = new Map<string, Promise<number[]>>();

/** Compute the lattice (worker with timeout → main-thread fallback, both
 * byte-identical) and persist it BEST-EFFORT. Serving is decoupled from
 * persistence: a cache-write failure (vault contention under heavy panning) is
 * swallowed so it can NEVER reject the served tile — a rejected handler marks the
 * MapLibre tile `errored`, which is never re-requested (the "disappears and
 * doesn't reappear" mechanism). The lattice we return is valid regardless of
 * whether the durable write landed; a later request simply recomputes/repersists. */
async function computeAndPersist(
  provider: DemProvider,
  z: number,
  x: number,
  y: number,
  digest: string,
  inputs: SerializableTerrainInputs,
  field: ElevationField
): Promise<number[]> {
  let heights: number[] | null = null;
  if (provider.computeLatticeOffThread) {
    try {
      heights = await Promise.race([
        provider.computeLatticeOffThread(inputs, z, x, y, DEM_TILE_RES, provider.scaleMetersPerUnit, provider.k),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_DEM_TIMEOUT_MS)),
      ]);
    } catch {
      heights = null; // worker error → main-thread fallback keeps the map alive
    }
  }
  if (!heights) heights = demTileLattice(field, z, x, y, DEM_TILE_RES, provider.scaleMetersPerUnit, provider.k);
  const tile: DemTile = {
    key: demTileKey(z, x, y),
    z,
    x,
    y,
    res: DEM_TILE_RES,
    k: provider.k,
    digest,
    heights,
    generatedAt: Date.now(),
  };
  try {
    await appendDemTile(provider.app, provider.campaignFolder, tile);
  } catch {
    // Persist is best-effort — never let a write failure poison the served tile.
  }
  return heights;
}

/** Resolve the height lattice for a tile: cache hit (matching digest) or a
 * deduped compute + persist. Returns the int lattice — the durable,
 * determinism-compared record. */
async function resolveLattice(
  provider: DemProvider,
  campaignId: string,
  z: number,
  x: number,
  y: number
): Promise<number[]> {
  const { field, digest, inputs } = provider.snapshot();
  const cached = await getDemTile(provider.app, provider.campaignFolder, z, x, y);
  if (cached && cached.digest === digest && cached.res === DEM_TILE_RES && cached.k === provider.k) {
    return cached.heights;
  }
  const flightKey = `${campaignId}:${demTileKey(z, x, y)}:${digest}`;
  let pending = inFlightLattice.get(flightKey);
  if (!pending) {
    pending = computeAndPersist(provider, z, x, y, digest, inputs, field).finally(() => {
      inFlightLattice.delete(flightKey);
    });
    inFlightLattice.set(flightKey, pending);
  }
  return pending;
}

/** Register the shared `campaigndem` protocol once (idempotent). */
export function ensureCampaignDemProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("campaigndem", async (params, abortController) => {
    const parsed = parseUrl(params.url);
    const provider = parsed ? providers.get(parsed.campaignId) : undefined;
    if (!parsed || !provider) {
      return { data: await encodePng(flatRGBA(), DEM_TILE_RES) };
    }
    if (abortController?.signal.aborted) throw abortError();
    // Race the (shared, deduped) lattice resolve against the abort signal so a
    // camera move releases this request immediately — the shared compute lives on
    // to warm the cache for whoever draws the tile next. An abort throws
    // AbortError; MapLibre has already flagged its own tile aborted, so it unloads
    // (retryable) rather than marking it errored.
    const latticeP = resolveLattice(provider, parsed.campaignId, parsed.z, parsed.x, parsed.y);
    const heights = abortController
      ? await Promise.race([latticeP, abortSignalPromise(abortController)])
      : await latticeP;
    const rgba = latticeToRGBA(heights, DEM_TILE_RES);
    return { data: await encodePng(rgba, DEM_TILE_RES) };
  });
}

/**
 * Headless twin of one protocol tile request, minus the PNG encode (docs/05:
 * every GM flow needs a modal-free eval path; PNG bytes are deliberately outside
 * the determinism contract). Runs the FULL resolve path — provider snapshot,
 * digest-checked cache read, compute, persisted append — exactly as a MapLibre
 * fetch would, and returns the raw int lattice for numeric comparison by gates.
 */
export async function resolveDemTileForTest(
  campaignId: string,
  z: number,
  x: number,
  y: number
): Promise<number[]> {
  const provider = providers.get(campaignId);
  if (!provider) throw new Error(`no DEM provider registered for campaign ${campaignId}`);
  return resolveLattice(provider, campaignId, z, x, y);
}

/** Point the protocol at a campaign's live field. Called when terrain is enabled
 * / a mountain changes while enabled. */
export function registerDemProvider(campaignId: string, provider: DemProvider): void {
  ensureCampaignDemProtocol();
  providers.set(campaignId, provider);
}

export function unregisterDemProvider(campaignId: string): void {
  providers.delete(campaignId);
}

/** The source URL template for a campaign's DEM (fed to a raster-dem source). */
export function campaignDemUrlTemplate(campaignId: string): string {
  return `campaigndem://${encodeURIComponent(campaignId)}/{z}/{x}/{y}`;
}

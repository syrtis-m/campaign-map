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

/** Resolve the height lattice for a tile: cache hit (matching digest) or compute
 * + persist. Returns the int lattice — the durable, determinism-compared record. */
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
  // Off-thread fill (worker) when available; else the main-thread pure function.
  // Both sample the SAME composed field from the SAME inputs → byte-identical.
  let heights: number[] | null = null;
  if (provider.computeLatticeOffThread) {
    try {
      heights = await provider.computeLatticeOffThread(
        inputs,
        z,
        x,
        y,
        DEM_TILE_RES,
        provider.scaleMetersPerUnit,
        provider.k
      );
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
  await appendDemTile(provider.app, provider.campaignFolder, tile);
  return heights;
}

/** Register the shared `campaigndem` protocol once (idempotent). */
export function ensureCampaignDemProtocol(): void {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol("campaigndem", async (params) => {
    const parsed = parseUrl(params.url);
    const provider = parsed ? providers.get(parsed.campaignId) : undefined;
    if (!parsed || !provider) {
      return { data: await encodePng(flatRGBA(), DEM_TILE_RES) };
    }
    const heights = await resolveLattice(provider, parsed.campaignId, parsed.z, parsed.x, parsed.y);
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

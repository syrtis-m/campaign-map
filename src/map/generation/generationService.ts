/**
 * Host-layer glue between the pure generators in src/gen/ and the vault:
 * tile caching. Not itself a generator (imports Obsidian's App), so it
 * lives outside src/gen/ per CLAUDE.md's host-agnostic rule.
 */
import type { App } from "obsidian";
import type { ParsedCampaign } from "../../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../../model/mutationLog";
import { appendCachedTile, getCachedTile, type CachedTile } from "../../model/tileCache";
import { GENERATION_ZOOM, tileBBox, tileKey } from "../../gen/cache/tileGrid";
import { isCacheRecordFresh } from "../../gen/cache/fingerprint";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints, UpstreamArtifacts } from "../../gen/types";
import type { FabricFeature } from "../../model/fabric";
import { genreForCampaign } from "../../gen/naming/cultures";
import { clipNetworkToTile } from "../../gen/citynet";
import type { ProcgenRegion } from "../../gen/region";

/** Sync (direct pure-generator) or async (worker-dispatched) — `generateTile`
 * awaits either uniformly, so the viewport dispatcher can pass a
 * `(seed, bbox, constraints) => workerClient.generate(...)` closure through
 * the exact same cache path a direct generator call uses. */
export type TileGenerator = (
  seed: number,
  bbox: BBox,
  constraints: GenerationConstraints
) => GeoJSON.Feature[] | Promise<GeoJSON.Feature[]>;

export interface GenerationContext {
  app: App;
  campaign: ParsedCampaign;
  worldBounds: BBox;
  canonFeatures: GeoJSON.Feature[];
  /** Sketched fabric in generation-space (meters): every generator run sees the
   * GM's hand-drawn geometry as constraints. */
  fabricFeatures?: FabricFeature[];
  /** The strictly-lower-stage GENERATED output this region's algorithm consumes
   * (the meandered river channel etc.), built by the host PER region from fresh
   * lower-stage artifacts and threaded to the generator as DATA
   * (`constraints.upstream`). Absent for a region with no upstream coupling ⇒
   * byte-identical to an uncoupled run. A cache HIT never reads it (the bytes
   * are already right). */
  upstream?: UpstreamArtifacts;
}

/** Cache-or-generate a tile. Cached results are returned as-is; a cache hit
 * does not re-check canon (canon changes only take effect via an explicit
 * `regenerateTile` — "regenerate-region never touches notes" cuts both
 * ways: canon changes don't auto-invalidate cached fabric either). */
export async function generateTile(
  ctx: GenerationContext,
  tileX: number,
  tileY: number,
  generatorId: string,
  generator: TileGenerator,
  opts: { force?: boolean } = {}
): Promise<GeoJSON.Feature[]> {
  const campaignFolder = campaignFolderFromConfigPath(ctx.campaign.path);
  const key = tileKey(ctx.campaign.config.seed, tileX, tileY, GENERATION_ZOOM, generatorId);

  if (!opts.force) {
    const cached = await getCachedTile(ctx.app, campaignFolder, key);
    if (cached) return cached.features as unknown as GeoJSON.Feature[];
  }

  const bbox = tileBBox(tileX, tileY);
  // namingGenre was never threaded here before — settlements.ts's `?? "fantasy"`
  // fallback meant every campaign, including real-city ones, silently got
  // fantasy-genre names for generated settlements. Fixed as part of wiring
  // namingCultureIds through (same call site, same underlying gap).
  const constraints: GenerationConstraints = {
    worldBounds: ctx.worldBounds,
    canonFeatures: ctx.canonFeatures,
    fabricFeatures: ctx.fabricFeatures,
    namingGenre: genreForCampaign(ctx.campaign.config.crs, ctx.campaign.config.theme),
    namingCultureIds: ctx.campaign.config.namingCultures,
  };
  const features = await generator(ctx.campaign.config.seed, bbox, constraints);

  await appendCachedTile(ctx.app, campaignFolder, {
    key,
    generatorId,
    tileX,
    tileY,
    zoom: GENERATION_ZOOM,
    campaignSeed: ctx.campaign.config.seed,
    features: features as unknown as Record<string, unknown>[],
    generatedAt: Date.now(),
  });

  return features;
}

/** Sync (direct) or async (worker) whole-region network computation. The
 * closure captures the algorithm id, seed, and params — the service only
 * supplies the (host-built) region and current constraints. */
export type RegionNetworkCompute = (
  region: ProcgenRegion,
  constraints: GenerationConstraints
) => GeoJSON.Feature[] | Promise<GeoJSON.Feature[]>;

/** Whole-region network cache key: the unclipped network artifact, namespaced
 * by region id so two overlapping regions on the same tile never clobber. */
export function regionNetworkKey(regionId: string): string {
  return `region:${regionId}:network`;
}

/** Per-tile clip cache key: `region:<id>:<x>:<y>:<gid>`. */
export function regionTileKey(regionId: string, tileX: number, tileY: number, generatorId: string): string {
  return `region:${regionId}:${tileX}:${tileY}:${generatorId}`;
}

function regionConstraints(ctx: GenerationContext): GenerationConstraints {
  return {
    worldBounds: ctx.worldBounds,
    canonFeatures: ctx.canonFeatures,
    fabricFeatures: ctx.fabricFeatures,
    namingGenre: genreForCampaign(ctx.campaign.config.crs, ctx.campaign.config.theme),
    namingCultureIds: ctx.campaign.config.namingCultures,
    upstream: ctx.upstream,
  };
}

/**
 * Cache-or-compute one tile of a procgen region.
 * The whole-region network is computed ONCE per region — internally
 * sequential growth is legal because every tile that overlaps the region
 * reads the SAME artifact and clips its own bbox from it. Two cache record
 * kinds:
 *   1. the network record (`region:<id>:network`, the whole unclipped
 *      network), and
 *   2. per-tile records (`region:<id>:<x>:<y>:<gid>`), the clip of (1) to the
 *      tile bbox — one record per `tileGeneratorId`, EMPTY BUCKET OR NOT, so
 *      the fast-path present-check below can prove the tile is fully cached.
 *
 * Replay perf: callers replaying the sketch layer MUST pass
 * `opts.preloadedCache` (one file read shared across regions) — per-call
 * `getCachedTile` re-reads the whole JSONL each time.
 */
export async function generateRegionTile(
  ctx: GenerationContext,
  region: ProcgenRegion,
  tileGeneratorIds: readonly string[],
  tileX: number,
  tileY: number,
  computeNetwork: RegionNetworkCompute,
  opts: { force?: boolean; preloadedCache?: Map<string, CachedTile>; fingerprint?: string } = {}
): Promise<GeoJSON.Feature[]> {
  const campaignFolder = campaignFolderFromConfigPath(ctx.campaign.path);
  const seed = ctx.campaign.config.seed;
  const tileKeys = tileGeneratorIds.map((gid) => regionTileKey(region.id, tileX, tileY, gid));

  // A key hit whose stored fingerprint ≠ the caller's current expected
  // fingerprint is STALE (an external `Fabric.geojson` edit no in-app commit
  // path observed) — drop it so the miss below recomputes. Records with no
  // fingerprint and callers that pass none are grandfathered fresh.
  const readCached = async (key: string): Promise<CachedTile | undefined> => {
    const cached = opts.preloadedCache ? opts.preloadedCache.get(key) : await getCachedTile(ctx.app, campaignFolder, key);
    if (cached && !isCacheRecordFresh(cached.fingerprint, opts.fingerprint)) return undefined;
    return cached;
  };

  // Fast path: every per-tile record already cached AND fresh (bytes are
  // canonical — returning them as-is is what keeps delete-and-regen byte-identical).
  if (!opts.force) {
    const hits = await Promise.all(tileKeys.map(readCached));
    if (hits.every((h) => h !== undefined)) {
      return hits.flatMap((h) => h!.features as unknown as GeoJSON.Feature[]);
    }
  }

  // Network record: cache-or-compute once per region.
  const netKey = regionNetworkKey(region.id);
  let network: GeoJSON.Feature[];
  const cachedNet = opts.force ? undefined : await readCached(netKey);
  if (cachedNet) {
    network = cachedNet.features as unknown as GeoJSON.Feature[];
  } else {
    network = await computeNetwork(region, regionConstraints(ctx));
    const record: CachedTile = {
      key: netKey,
      generatorId: "region-network",
      tileX: 0,
      tileY: 0,
      zoom: GENERATION_ZOOM,
      campaignSeed: seed,
      features: network as unknown as Record<string, unknown>[],
      generatedAt: Date.now(),
      fingerprint: opts.fingerprint,
    };
    await appendCachedTile(ctx.app, campaignFolder, record);
    opts.preloadedCache?.set(netKey, record);
  }

  // Clip to this tile and persist the per-tile records MapView paints.
  const buckets = clipNetworkToTile(network, tileBBox(tileX, tileY));
  const out: GeoJSON.Feature[] = [];
  for (let i = 0; i < tileGeneratorIds.length; i++) {
    const gid = tileGeneratorIds[i];
    const features = buckets[gid] ?? [];
    const record: CachedTile = {
      key: tileKeys[i],
      generatorId: gid,
      tileX,
      tileY,
      zoom: GENERATION_ZOOM,
      campaignSeed: seed,
      features: features as unknown as Record<string, unknown>[],
      generatedAt: Date.now(),
      fingerprint: opts.fingerprint,
    };
    await appendCachedTile(ctx.app, campaignFolder, record);
    opts.preloadedCache?.set(tileKeys[i], record);
    out.push(...features);
  }
  return out;
}

/** Explicit regeneration — bypasses the cache, re-runs the generator against
 * current canon constraints, overwrites the cached record. */
export async function regenerateTile(
  ctx: GenerationContext,
  tileX: number,
  tileY: number,
  generatorId: string,
  generator: TileGenerator
): Promise<GeoJSON.Feature[]> {
  return generateTile(ctx, tileX, tileY, generatorId, generator, { force: true });
}

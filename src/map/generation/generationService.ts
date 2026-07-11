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
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";
import type { FabricFeature } from "../../model/fabric";
import { genreForCampaign } from "../../gen/naming/cultures";
import {
  anchorCellForPoint,
  clipNetworkToTile,
  domainBBox,
  DOMAIN_TILE_GENERATOR_IDS,
  type CityDomain,
} from "../../gen/citynet";

/** Sync (direct pure-generator) or async (worker-dispatched) — `generateTile`
 * awaits either uniformly, so the Phase 4 viewport dispatcher can pass a
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
  /** Sketched fabric in generation-space (meters) — plan 019 Phase 3:
   * every generator run sees the GM's hand-drawn geometry as constraints. */
  fabricFeatures?: FabricFeature[];
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

/** The generatorId under which a whole-domain network record is cached —
 * keyed at the domain's 30 m anchor cell, not a 600 m tile (design §3.3). */
export const NETWORK_GENERATOR_ID = "city-network";

/** Sync (direct) or async (worker) whole-domain network computation. `seed`
 * is the campaign seed — implementations derive the citySeed. */
export type NetworkCompute = (
  seed: number,
  domain: CityDomain,
  bbox: BBox,
  constraints: GenerationConstraints
) => GeoJSON.Feature[] | Promise<GeoJSON.Feature[]>;

/** Cache key of a domain's whole-network record. */
export function networkKeyFor(campaignSeed: number, domain: CityDomain): string {
  const { cellX, cellY } = anchorCellForPoint(domain.cx, domain.cy);
  return tileKey(campaignSeed, cellX, cellY, GENERATION_ZOOM, NETWORK_GENERATOR_ID);
}

function domainConstraints(ctx: GenerationContext): GenerationConstraints {
  return {
    worldBounds: ctx.worldBounds,
    canonFeatures: ctx.canonFeatures,
    fabricFeatures: ctx.fabricFeatures,
    namingGenre: genreForCampaign(ctx.campaign.config.crs, ctx.campaign.config.theme),
    namingCultureIds: ctx.campaign.config.namingCultures,
  };
}

/**
 * Procgen v3 (design §3.3): cache-or-compute one tile of a city domain.
 * The whole-domain network is computed ONCE per domain — internally
 * sequential growth is legal because every tile that overlaps the domain
 * reads the SAME artifact and clips its own bbox from it (the halo argument
 * taken to its limit: halo = the whole city). Two cache record kinds:
 *   1. the network record (`city-network`, keyed at the domain anchor cell,
 *      the whole unclipped network), and
 *   2. per-tile records (`city-street`/`city-landmark`/... — exactly the
 *      shape MapView already paints), the clip of (1) to the tile bbox.
 *
 * Replay perf (explainer §6 applies doubly): callers replaying a manifest
 * MUST pass `opts.preloadedCache` (one file read shared across entries) —
 * per-call `getCachedTile` re-reads the whole JSONL each time.
 */
export async function generateDomainTile(
  ctx: GenerationContext,
  domain: CityDomain,
  tileX: number,
  tileY: number,
  computeNetwork: NetworkCompute,
  opts: { force?: boolean; preloadedCache?: Map<string, CachedTile> } = {}
): Promise<GeoJSON.Feature[]> {
  const campaignFolder = campaignFolderFromConfigPath(ctx.campaign.path);
  const seed = ctx.campaign.config.seed;
  const tileKeys = DOMAIN_TILE_GENERATOR_IDS.map((gid) =>
    tileKey(seed, tileX, tileY, GENERATION_ZOOM, gid)
  );

  const readCached = async (key: string): Promise<CachedTile | undefined> =>
    opts.preloadedCache ? opts.preloadedCache.get(key) : getCachedTile(ctx.app, campaignFolder, key);

  // Fast path: every per-tile record already cached (bytes are canonical —
  // returning them as-is is what keeps delete-and-regen byte-identical).
  if (!opts.force) {
    const hits = await Promise.all(tileKeys.map(readCached));
    if (hits.every((h) => h !== undefined)) {
      return hits.flatMap((h) => h!.features as unknown as GeoJSON.Feature[]);
    }
  }

  // Network record: cache-or-compute once per domain.
  const netKey = networkKeyFor(seed, domain);
  const { cellX, cellY } = anchorCellForPoint(domain.cx, domain.cy);
  let network: GeoJSON.Feature[];
  const cachedNet = opts.force ? undefined : await readCached(netKey);
  if (cachedNet) {
    network = cachedNet.features as unknown as GeoJSON.Feature[];
  } else {
    network = await computeNetwork(seed, domain, domainBBox(domain), domainConstraints(ctx));
    const record: CachedTile = {
      key: netKey,
      generatorId: NETWORK_GENERATOR_ID,
      tileX: cellX,
      tileY: cellY,
      zoom: GENERATION_ZOOM,
      campaignSeed: seed,
      features: network as unknown as Record<string, unknown>[],
      generatedAt: Date.now(),
    };
    await appendCachedTile(ctx.app, campaignFolder, record);
    opts.preloadedCache?.set(netKey, record);
  }

  // Clip to this tile and persist the per-tile records MapView paints.
  const buckets = clipNetworkToTile(network, tileBBox(tileX, tileY));
  const out: GeoJSON.Feature[] = [];
  for (let i = 0; i < DOMAIN_TILE_GENERATOR_IDS.length; i++) {
    const gid = DOMAIN_TILE_GENERATOR_IDS[i];
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

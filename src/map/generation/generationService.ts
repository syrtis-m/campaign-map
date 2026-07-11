/**
 * Host-layer glue between the pure generators in src/gen/ and the vault:
 * tile caching. Not itself a generator (imports Obsidian's App), so it
 * lives outside src/gen/ per CLAUDE.md's host-agnostic rule.
 */
import type { App } from "obsidian";
import type { ParsedCampaign } from "../../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../../model/mutationLog";
import { appendCachedTile, getCachedTile } from "../../model/tileCache";
import { GENERATION_ZOOM, tileBBox, tileKey } from "../../gen/cache/tileGrid";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";
import type { FabricFeature } from "../../model/fabric";
import { genreForCampaign } from "../../gen/naming/cultures";

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

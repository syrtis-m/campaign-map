/**
 * Host-layer glue between the pure generators in src/gen/ and the vault:
 * tile caching, and canonization ("canonize = create the note, remove from
 * cache" — docs/02 §5 amendment). Not itself a generator (imports Obsidian's
 * App), so it lives outside src/gen/ per CLAUDE.md's host-agnostic rule.
 */
import type { App } from "obsidian";
import type { ParsedCampaign } from "../../model/campaignConfig";
import { campaignFolderFromConfigPath } from "../../model/mutationLog";
import { appendCachedTile, getCachedTile } from "../../model/tileCache";
import { GENERATION_ZOOM, tileBBox, tileKey, tileXYForPoint } from "../../gen/cache/tileGrid";
import type { BBox } from "../../gen/spatialHash";
import type { GenerationConstraints } from "../../gen/types";

export type TileGenerator = (seed: number, bbox: BBox, constraints: GenerationConstraints) => GeoJSON.Feature[];

export interface GenerationContext {
  app: App;
  campaign: ParsedCampaign;
  worldBounds: BBox;
  canonFeatures: GeoJSON.Feature[];
}

export interface LocationCreator {
  createLocationFromFeature(campaignId: string, feature: GeoJSON.Feature, name: string, type: string): Promise<void>;
}

/** A generated feature's own centroid — used to key which tile's cache entry to strip after canonizing. */
function featureAnchorPoint(feature: GeoJSON.Feature): [number, number] {
  const g = feature.geometry;
  if (g.type === "Point") return g.coordinates as [number, number];
  if (g.type === "LineString") {
    const coords = g.coordinates as [number, number][];
    return coords[Math.floor(coords.length / 2)];
  }
  if (g.type === "Polygon") {
    const ring = g.coordinates[0] as [number, number][];
    const [sx, sy] = ring.reduce(([ax, ay], [bx, by]) => [ax + bx, ay + by], [0, 0]);
    return [sx / ring.length, sy / ring.length];
  }
  throw new Error(`unsupported geometry type for canonization: ${g.type}`);
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
  const constraints: GenerationConstraints = { worldBounds: ctx.worldBounds, canonFeatures: ctx.canonFeatures };
  const features = generator(ctx.campaign.config.seed, bbox, constraints);

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

/**
 * Promotes a generated feature to canon: creates its location note (a plain
 * point note for Point geometry, note + sidecar .geojson for lines/polygons
 * — "complex geometry → sidecar .geojson", CLAUDE.md), then strips the
 * feature out of its cached tile record so it stops being rendered twice.
 *
 * `feature` must be in the same coordinate space as `ctx` (generation-space
 * — meters for fictional campaigns, since a tile's cache key is derived
 * from that space). If the note itself needs different coordinates (a
 * fictional campaign's display units aren't meters), pass `noteFeature`
 * separately; it defaults to `feature` for callers with no such split.
 */
export async function canonizeFeature(
  ctx: GenerationContext,
  locations: LocationCreator,
  feature: GeoJSON.Feature,
  name: string,
  type: string,
  noteFeature: GeoJSON.Feature = feature
): Promise<void> {
  await locations.createLocationFromFeature(ctx.campaign.id, noteFeature, name, type);

  const [x, y] = featureAnchorPoint(feature);
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const generatorId = properties.generatorId as string | undefined;
  if (!generatorId) return;

  const campaignFolder = campaignFolderFromConfigPath(ctx.campaign.path);
  const { tileX, tileY } = tileXYForPoint(x, y);
  const key = tileKey(ctx.campaign.config.seed, tileX, tileY, GENERATION_ZOOM, generatorId);
  const cached = await getCachedTile(ctx.app, campaignFolder, key);
  if (!cached) return;

  const remaining = (cached.features as unknown as GeoJSON.Feature[]).filter((f) => f.id !== feature.id);
  await appendCachedTile(ctx.app, campaignFolder, {
    ...cached,
    features: remaining as unknown as Record<string, unknown>[],
    generatedAt: Date.now(),
  });
}

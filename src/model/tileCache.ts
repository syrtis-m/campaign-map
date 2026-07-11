import { z } from "zod";
import type { App } from "obsidian";

/**
 * Regenerable generated-content cache (CLAUDE.md locked decision):
 * "Generated content = regenerable JSONL cache in .mapcache/ (deterministic
 * → deletable, sync-excluded, conflict-immune); no SQLite." Same
 * log-structured append pattern as mutationLog.ts: appending a record with
 * an existing key logically overwrites it (last write wins on replay),
 * which makes "regenerate a tile" a cheap append rather than an in-place
 * file edit.
 */
export const CachedTileSchema = z.object({
  key: z.string(),
  generatorId: z.string(),
  tileX: z.number(),
  tileY: z.number(),
  zoom: z.number(),
  campaignSeed: z.number(),
  features: z.array(z.record(z.string(), z.unknown())),
  generatedAt: z.number(),
});
export type CachedTile = z.infer<typeof CachedTileSchema>;

function cachePath(campaignFolder: string): string {
  return `${campaignFolder}/.mapcache/generated.jsonl`;
}

export async function appendCachedTile(app: App, campaignFolder: string, tile: CachedTile): Promise<void> {
  const path = cachePath(campaignFolder);
  const dir = `${campaignFolder}/.mapcache`;
  if (!(await app.vault.adapter.exists(dir))) {
    await app.vault.adapter.mkdir(dir);
  }
  const line = JSON.stringify(tile) + "\n";
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.append(path, line);
  } else {
    await app.vault.adapter.write(path, line);
  }
}

/** Replays the log, keeping only the latest record per key. */
export async function readCachedTiles(app: App, campaignFolder: string): Promise<Map<string, CachedTile>> {
  const path = cachePath(campaignFolder);
  if (!(await app.vault.adapter.exists(path))) return new Map();
  const raw = await app.vault.adapter.read(path);
  const out = new Map<string, CachedTile>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const tile = CachedTileSchema.parse(JSON.parse(line));
    out.set(tile.key, tile);
  }
  return out;
}

export async function getCachedTile(app: App, campaignFolder: string, key: string): Promise<CachedTile | undefined> {
  const tiles = await readCachedTiles(app, campaignFolder);
  return tiles.get(key);
}

/**
 * Removes specific tile records (plan 019 "Clear generated fabric here"):
 * rewrites the log without the given keys, so a later generate on the same
 * tile is a true cache MISS and regenerates — an empty-features tombstone
 * append would instead read back as "cached: nothing", silently blanking
 * future generates. Compacts last-write-wins duplicates as a side effect.
 */
export async function removeCachedTiles(app: App, campaignFolder: string, keys: string[]): Promise<void> {
  const path = cachePath(campaignFolder);
  if (!(await app.vault.adapter.exists(path))) return;
  const tiles = await readCachedTiles(app, campaignFolder);
  for (const key of keys) tiles.delete(key);
  const lines = [...tiles.values()].map((t) => JSON.stringify(t) + "\n").join("");
  await app.vault.adapter.write(path, lines);
}

/** Deleting this file must be harmless — the next request just regenerates
 * (CLAUDE.md quality bar: "Deleting .mapcache/ must be harmless"). */
export async function clearGeneratedCache(app: App, campaignFolder: string): Promise<void> {
  const path = cachePath(campaignFolder);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
}

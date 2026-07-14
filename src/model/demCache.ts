import { z } from "zod";
import type { App } from "obsidian";

/**
 * Raw-lattice DEM cache (plan 023 §4.2) — the DURABLE determinism record behind
 * hillshade + 3D terrain. Same log-structured `.mapcache/` discipline as
 * `tileCache.ts` (append = logical overwrite by key; last write wins on replay;
 * deleting the file is harmless — it regenerates identically). SEPARATE file
 * (`dem.jsonl`) from the vector `generated.jsonl` so the two never interleave.
 *
 * We cache the QUANTIZED INTEGER TERRARIUM-ELEVATION LATTICE (`demTileLattice`),
 * NOT the served PNG: PNG bytes vary across canvas/zlib versions and are not a
 * determinism surface (§4.2 DEM-determinism trap). The handler re-encodes the
 * lattice to a terrarium PNG at serve time; determinism gates compare these
 * height arrays, never PNGs.
 *
 * `digest` fingerprints the mountain set + vertical scale that produced the
 * lattice: a cached record whose digest ≠ the current one is a stale MISS
 * (a mountain was edited/re-rolled), so a mountain change is picked up without
 * any reactive tile-invalidation machinery. Keyed by `z:x:y` (one live record
 * per tile), so the cache never explodes across edits.
 */
export const DemTileSchema = z.object({
  key: z.string(),
  z: z.number(),
  x: z.number(),
  y: z.number(),
  res: z.number(),
  k: z.number(),
  digest: z.string(),
  heights: z.array(z.number()),
  generatedAt: z.number(),
});
export type DemTile = z.infer<typeof DemTileSchema>;

export function demTileKey(z: number, x: number, y: number): string {
  return `dem:${z}:${x}:${y}`;
}

function demCachePath(campaignFolder: string): string {
  return `${campaignFolder}/.mapcache/dem.jsonl`;
}

/** Per-file write chain (see tileCache.ts): serialize the exists→append-or-write
 * decision so racing writers on a freshly deleted file can't both truncate. */
const writeChains = new Map<string, Promise<void>>();

export function appendDemTile(app: App, campaignFolder: string, tile: DemTile): Promise<void> {
  const path = demCachePath(campaignFolder);
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
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
  });
  writeChains.set(
    path,
    next.catch(() => {})
  );
  return next;
}

/** Replays the log, keeping only the latest record per key. */
export async function readDemTiles(app: App, campaignFolder: string): Promise<Map<string, DemTile>> {
  const path = demCachePath(campaignFolder);
  if (!(await app.vault.adapter.exists(path))) return new Map();
  const raw = await app.vault.adapter.read(path);
  const out = new Map<string, DemTile>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const tile = DemTileSchema.parse(JSON.parse(line));
      out.set(tile.key, tile);
    } catch {
      // Skip a malformed line rather than crash the whole DEM path (a partial
      // write from a crash mid-append) — the tile just regenerates.
    }
  }
  return out;
}

export async function getDemTile(
  app: App,
  campaignFolder: string,
  z: number,
  x: number,
  y: number
): Promise<DemTile | undefined> {
  const tiles = await readDemTiles(app, campaignFolder);
  return tiles.get(demTileKey(z, x, y));
}

/** Deleting this file must be harmless — the next request regenerates identical
 * height lattices (CLAUDE.md quality bar). */
export async function clearDemCache(app: App, campaignFolder: string): Promise<void> {
  const path = demCachePath(campaignFolder);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
}

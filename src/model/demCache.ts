import { z } from "zod";
import type { App } from "obsidian";

/**
 * Raw-lattice DEM cache — the DURABLE determinism record behind hillshade + 3D
 * terrain. Same log-structured `.mapcache/` discipline as
 * `tileCache.ts` (append = logical overwrite by key; last write wins on replay;
 * deleting the file is harmless — it regenerates identically). SEPARATE file
 * (`dem.jsonl`) from the vector `generated.jsonl` so the two never interleave.
 *
 * We cache the QUANTIZED INTEGER TERRARIUM-ELEVATION LATTICE (`demTileLattice`),
 * NOT the served PNG: PNG bytes vary across canvas/zlib versions and are not a
 * determinism surface. The handler re-encodes the
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

/**
 * PERSISTENT IN-MEMORY VIEW (Jonah 2026-07-15, the 032-B pattern for DEM). The
 * `dem.jsonl` log is append-only: every stale-digest re-fill of a tile appends a
 * fresh record on top of the superseded one, so the file grows without bound
 * across a pan-heavy session, and — the sting — the old `getDemTile` re-`read`
 * and re-`parse`d the WHOLE file on EVERY tile request (a cold 9-tile camera move
 * re-parsed it 9×). With ~65k-int height arrays per record that is tens-to-
 * hundreds of MB of JSON re-parsed on the MAIN THREAD per request within minutes
 * of panning — the "slow even when nothing is generating" stall.
 *
 * The fix: replay the log ONCE per session into a live-record Map, serve reads
 * from memory (O(1), no file touch), and append THROUGH the map (memory + disk
 * stay in lock-step, ordered by the write chain). The lattice ints served are
 * byte-identical to the log's last-write-wins record — this is purely an IO/parse
 * change, never a determinism-surface one.
 *
 * Keyed by `App` (a WeakMap) so the single production app shares one view while
 * parallel test adapters (each a fresh fake `App`) stay isolated.
 */
const viewCache = new WeakMap<App, Map<string, Promise<Map<string, DemTile>>>>();

function viewsFor(app: App): Map<string, Promise<Map<string, DemTile>>> {
  let m = viewCache.get(app);
  if (!m) {
    m = new Map();
    viewCache.set(app, m);
  }
  return m;
}

/** Parse a raw log into its live-record Map (last-write-wins per key), skipping
 * malformed lines (a partial write from a crash mid-append). Returns the map and
 * the total non-blank line count, so the caller can tell whether superseded
 * duplicates make the on-disk log longer than the live set (⇒ compact). */
function replayLog(raw: string): { map: Map<string, DemTile>; lines: number } {
  const map = new Map<string, DemTile>();
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      const tile = DemTileSchema.parse(JSON.parse(line));
      map.set(tile.key, tile);
    } catch {
      // Skip a malformed line rather than crash the whole DEM path.
    }
  }
  return { map, lines };
}

/** Load (once per session) the live-record view of a campaign's `dem.jsonl`.
 * Compacts the log on load when superseded records have made it longer than the
 * live set — rewriting one line per key bounds the file's growth. The compaction
 * write is awaited INSIDE the memoized load promise, and every `appendDemTile`
 * awaits this same promise before its own chained write, so no append can
 * interleave with (and be clobbered by) the rewrite. */
function loadDemView(app: App, campaignFolder: string): Promise<Map<string, DemTile>> {
  const path = demCachePath(campaignFolder);
  const views = viewsFor(app);
  const cached = views.get(path);
  if (cached) return cached;
  const loaded = (async (): Promise<Map<string, DemTile>> => {
    if (!(await app.vault.adapter.exists(path))) return new Map();
    const raw = await app.vault.adapter.read(path);
    const { map, lines } = replayLog(raw);
    if (lines > map.size) {
      // Compact: the log carried superseded/duplicate records. Rewrite it to the
      // live set (integer heights round-trip exactly; dem PNGs are re-encoded, so
      // this is never byte-compared). Harmless if it fails — the log stays valid.
      const body = [...map.values()].map((t) => JSON.stringify(t)).join("\n") + "\n";
      await app.vault.adapter.write(path, body).catch(() => {});
    }
    return map;
  })();
  views.set(path, loaded);
  return loaded;
}

export function appendDemTile(app: App, campaignFolder: string, tile: DemTile): Promise<void> {
  const path = demCachePath(campaignFolder);
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Await the (memoized) load+compaction first, so appends never race the
    // compaction rewrite and the in-memory view is authoritative before we
    // mutate it. Then update memory + disk in the same serialized step, so the
    // view's last-write-wins order matches the log's append order exactly.
    const view = await loadDemView(app, campaignFolder);
    view.set(tile.key, tile);
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

/** The latest record per key — served from the in-memory view (loaded once).
 * Returns a copy so callers can't mutate the live view. */
export async function readDemTiles(app: App, campaignFolder: string): Promise<Map<string, DemTile>> {
  return new Map(await loadDemView(app, campaignFolder));
}

export async function getDemTile(
  app: App,
  campaignFolder: string,
  z: number,
  x: number,
  y: number
): Promise<DemTile | undefined> {
  const view = await loadDemView(app, campaignFolder);
  return view.get(demTileKey(z, x, y));
}

/** Deleting this file must be harmless — the next request regenerates identical
 * height lattices (CLAUDE.md quality bar). Drops the in-memory view too, so a
 * later read re-loads from disk (empty) rather than serving stale records. */
export async function clearDemCache(app: App, campaignFolder: string): Promise<void> {
  const path = demCachePath(campaignFolder);
  viewsFor(app).delete(path);
  if (await app.vault.adapter.exists(path)) {
    await app.vault.adapter.remove(path);
  }
}

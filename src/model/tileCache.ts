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
 *
 * SHARDED (plan 032-A): records no longer live in one monolithic
 * `generated.jsonl`. Each region's records go to `region-<id>.jsonl` and
 * world-tier records to `world.jsonl`, so a drop is a per-shard file
 * delete/rewrite (not a whole-cache rewrite — research P6 write-amplification:
 * a 10-region cascade was ~3.4 GB of vault IO) and a read/append scopes to the
 * shard a caller needs. Keys are DISJOINT across shards by construction (a
 * `region:<id>:…` key always maps to that region's shard, every other key to
 * `world.jsonl`), so merging shards on read never has to resolve cross-shard
 * key collisions. Still JSONL in `.mapcache/`: the locked decision holds.
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
  /** Canonical hash of the durable inputs that produced this record (region
   * seed/version/params + quantized ring/spine + raw-sketch
   * constraints — see `src/gen/cache/fingerprint.ts`). Replay treats a key hit
   * whose fingerprint ≠ the current one as a MISS and recomputes, catching an
   * external `Fabric.geojson` edit that no in-app commit path observed.
   * OPTIONAL for back-compat: records without one are grandfathered as fresh
   * (`isCacheRecordFresh`), so opening an existing campaign never triggers a
   * regen storm and deleting `.mapcache/` stays harmless. */
  fingerprint: z.string().optional(),
});
export type CachedTile = z.infer<typeof CachedTileSchema>;

function cacheDir(campaignFolder: string): string {
  return `${campaignFolder}/.mapcache`;
}

/** The pre-032 monolith path. Present only until the first read/append/remove
 * migrates it into shards; then removed. */
function monolithPath(campaignFolder: string): string {
  return `${cacheDir(campaignFolder)}/generated.jsonl`;
}

/** The shard basename a record key belongs to. `region:<id>:…` → that region's
 * own file; everything else (world-tier `tileKey`s, which start with the
 * numeric campaign seed) → the shared `world.jsonl`. Region ids are
 * `makeFabricId()` output (`fabric-<b36>-<b36>`) — no colons or slashes — so
 * the second colon-delimited segment is a filename-safe id. */
export function cacheShardBasename(key: string): string {
  if (key.startsWith("region:")) {
    const rest = key.slice("region:".length);
    const id = rest.slice(0, rest.indexOf(":") === -1 ? rest.length : rest.indexOf(":"));
    return `region-${id}.jsonl`;
  }
  return "world.jsonl";
}

/** True for a file basename this module owns (a cache shard). Excludes the
 * sibling `log.jsonl` / `dem.jsonl` and any non-cache file in `.mapcache/`. */
function isCacheShard(basename: string): boolean {
  return basename === "world.jsonl" || (basename.startsWith("region-") && basename.endsWith(".jsonl"));
}

function shardPath(campaignFolder: string, key: string): string {
  return `${cacheDir(campaignFolder)}/${cacheShardBasename(key)}`;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ─── One-time monolith → shard migration ────────────────────────────────────

/** In-flight migration per campaign folder, so concurrent reads/appends share
 * one split (each read/append/remove awaits this before touching a shard). Not
 * a permanent memo: `migrateMonolith` short-circuits on `exists()` once the
 * monolith is gone, so re-running is a cheap no-op and a freshly-dropped
 * monolith (a downgrade + upgrade round-trip) is still picked up. */
const migrationLocks = new Map<string, Promise<void>>();

/**
 * Split a pre-032 `generated.jsonl` into per-region + world shards, then delete
 * it. STREAMING by line — we JSON.parse each line ONLY to read its `.key` for
 * routing and write the ORIGINAL line verbatim, so we never hold the parsed
 * (zod-walked) whole in memory and record bytes are carried over BYTE-IDENTICALLY
 * (the plan's hard STOP condition: a pinned-old region renders cache-only, so
 * its network record must survive the split unchanged or the region blanks).
 * Idempotent: shards are truncate-written from the monolith (the sole source of
 * truth until it is removed last), so a crash mid-split re-derives them cleanly
 * on the next call.
 */
async function migrateMonolith(app: App, campaignFolder: string): Promise<void> {
  const monolith = monolithPath(campaignFolder);
  if (!(await app.vault.adapter.exists(monolith))) return;
  const raw = await app.vault.adapter.read(monolith);
  const byShard = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let key: unknown;
    try {
      key = (JSON.parse(line) as { key?: unknown }).key;
    } catch {
      continue; // skip a corrupt line rather than abort the whole migration
    }
    if (typeof key !== "string") continue;
    const base = cacheShardBasename(key);
    const lines = byShard.get(base) ?? [];
    if (lines.length === 0) byShard.set(base, lines);
    lines.push(line);
  }
  const dir = cacheDir(campaignFolder);
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  for (const [base, lines] of byShard) {
    await app.vault.adapter.write(`${dir}/${base}`, lines.join("\n") + "\n");
  }
  await app.vault.adapter.remove(monolith);
}

function ensureMigrated(app: App, campaignFolder: string): Promise<void> {
  const inflight = migrationLocks.get(campaignFolder);
  if (inflight) return inflight;
  const p = migrateMonolith(app, campaignFolder).finally(() => migrationLocks.delete(campaignFolder));
  migrationLocks.set(campaignFolder, p);
  return p;
}

// ─── Reads / writes / drops ─────────────────────────────────────────────────

/** Per-shard write chain: concurrent appends to the SAME shard (e.g. a forced
 * region pass writing its network then per-tile records) must serialize,
 * because the exists→append-or-write decision below is not atomic — two writers
 * racing on a freshly-deleted shard both see exists=false and both take the
 * truncating `write` branch, silently clobbering the first record. Keyed by
 * shard path, so appends to DIFFERENT shards (different regions / world) now run
 * concurrently instead of behind one global chain. */
const writeChains = new Map<string, Promise<void>>();

export function appendCachedTile(app: App, campaignFolder: string, tile: CachedTile): Promise<void> {
  const path = shardPath(campaignFolder, tile.key);
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    await ensureMigrated(app, campaignFolder);
    const dir = cacheDir(campaignFolder);
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
  // Keep the chain alive past a failed write; the caller still sees the error.
  writeChains.set(
    path,
    next.catch(() => {})
  );
  return next;
}

/** Replays every shard, keeping only the latest record per key. Keys are
 * disjoint across shards, so the cross-shard merge order is irrelevant; only
 * the within-shard line order (last-write-wins) matters and it is preserved. */
export async function readCachedTiles(app: App, campaignFolder: string): Promise<Map<string, CachedTile>> {
  await ensureMigrated(app, campaignFolder);
  const dir = cacheDir(campaignFolder);
  if (!(await app.vault.adapter.exists(dir))) return new Map();
  const listing = await app.vault.adapter.list(dir);
  const out = new Map<string, CachedTile>();
  for (const filePath of listing.files) {
    if (!isCacheShard(basenameOf(filePath))) continue;
    const raw = await app.vault.adapter.read(filePath);
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const tile = CachedTileSchema.parse(JSON.parse(line));
      out.set(tile.key, tile);
    }
  }
  return out;
}

export async function getCachedTile(app: App, campaignFolder: string, key: string): Promise<CachedTile | undefined> {
  await ensureMigrated(app, campaignFolder);
  const path = shardPath(campaignFolder, key);
  if (!(await app.vault.adapter.exists(path))) return undefined;
  const raw = await app.vault.adapter.read(path);
  let found: CachedTile | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const tile = CachedTileSchema.parse(JSON.parse(line));
    if (tile.key === key) found = tile; // last-write-wins
  }
  return found;
}

/**
 * Removes specific tile records ("Clear generated fabric here"), grouped by
 * shard: rewrites each affected shard without the given keys — or DELETES the
 * shard file outright when nothing remains (the common case: dropping a region
 * passes its whole key set, emptying its shard). A later generate on a dropped
 * key is then a true cache MISS and regenerates — an empty-features tombstone
 * append would instead read back as "cached: nothing", silently blanking future
 * generates. Compacts last-write-wins duplicates in a rewritten shard as a side
 * effect. Only the shards a key touches are read/written; sibling shards
 * (other regions, world) are never rewritten (research P6).
 */
export async function removeCachedTiles(app: App, campaignFolder: string, keys: string[]): Promise<void> {
  await ensureMigrated(app, campaignFolder);
  const byShard = new Map<string, Set<string>>();
  for (const key of keys) {
    const base = cacheShardBasename(key);
    const set = byShard.get(base) ?? new Set<string>();
    if (set.size === 0) byShard.set(base, set);
    set.add(key);
  }
  for (const [base, dropSet] of byShard) {
    const path = `${cacheDir(campaignFolder)}/${base}`;
    if (!(await app.vault.adapter.exists(path))) continue;
    const raw = await app.vault.adapter.read(path);
    const kept = new Map<string, string>(); // key → last raw line (compaction)
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let key: unknown;
      try {
        key = (JSON.parse(line) as { key?: unknown }).key;
      } catch {
        continue;
      }
      if (typeof key !== "string" || dropSet.has(key)) continue;
      kept.set(key, line);
    }
    if (kept.size === 0) {
      await app.vault.adapter.remove(path);
    } else {
      await app.vault.adapter.write(path, [...kept.values()].join("\n") + "\n");
    }
  }
}

/** Deleting the cache must be harmless — the next request just regenerates
 * (CLAUDE.md quality bar: "Deleting .mapcache/ must be harmless"). Removes every
 * cache shard (plus a leftover pre-032 monolith), leaving any sibling
 * `log.jsonl` / `dem.jsonl` untouched. */
export async function clearGeneratedCache(app: App, campaignFolder: string): Promise<void> {
  const dir = cacheDir(campaignFolder);
  if (!(await app.vault.adapter.exists(dir))) return;
  const listing = await app.vault.adapter.list(dir);
  for (const filePath of listing.files) {
    const base = basenameOf(filePath);
    if (isCacheShard(base) || base === "generated.jsonl") {
      await app.vault.adapter.remove(filePath);
    }
  }
}

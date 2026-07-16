import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  appendCachedTile,
  removeCachedTiles,
  readCachedTiles,
  cacheShardBasename,
  type CachedTile,
} from "./tileCache";

/**
 * Serialization discipline for the generated-cache shards (ARCHITECTURE §12
 * invariant #16: "cache appends serialize through the per-file promise chain").
 *
 * The write chain exists because the exists→append-or-write decision inside each
 * mutator is NOT atomic — two writers racing a shard clobber each other. This
 * suite pins that appends AND the drop/rewrite (`removeCachedTiles`) share the one
 * chain, so a rewrite can never straddle a concurrent append and lose its record
 * (race-audit 2026-07-15, H1: `removeCachedTiles` used to bypass the chain).
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** In-memory DataAdapter with the calls tileCache makes. */
function fakeApp(): { app: App; files: Map<string, string>; adapter: Record<string, unknown> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter: Record<string, unknown> = {
    exists: async (p: string) => files.has(p) || dirs.has(p),
    read: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    write: async (p: string, data: string) => void files.set(p, data),
    append: async (p: string, data: string) => void files.set(p, (files.get(p) ?? "") + data),
    mkdir: async (p: string) => void dirs.add(p),
    remove: async (p: string) => void files.delete(p),
    list: async (p: string) => ({
      files: [...files.keys()].filter((f) => f.slice(0, f.lastIndexOf("/")) === p),
      folders: [],
    }),
  };
  return { app: { vault: { adapter } } as unknown as App, files, adapter };
}

function rec(key: string, seed = 1): CachedTile {
  return {
    key,
    generatorId: "g",
    tileX: 0,
    tileY: 0,
    zoom: 12,
    campaignSeed: seed,
    features: [{ id: key }],
    generatedAt: 1000,
    fingerprint: "fp",
  };
}

const FOLDER = "Campaigns/Test";

describe("cache shard routing", () => {
  it("routes a region key to its own shard and world keys to world.jsonl", () => {
    expect(cacheShardBasename("region:fabric-a-b:network")).toBe("region-fabric-a-b.jsonl");
    expect(cacheShardBasename("region:fabric-a-b:3:4:city-street")).toBe("region-fabric-a-b.jsonl");
    expect(cacheShardBasename("12345:3:4:12:heightmap")).toBe("world.jsonl");
  });
});

describe("append/remove round-trip", () => {
  it("append overwrites by key (last write wins); remove drops the shard when empty", async () => {
    const { app, files } = fakeApp();
    await appendCachedTile(app, FOLDER, rec("region:R1:a"));
    await appendCachedTile(app, FOLDER, rec("region:R1:b"));
    expect((await readCachedTiles(app, FOLDER)).size).toBe(2);
    await removeCachedTiles(app, FOLDER, ["region:R1:a", "region:R1:b"]);
    const after = await readCachedTiles(app, FOLDER);
    expect(after.size).toBe(0);
    // Dropping the whole region empties (and deletes) its shard file entirely.
    expect(files.has(`${FOLDER}/.mapcache/region-R1.jsonl`)).toBe(false);
  });
});

describe("write-chain serialization (invariant #16)", () => {
  it("a concurrent append is NOT clobbered by an interleaved remove rewrite", async () => {
    const { app, adapter, files } = fakeApp();
    const shard = `${FOLDER}/.mapcache/region-R1.jsonl`;

    // Seed two records; the drop will target one of them.
    await appendCachedTile(app, FOLDER, rec("region:R1:keep"));
    await appendCachedTile(app, FOLDER, rec("region:R1:drop"));

    // Instrument the shard read to model an H1 straddle: capture the bytes at
    // call time (as a real read does), then hold the reader between read and its
    // rewrite long enough for a concurrent append to land — returning the STALE
    // snapshot. `removeCanWrite` releases on a timer (never on the append), so the
    // serialized (fixed) path can't deadlock waiting on work queued behind it.
    const removeReadDone = deferred();
    const removeCanWrite = deferred();
    let firstShardRead = true;
    const baseRead = adapter.read as (p: string) => Promise<string>;
    adapter.read = async (p: string): Promise<string> => {
      if (p === shard && firstShardRead) {
        firstShardRead = false;
        const snapshot = files.get(p) ?? "";
        removeReadDone.resolve();
        setTimeout(() => removeCanWrite.resolve(), 20);
        await removeCanWrite.promise;
        return snapshot; // stale bytes — the straddle
      }
      return baseRead(p);
    };
    // Gate the concurrent append's actual write until the remove has read, so the
    // append deterministically lands DURING the straddle window (unserialized) or
    // AFTER the remove completes (serialized) — the difference this test pins.
    const baseAppend = adapter.append as (p: string, data: string) => Promise<void>;
    adapter.append = async (p: string, data: string): Promise<void> => {
      if (p === shard) await removeReadDone.promise;
      return baseAppend(p, data);
    };

    const pRemove = removeCachedTiles(app, FOLDER, ["region:R1:drop"]);
    const pAppend = appendCachedTile(app, FOLDER, rec("region:R1:new"));
    await Promise.all([pRemove, pAppend]);

    const result = await readCachedTiles(app, FOLDER);
    // The appended record must survive: unserialized, the remove's stale-snapshot
    // rewrite silently dropped it (the bug). It must also have dropped `drop`.
    expect(result.has("region:R1:new")).toBe(true);
    expect(result.has("region:R1:keep")).toBe(true);
    expect(result.has("region:R1:drop")).toBe(false);
  });

  it("racing appends on a freshly-created shard never clobber each other", async () => {
    const { app } = fakeApp();
    await Promise.all([
      appendCachedTile(app, FOLDER, rec("region:R2:a")),
      appendCachedTile(app, FOLDER, rec("region:R2:b")),
      appendCachedTile(app, FOLDER, rec("region:R2:c")),
    ]);
    expect((await readCachedTiles(app, FOLDER)).size).toBe(3);
  });
});

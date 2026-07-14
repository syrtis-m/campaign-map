import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  DemTileSchema,
  demTileKey,
  appendDemTile,
  readDemTiles,
  getDemTile,
  clearDemCache,
  type DemTile,
} from "./demCache";

/**
 * Raw-lattice DEM cache round-trip (plan 023 §4.2): heights (quantized ints)
 * are the durable determinism record — this suite proves the JSONL log stores
 * and replays them byte-faithfully, last-write-wins, and that deleting the
 * cache file is harmless (the read path just reports empty → recompute).
 */

/** Minimal in-memory DataAdapter — the same five calls demCache makes. */
function fakeApp(): { app: App; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
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
  };
  return { app: { vault: { adapter } } as unknown as App, files };
}

function tile(z: number, x: number, y: number, heights: number[], digest = "d1", at = 1000): DemTile {
  return { key: demTileKey(z, x, y), z, x, y, res: 2, k: 25, digest, heights, generatedAt: at };
}

const FOLDER = "Campaigns/Test";

describe("DemTile schema", () => {
  it("round-trips through JSONL unchanged (heights exactly preserved)", () => {
    const t = tile(6, 24, 33, [0, 150, -32768, 32767]);
    const line = JSON.stringify(t) + "\n";
    const parsed = DemTileSchema.parse(JSON.parse(line.trim()));
    expect(parsed).toEqual(t);
    expect(parsed.heights).toEqual([0, 150, -32768, 32767]);
  });

  it("rejects a record missing the digest (stale-detection is load-bearing)", () => {
    const { digest: _d, ...bad } = tile(1, 0, 0, [1]);
    expect(DemTileSchema.safeParse(bad).success).toBe(false);
  });
});

describe("append/read round-trip", () => {
  it("stores and replays height lattices byte-faithfully", async () => {
    const { app } = fakeApp();
    await appendDemTile(app, FOLDER, tile(6, 24, 33, [1, 2, 3, 4]));
    await appendDemTile(app, FOLDER, tile(6, 25, 33, [5, 6, 7, 8]));
    const tiles = await readDemTiles(app, FOLDER);
    expect(tiles.size).toBe(2);
    expect(tiles.get(demTileKey(6, 24, 33))?.heights).toEqual([1, 2, 3, 4]);
    expect((await getDemTile(app, FOLDER, 6, 25, 33))?.heights).toEqual([5, 6, 7, 8]);
  });

  it("append with an existing key logically overwrites (last write wins)", async () => {
    const { app } = fakeApp();
    await appendDemTile(app, FOLDER, tile(6, 24, 33, [1, 1, 1, 1], "old"));
    await appendDemTile(app, FOLDER, tile(6, 24, 33, [9, 9, 9, 9], "new", 2000));
    const got = await getDemTile(app, FOLDER, 6, 24, 33);
    expect(got?.heights).toEqual([9, 9, 9, 9]);
    expect(got?.digest).toBe("new");
    expect((await readDemTiles(app, FOLDER)).size).toBe(1);
  });

  it("skips a malformed line instead of crashing the whole DEM path", async () => {
    const { app, files } = fakeApp();
    await appendDemTile(app, FOLDER, tile(6, 24, 33, [1, 2, 3, 4]));
    const path = `${FOLDER}/.mapcache/dem.jsonl`;
    files.set(path, files.get(path)! + '{"partial-crash-write":\n');
    await appendDemTile(app, FOLDER, tile(6, 25, 33, [5, 6, 7, 8]));
    const tiles = await readDemTiles(app, FOLDER);
    expect(tiles.size).toBe(2);
  });
});

describe("cache delete is harmless (CLAUDE.md quality bar)", () => {
  it("clearDemCache empties the read; a re-append reconstructs identically", async () => {
    const { app } = fakeApp();
    const t = tile(6, 24, 33, [10, 20, 30, 40]);
    await appendDemTile(app, FOLDER, t);
    await clearDemCache(app, FOLDER);
    expect((await readDemTiles(app, FOLDER)).size).toBe(0);
    // The protocol recomputes from the deterministic field and re-appends —
    // the replayed record carries identical heights.
    await appendDemTile(app, FOLDER, t);
    expect((await getDemTile(app, FOLDER, 6, 24, 33))?.heights).toEqual([10, 20, 30, 40]);
  });

  it("racing appends on a fresh file never clobber (write-chain, tileCache lesson)", async () => {
    const { app } = fakeApp();
    await Promise.all([
      appendDemTile(app, FOLDER, tile(1, 0, 0, [1])),
      appendDemTile(app, FOLDER, tile(1, 1, 0, [2])),
      appendDemTile(app, FOLDER, tile(1, 0, 1, [3])),
    ]);
    expect((await readDemTiles(app, FOLDER)).size).toBe(3);
  });
});

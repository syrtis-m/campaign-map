import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  generateRegionTile,
  generateTile,
  regionNetworkKey,
  regenerateTile,
  type GenerationContext,
  type RegionNetworkCompute,
} from "./generationService";
import { readCachedTiles, removeCachedTiles } from "../../model/tileCache";
import { GENERATION_ZOOM, tileBBox, tileKey } from "../../gen/cache/tileGrid";
import { generateSettlements } from "../../gen/world";
import {
  citySeedFor,
  discToRing,
  generateCityNetwork,
  clipNetworkToTile,
  makeDomain,
  DOMAIN_TILE_GENERATOR_IDS,
} from "../../gen/citynet";
import { makeRegion } from "../../gen/region";
import type { ParsedCampaign } from "../../model/campaignConfig";
import type { BBox } from "../../gen/spatialHash";

/** In-memory fake of the vault-adapter surface tileCache.ts/mutationLog.ts use. */
function fakeApp(): { app: App; files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || dirs.has(path)),
    mkdir: vi.fn(async (path: string) => {
      dirs.add(path);
    }),
    read: vi.fn(async (path: string) => files.get(path) ?? ""),
    write: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    append: vi.fn(async (path: string, data: string) => {
      files.set(path, (files.get(path) ?? "") + data);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    list: vi.fn(async (path: string) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const fs: string[] = [];
      for (const f of files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) fs.push(f);
      const folders: string[] = [];
      for (const d of dirs) if (d.startsWith(prefix) && d !== path && !d.slice(prefix.length).includes("/")) folders.push(d);
      return { files: fs, folders };
    }),
  };
  const vault = {
    adapter,
    createFolder: vi.fn(async (path: string) => {
      dirs.add(path);
    }),
    create: vi.fn(async (path: string, data: string) => {
      files.set(path, data);
      return { path } as unknown;
    }),
  };
  const app = { vault } as unknown as App;
  return { app, files };
}

const WORLD_BOUNDS: BBox = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };

/** Tiny stand-in tile generator: deterministic, constraint-sensitive enough
 * for the cache tests. */
function fakeStreets(seed: number, bbox: BBox, constraints: { canonFeatures?: GeoJSON.Feature[] }): GeoJSON.Feature[] {
  const canonCount = constraints.canonFeatures?.length ?? 0;
  const n = 4 - Math.min(canonCount, 2);
  const out: GeoJSON.Feature[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      type: "Feature",
      id: seed + i,
      geometry: { type: "LineString", coordinates: [[bbox.minX + i, bbox.minY], [bbox.minX + i, bbox.maxY]] },
      properties: { generated: true, generatorId: "fake-street" },
    });
  }
  return out;
}

function campaign(): ParsedCampaign {
  return {
    id: "ashfall",
    name: "Ashfall",
    path: "Campaigns/Ashfall/Ashfall.map.md",
    config: { "map-campaign": true, crs: "fictional", theme: "obsidian-native", seed: 4181, scaleMetersPerUnit: 50 },
  };
}

describe("generateTile", () => {
  it("caches on first call and returns the cached result on the second, without re-running the generator", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(fakeStreets);

    const a = await generateTile(ctx, 0, 0, "city-street", generator);
    const b = await generateTile(ctx, 0, 0, "city-street", generator);

    expect(generator).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("regenerateTile bypasses the cache and re-runs the generator", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(fakeStreets);

    await generateTile(ctx, 0, 0, "city-street", generator);
    await regenerateTile(ctx, 0, 0, "city-street", generator);

    expect(generator).toHaveBeenCalledTimes(2);
  });

  it("deleting the cache file and regenerating produces hash-identical output", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };

    const first = await generateTile(ctx, 1, 1, "city-street", fakeStreets as never);
    files.delete("Campaigns/Ashfall/.mapcache/world.jsonl");
    const second = await generateTile(ctx, 1, 1, "city-street", fakeStreets as never);

    expect(second).toEqual(first);
  });

  it("passes canon constraints through to the generator (streets avoid canon points)", async () => {
    const { app } = fakeApp();
    const canonPoint: GeoJSON.Feature = {
      type: "Feature",
      id: 1,
      geometry: { type: "Point", coordinates: [50, 50] },
      properties: {},
    };
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [canonPoint] };
    const withoutCanon = fakeStreets(4181, { minX: 0, minY: 0, maxX: 600, maxY: 600 }, { worldBounds: WORLD_BOUNDS } as never);
    const withCanon = await generateTile(ctx, 0, 0, "city-street", fakeStreets as never);
    expect(withCanon.length).toBeLessThanOrEqual(withoutCanon.length);
  });
});

describe("generateTile naming constraints", () => {
  it("threads the campaign's derived genre through to the generator (regression: generationService never set namingGenre, so every campaign — including real-city ones — silently fell back to settlements.ts's fantasy default)", async () => {
    const { app } = fakeApp();
    const realCampaign: ParsedCampaign = {
      id: "london",
      name: "London",
      path: "Campaigns/London/London.map.md",
      config: { "map-campaign": true, crs: "real", theme: "modern-clean", seed: 5127, scaleMetersPerUnit: 1 },
    };
    const ctx: GenerationContext = { app, campaign: realCampaign, worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(generateSettlements);
    await generateTile(ctx, 0, 0, "world-settlement", generator);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0][2].namingGenre).toBe("modern");
  });

  it("threads the campaign's configured namingCultures through to the generator", async () => {
    const { app } = fakeApp();
    const restricted: ParsedCampaign = {
      ...campaign(),
      config: { ...campaign().config, namingCultures: ["fantasy-brackish"] },
    };
    const ctx: GenerationContext = { app, campaign: restricted, worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(generateSettlements);
    await generateTile(ctx, 0, 0, "world-settlement", generator);
    expect(generator.mock.calls[0][2].namingCultureIds).toEqual(["fantasy-brackish"]);
  });
});

describe("generateRegionTile", () => {
  // A region built from a disc (32-gon), with the matching seed — the same
  // fixture the citynet unit gates use.
  const domain = makeDomain(300, 300, 900, "euro-medieval", 1720000000000);
  const region = makeRegion("fabric-region-1", discToRing(domain));
  const seed = citySeedFor(4181, domain);
  const gids = DOMAIN_TILE_GENERATOR_IDS;
  const directCompute: RegionNetworkCompute = (r, constraints) =>
    generateCityNetwork(seed, r, "euro-medieval", constraints);

  it("computes the network ONCE for two tiles of the same region; later tiles re-clip the cached network", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);

    const a1 = await generateRegionTile(ctx, region, gids, 0, 0, compute);
    const b1 = await generateRegionTile(ctx, region, gids, -1, 0, compute);
    expect(compute).toHaveBeenCalledTimes(1); // second tile clips the cached network

    const a2 = await generateRegionTile(ctx, region, gids, 0, 0, compute);
    expect(compute).toHaveBeenCalledTimes(1); // cached-fresh network → re-clip, no recompute (032-C)
    expect(a2).toEqual(a1);
    expect(b1).not.toEqual(a1);
  });

  it("delete-the-cache-file determinism: regenerated records are deep-equal", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const first = await generateRegionTile(ctx, region, gids, 0, 0, directCompute);
    files.delete(`Campaigns/Ashfall/.mapcache/region-${region.id}.jsonl`);
    const second = await generateRegionTile(ctx, region, gids, 0, 0, directCompute);
    expect(second).toEqual(first);
  });

  it("preloadedCache is honored: replay path never re-reads the file and shares one network compute", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    const shared = new Map();
    await generateRegionTile(ctx, region, gids, 0, 0, compute, { preloadedCache: shared });
    await generateRegionTile(ctx, region, gids, -1, -1, compute, { preloadedCache: shared });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(shared.has(regionNetworkKey(region.id))).toBe(true);
  });

  // ─── Plan 032-C — per-tile clip records are no longer persisted ────────────
  it("032-C: persists ONLY the network record — per-tile clips are never written", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    // Generate several overlapping tiles of the region.
    for (const [tx, ty] of [
      [0, 0],
      [-1, 0],
      [0, -1],
    ] as const) {
      await generateRegionTile(ctx, region, gids, tx, ty, directCompute);
    }
    const cache = await readCachedTiles(app, "Campaigns/Ashfall");
    const regionKeys = [...cache.keys()].filter((k) => k.startsWith(`region:${region.id}:`));
    expect(regionKeys).toEqual([regionNetworkKey(region.id)]); // ONE record, the network
  });

  it("032-C: a re-clipped tile is byte-identical to clipping the persisted network directly", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const out = await generateRegionTile(ctx, region, gids, 0, 0, directCompute);
    // What a persisted per-tile record WOULD have held: the network clipped to
    // the tile bbox. The paint-time re-clip must equal it byte-for-byte.
    const net = (await readCachedTiles(app, "Campaigns/Ashfall")).get(regionNetworkKey(region.id))!
      .features as unknown as GeoJSON.Feature[];
    const buckets = clipNetworkToTile(net, tileBBox(0, 0));
    const expected = gids.flatMap((gid) => buckets[gid] ?? []);
    expect(out).toEqual(expected);
  });

  it("force re-clips per-tile records but reuses a still-cached network (031-A: network once)", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    const first = await generateRegionTile(ctx, region, gids, 0, 0, compute);
    // A forced pass re-derives the per-tile clips (skips the fast path) but does
    // NOT recompute the whole-region network while it is still cached fresh —
    // the network is computed ONCE per regen (plan 031-A / research P1). The
    // caller (MapController.generateRegion) is what clears the stale network
    // under force to make a true recompute happen.
    const again = await generateRegionTile(ctx, region, gids, 0, 0, compute, { force: true });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first); // same constraints → same bytes
    // Once the network is cleared, a forced pass recomputes it (still byte-identical).
    files.delete(`Campaigns/Ashfall/.mapcache/region-${region.id}.jsonl`);
    const third = await generateRegionTile(ctx, region, gids, 0, 0, compute, { force: true });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(third).toEqual(first);
  });
});

describe("generateRegionTile staleness fingerprints", () => {
  const domain = makeDomain(300, 300, 900, "euro-medieval", 1720000000000);
  const region = makeRegion("fabric-region-1", discToRing(domain));
  const seed = citySeedFor(4181, domain);
  const gids = DOMAIN_TILE_GENERATOR_IDS;
  const directCompute: RegionNetworkCompute = (r, constraints) =>
    generateCityNetwork(seed, r, "euro-medieval", constraints);

  it("a fingerprint MISMATCH is a MISS: replay recomputes (external Fabric.geojson edit caught)", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    const first = await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpA" });
    expect(compute).toHaveBeenCalledTimes(1);
    // Same key, but the durable inputs changed behind the cache's back (fpB):
    // the fast path + network read both treat the record as stale and recompute.
    const second = await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpB" });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first); // determinism: same compute → byte-identical
  });

  it("a fingerprint MATCH is a fast-path HIT: no recompute (non-stale record untouched)", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpA" });
    await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpA" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("BACK-COMPAT: a record with no stored fingerprint is grandfathered fresh — no regen storm", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    // Simulate an old cache: records written WITHOUT any fingerprint.
    await generateRegionTile(ctx, region, gids, 0, 0, compute, {});
    expect(compute).toHaveBeenCalledTimes(1);
    const path = `Campaigns/Ashfall/.mapcache/region-${region.id}.jsonl`;
    for (const line of files.get(path)!.split("\n")) {
      if (line.trim()) expect(JSON.parse(line).fingerprint).toBeUndefined();
    }
    // A later run WITH a fingerprint must still treat the un-fingerprinted
    // records as fresh (opening an upgraded campaign never invalidates cache).
    await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpNow" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("an undefined expected fingerprint can never invalidate a fingerprinted record", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    await generateRegionTile(ctx, region, gids, 0, 0, compute, { fingerprint: "fpA" });
    await generateRegionTile(ctx, region, gids, 0, 0, compute, {}); // no expected fp
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("records written WITH a fingerprint carry it on disk", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    await generateRegionTile(ctx, region, gids, 0, 0, directCompute, { fingerprint: "fp-xyz" });
    const path = `Campaigns/Ashfall/.mapcache/region-${region.id}.jsonl`;
    const records = files
      .get(path)!
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.fingerprint).toBe("fp-xyz");
  });
});

describe("removeCachedTiles ('clear generated fabric')", () => {
  it("a cleared tile is a true cache MISS: the next generate re-runs the generator (not a blank tombstone)", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(fakeStreets);

    const first = await generateTile(ctx, 0, 0, "city-street", generator);
    const key = tileKey(campaign().config.seed, 0, 0, GENERATION_ZOOM, "city-street");
    await removeCachedTiles(app, "Campaigns/Ashfall", [key]);
    const second = await generateTile(ctx, 0, 0, "city-street", generator);

    expect(generator).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first); // determinism holds across clear+regenerate
  });

  it("only removes the given keys — other tiles' records survive the rewrite", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(fakeStreets);

    await generateTile(ctx, 0, 0, "city-street", generator);
    await generateTile(ctx, 1, 0, "city-street", generator);
    await removeCachedTiles(app, "Campaigns/Ashfall", [
      tileKey(campaign().config.seed, 0, 0, GENERATION_ZOOM, "city-street"),
    ]);
    await generateTile(ctx, 1, 0, "city-street", generator); // still cached
    expect(generator).toHaveBeenCalledTimes(2);
  });
});

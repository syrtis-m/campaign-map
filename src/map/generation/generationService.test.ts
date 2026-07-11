import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import {
  generateDomainTile,
  generateTile,
  networkKeyFor,
  regenerateTile,
  type GenerationContext,
  type NetworkCompute,
} from "./generationService";
import { removeCachedTiles } from "../../model/tileCache";
import { GENERATION_ZOOM, tileKey } from "../../gen/cache/tileGrid";
import { generateCityStreets } from "../../gen/city";
import { generateSettlements } from "../../gen/world";
import { citySeedFor, generateCityNetwork, makeDomain } from "../../gen/citynet";
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
    const generator = vi.fn(generateCityStreets);

    const a = await generateTile(ctx, 0, 0, "city-street", generator);
    const b = await generateTile(ctx, 0, 0, "city-street", generator);

    expect(generator).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("regenerateTile bypasses the cache and re-runs the generator", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(generateCityStreets);

    await generateTile(ctx, 0, 0, "city-street", generator);
    await regenerateTile(ctx, 0, 0, "city-street", generator);

    expect(generator).toHaveBeenCalledTimes(2);
  });

  it("deleting the cache file and regenerating produces hash-identical output", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };

    const first = await generateTile(ctx, 1, 1, "city-street", generateCityStreets);
    files.delete("Campaigns/Ashfall/.mapcache/generated.jsonl");
    const second = await generateTile(ctx, 1, 1, "city-street", generateCityStreets);

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
    const withoutCanon = generateCityStreets(4181, { minX: 0, minY: 0, maxX: 600, maxY: 600 }, { worldBounds: WORLD_BOUNDS });
    const withCanon = await generateTile(ctx, 0, 0, "city-street", generateCityStreets);
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

describe("generateDomainTile (procgen v3 §3.3)", () => {
  const directCompute: NetworkCompute = (seed, dom, _bbox, constraints) =>
    generateCityNetwork(citySeedFor(seed, dom), dom, constraints);
  const domain = makeDomain(300, 300, 900, "euro-medieval", 1720000000000);

  it("computes the network ONCE for two tiles of the same domain, and per-tile records hit the cache after", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);

    const a1 = await generateDomainTile(ctx, domain, 0, 0, compute);
    const b1 = await generateDomainTile(ctx, domain, -1, 0, compute);
    expect(compute).toHaveBeenCalledTimes(1); // second tile clips the cached network

    const a2 = await generateDomainTile(ctx, domain, 0, 0, compute);
    expect(compute).toHaveBeenCalledTimes(1); // per-tile fast path, no re-clip
    expect(a2).toEqual(a1);
    expect(b1).not.toEqual(a1);
  });

  it("delete-the-cache-file determinism: regenerated records are deep-equal", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const first = await generateDomainTile(ctx, domain, 0, 0, directCompute);
    files.delete("Campaigns/Ashfall/.mapcache/generated.jsonl");
    const second = await generateDomainTile(ctx, domain, 0, 0, directCompute);
    expect(second).toEqual(first);
  });

  it("preloadedCache is honored: replay path never re-reads the file and shares one network compute", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    const shared = new Map();
    await generateDomainTile(ctx, domain, 0, 0, compute, { preloadedCache: shared });
    await generateDomainTile(ctx, domain, -1, -1, compute, { preloadedCache: shared });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(shared.has(networkKeyFor(campaign().config.seed, domain))).toBe(true);
  });

  it("force recomputes the network and overwrites the records", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const compute = vi.fn(directCompute);
    const first = await generateDomainTile(ctx, domain, 0, 0, compute);
    const again = await generateDomainTile(ctx, domain, 0, 0, compute, { force: true });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(again).toEqual(first); // same constraints → same bytes, even forced
  });
});

describe("removeCachedTiles (plan 019 'clear generated fabric')", () => {
  it("a cleared tile is a true cache MISS: the next generate re-runs the generator (not a blank tombstone)", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const generator = vi.fn(generateCityStreets);

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
    const generator = vi.fn(generateCityStreets);

    await generateTile(ctx, 0, 0, "city-street", generator);
    await generateTile(ctx, 1, 0, "city-street", generator);
    await removeCachedTiles(app, "Campaigns/Ashfall", [
      tileKey(campaign().config.seed, 0, 0, GENERATION_ZOOM, "city-street"),
    ]);
    await generateTile(ctx, 1, 0, "city-street", generator); // still cached
    expect(generator).toHaveBeenCalledTimes(2);
  });
});

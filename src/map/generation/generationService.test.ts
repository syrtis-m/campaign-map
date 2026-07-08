import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { canonizeFeature, generateTile, regenerateTile, type GenerationContext, type LocationCreator } from "./generationService";
import { generateCityStreets } from "../../gen/city";
import { generateSettlements } from "../../gen/world";
import { createLocationNoteFromFeature } from "../../vault/locationOps";
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

describe("canonizeFeature", () => {
  it("creates the note and removes the feature from its cached tile", async () => {
    const { app } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const settlements = await generateTile(ctx, 0, 0, "world-settlement", generateSettlements);
    expect(settlements.length).toBeGreaterThan(0);
    const target = settlements[0];

    const createLocationFromFeature = vi.fn(
      async (_campaignId: string, _feature: GeoJSON.Feature, _name: string, _type: string) => {}
    );
    const locations: LocationCreator = { createLocationFromFeature };

    await canonizeFeature(ctx, locations, target, "Test Town", "town");

    expect(createLocationFromFeature).toHaveBeenCalledTimes(1);
    const [campaignId, feature, name, type] = createLocationFromFeature.mock.calls[0];
    expect(campaignId).toBe("ashfall");
    expect(feature).toBe(target);
    expect(name).toBe("Test Town");
    expect(type).toBe("town");

    const after = await generateTile(ctx, 0, 0, "world-settlement", generateSettlements);
    expect(after.find((f) => f.id === target.id)).toBeUndefined();
    expect(after.length).toBe(settlements.length - 1);
  });

  it("canonizes a LineString (street) via a sidecar .geojson — not yet reachable from the UI (canonizeGeneratedNear only offers Points, since there's no canon-line render layer yet; see DECISIONS.md), but the mechanism the roadmap's 'canonize a street' exit test names is real and tested here", async () => {
    const { app, files } = fakeApp();
    const ctx: GenerationContext = { app, campaign: campaign(), worldBounds: WORLD_BOUNDS, canonFeatures: [] };
    const streets = await generateTile(ctx, 0, 0, "city-street", generateCityStreets);
    expect(streets.length).toBeGreaterThan(0);
    const street = streets[0];
    expect(street.geometry.type).toBe("LineString");

    const locations: LocationCreator = {
      createLocationFromFeature: (campaignId, feature, name, type) =>
        createLocationNoteFromFeature(app, ctx.campaign, feature, name, type).then(() => undefined),
    };

    await canonizeFeature(ctx, locations, street, "Test Street", "street(named)");

    const notePath = "Campaigns/Ashfall/Locations/Test Street.md";
    const sidecarPath = "Campaigns/Ashfall/Locations/Test Street.geojson";
    expect(files.has(notePath)).toBe(true);
    expect(files.get(notePath)).toContain(`geometry: "${sidecarPath}"`);
    expect(files.has(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(files.get(sidecarPath)!) as GeoJSON.Feature;
    expect(sidecar.geometry).toEqual(street.geometry);

    // Stripped from its cached tile like any other canonized feature.
    const after = await generateTile(ctx, 0, 0, "city-street", generateCityStreets);
    expect(after.find((f) => f.id === street.id)).toBeUndefined();
  });
});

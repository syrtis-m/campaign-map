/**
 * Headless MapController integration tests (plan 021 §2.4) — the whole
 * lifecycle surface the live gates phase1–phase5 / procgen40–43 assert, driven
 * against the in-memory FakeHost with NO Obsidian / MapLibre / renderer. These
 * run in the FAST tier (`npm test`), seconds not minutes, parallel-safe (each
 * FakeHost owns a unique campaign folder). See the phase report for the
 * live-gate → headless assertion mapping.
 */
import { describe, it, expect } from "vitest";
import { FakeHost } from "./FakeHost";
import { generatedManifestPath } from "../vault/generatedManifestStore";
import { discToRing, citySeedFor, type CityDomain } from "../gen/citynet";
import { regionNetworkKey } from "../map/generation/generationService";
import { isProcgenRegion } from "../model/fabric";

/** A district ring in display units (1 unit = 50 m ⇒ an 800 m square), the
 * same fixture geometry the live procgen40 gate sketches. */
const RING: [number, number][] = [
  [10, -26],
  [26, -26],
  [26, -10],
  [10, -10],
];

/** Stand up a fictional campaign and point the controller at it. */
function cityHost(): FakeHost {
  const host = new FakeHost({ zoom: 10 }); // city tier
  host.begin();
  return host;
}

describe("MapController — sketch-driven city procgen (procgen40)", () => {
  it("generates a city strictly inside the sketched district", async () => {
    const host = cityHost();
    const res = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "Old Town");

    expect(res.count).toBeGreaterThan(0);
    expect(res.outside).toBe(0); // nothing spills past the GM's line
    expect(host.controller.loadedTileCount).toBeGreaterThan(0);

    // Fabric persisted: a district carrying a city procgen block with a seed.
    const fabric = await host.fabric();
    expect(fabric.features).toHaveLength(1);
    const feat = fabric.features[0];
    expect(feat.properties.kind).toBe("district");
    expect(isProcgenRegion(feat)).toBe(true);
    expect(feat.properties.procgen?.algorithm).toBe("city");
    expect(feat.properties.procgen?.params.profile).toBe("euro-medieval");
    expect(typeof feat.properties.procgen?.seed).toBe("number");

    // Log peeled apart as sketch-add → sketch-procgen-set (undo-restorable).
    const log = await host.log();
    expect(log.map((e) => e.type)).toEqual(["sketch-add", "sketch-procgen-set"]);

    // Cache holds the whole-network record + per-tile clips.
    const cache = await host.cache();
    expect(cache.has(regionNetworkKey(res.featureId))).toBe(true);
    expect([...cache.keys()].some((k) => k.startsWith(`region:${res.featureId}:`) && k !== regionNetworkKey(res.featureId))).toBe(true);
  });

  it("re-clips byte-identically after the cache is deleted (determinism / acceptance §4)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });

    // Snapshot the per-key feature BYTES (not generatedAt, which is a clock).
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache()) before.set(k, JSON.stringify(rec.features));

    // Blow away `.mapcache/` and regenerate — must reproduce identical bytes.
    await host.adapter.remove(host.cachePath());
    expect((await host.cache()).size).toBe(0);
    await host.controller.regenerateRegionById(featureId);

    const after = new Map<string, string>();
    for (const [k, rec] of await host.cache()) after.set(k, JSON.stringify(rec.features));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
  });

  it("replays from cache on reopen without re-running any generator (explicit-only)", async () => {
    const host = cityHost();
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();

    expect(reopened.controller.loadedTileCount).toBeGreaterThan(0);
    expect(reopened.controller.generatorRunCount).toBe(0); // pure cache hits
  });

  it("migrates a legacy disc domain to a sketched district, keeping its seed (procgen40)", async () => {
    const host = new FakeHost({ zoom: 10 });
    const domain: CityDomain = { id: "legacy-1", cx: 900, cy: -900, radius: 400, profile: "euro-medieval", createdAt: 1 };
    await host.adapter.write(
      generatedManifestPath(host.campaign),
      JSON.stringify({ entries: [], domains: [domain] })
    );
    host.begin();
    await host.controller.replayGeneratedManifest();

    const manifest = await host.manifest();
    expect(manifest.domains).toHaveLength(0); // domain consumed

    const fabric = await host.fabric();
    expect(fabric.features).toHaveLength(1);
    const migrated = fabric.features[0];
    expect(migrated.properties.kind).toBe("district");
    expect(migrated.properties.procgen?.algorithm).toBe("city");
    // Identity preserved: migrated seed == the disc's derived city seed.
    expect(migrated.properties.procgen?.seed).toBe(citySeedFor(host.campaign.config.seed, domain));
    // Ring shape came from discToRing (32-gon), sanity-checked non-empty.
    expect(discToRing(domain).length).toBeGreaterThan(3);
    expect(host.notices.some((n) => n.message.includes("migrated"))).toBe(true);
  });
});

describe("MapController — PowerPoint-style sketch edits (procgen41)", () => {
  it("adapts the city to a reshaped district while keeping its seed", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const seedBefore = (await host.fabric()).features[0].properties.procgen!.seed;

    const ok = await host.controller.moveVertex(featureId, 0, [8, -28]); // nudge a corner outward
    expect(ok).toBe(true);

    const report = host.controller.regionContainmentReport(featureId);
    expect(report.count).toBeGreaterThan(0);
    expect(report.outside).toBe(0); // still inside the NEW ring
    const seedAfter = (await host.fabric()).features[0].properties.procgen!.seed;
    expect(seedAfter).toBe(seedBefore); // edits adapt, they don't re-roll
    // sketch-edit logged (undo-restorable).
    expect((await host.log()).at(-1)?.type).toBe("sketch-edit");
  });

  it("re-rolls to a new seed and different output on rerollRegion", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const seed1 = (await host.fabric()).features[0].properties.procgen!.seed;
    const ids1 = new Set(host.controller.regionFeatureIds(featureId));

    await host.controller.rerollRegion(featureId);
    const seed2 = (await host.fabric()).features[0].properties.procgen!.seed;
    const ids2 = new Set(host.controller.regionFeatureIds(featureId));

    expect(seed2).not.toBe(seed1);
    // Re-roll replaces identity: the painted id set should differ substantially.
    const overlap = [...ids2].filter((id) => ids1.has(id)).length;
    expect(overlap).toBeLessThan(ids2.size);
  });

  it("switches profile via setRegionParams and force-regenerates", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const runsBefore = host.controller.generatorRunCount;

    await host.controller.setRegionParams(featureId, { profile: "na-grid" });

    const feat = (await host.fabric()).features[0];
    expect(feat.properties.procgen?.params.profile).toBe("na-grid");
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore); // recomputed
    expect((await host.log()).at(-1)?.type).toBe("sketch-procgen-set");
  });

  it("deletes the shape and its generated city together (sketch-remove)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    expect(host.controller.loadedTileCount).toBeGreaterThan(0);

    host.controller.deleteFabricFeature(featureId);
    // Give the fire-and-forget persist/regen a tick to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect((await host.fabric()).features).toHaveLength(0);
    expect(host.selectionInvalidations).toContain(featureId);
    expect(host.controller.loadedTileCount).toBe(0);
    expect((await host.cache()).has(regionNetworkKey(featureId))).toBe(false);
    expect((await host.log()).at(-1)?.type).toBe("sketch-remove");
  });
});

describe("MapController — clear + undo lifecycle", () => {
  it("clearAllGenerated strips every region's procgen block and drops its cache", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });

    const removed = await host.controller.clearAllGenerated();
    expect(removed).toBe(1);

    const feat = (await host.fabric()).features[0];
    expect(feat.properties.procgen).toBeUndefined(); // shape stays, city gone
    expect(host.controller.loadedTileCount).toBe(0);
    expect((await host.cache()).has(regionNetworkKey(featureId))).toBe(false);
  });

  it("undo of a region create removes the generated city (sketch-procgen-set undo)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });

    await host.controller.undoLastEdit(); // reverses the sketch-procgen-set (attach)
    const feat = (await host.fabric()).features.find((f) => f.id === featureId);
    expect(feat?.properties.procgen).toBeUndefined();
    expect(host.notices.some((n) => n.message.includes("removed the generated city"))).toBe(true);
  });

  it("a sketched constraint edit queues and flushes a region regen (sketch-a-river)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const runsBefore = host.controller.generatorRunCount;
    const armedBefore = host.regenArmedCount;

    // A river crossing the district — a generator constraint. createFabricForTest
    // is the bare gate helper (persist only); queueing the constraint regen is
    // what finalizeSketchDraft/addSketchedFeature do for a real sketched shape.
    const riverId = await host.controller.createFabricForTest("river", [[10, -18], [26, -18]]);
    const river = (await host.fabric()).features.find((f) => f.id === riverId)!;
    host.controller.queueConstraintRegen(river);
    expect(host.regenArmedCount).toBeGreaterThan(armedBefore);

    await host.controller.flushSketchRegen();
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore); // region re-adapted
    expect(host.controller.regionContainmentReport(featureId).outside).toBe(0);
  });
});

describe("MapController — world tier generate / regen / clear (phase3/phase4)", () => {
  it("records a manifest entry and runs a generator on generateFabricHere", async () => {
    const host = new FakeHost({ zoom: 5 }); // world tier
    host.begin();

    const feats = await host.controller.generateFabricHere([0, 0]);
    expect(feats.length).toBeGreaterThan(0);
    expect(host.controller.generatorRunCount).toBeGreaterThan(0);
    expect(host.controller.loadedTileCount).toBe(1);

    const manifest = await host.manifest();
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].tier).toBe("world");
    expect((await host.log()).at(-1)?.type).toBe("generate-area");
  });

  it("replays the world tile from cache on reopen (generatorRunCount stays 0)", async () => {
    const host = new FakeHost({ zoom: 5 });
    host.begin();
    await host.controller.generateFabricHere([0, 0]);

    const reopened = host.reopen({ zoom: 5 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.loadedTileCount).toBe(1);
    expect(reopened.controller.generatorRunCount).toBe(0);
  });

  it("clears a world tile (manifest entry + cache + paint) and logs clear-area", async () => {
    const host = new FakeHost({ zoom: 5 });
    host.begin();
    await host.controller.generateFabricHere([0, 0]);

    const cleared = await host.controller.clearGeneratedHere([0, 0]);
    expect(cleared).toBe(1);
    expect((await host.manifest()).entries).toHaveLength(0);
    expect(host.controller.loadedTileCount).toBe(0);
    expect((await host.log()).at(-1)?.type).toBe("clear-area");
  });

  it("undo of a world generate clears the tile (generate-area undo)", async () => {
    const host = new FakeHost({ zoom: 5 });
    host.begin();
    await host.controller.generateFabricHere([0, 0]);

    await host.controller.undoLastEdit();
    expect((await host.manifest()).entries).toHaveLength(0);
    expect((await host.log()).at(-1)?.type).toBe("clear-area");
  });
});

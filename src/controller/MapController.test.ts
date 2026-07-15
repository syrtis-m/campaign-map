/**
 * Headless MapController integration tests — the whole lifecycle surface the
 * live gates phase1–phase5 / procgen40–43 assert, driven
 * against the in-memory FakeHost with NO Obsidian / MapLibre / renderer. These
 * run in the FAST tier (`npm test`), seconds not minutes, parallel-safe (each
 * FakeHost owns a unique campaign folder). See the phase report for the
 * live-gate → headless assertion mapping.
 */
import { describe, it, expect } from "vitest";
import { FakeHost } from "./FakeHost";
import { generatedManifestPath } from "../vault/generatedManifestStore";
import { fabricPath } from "../vault/fabricStore";
import { discToRing, citySeedFor, type CityDomain } from "../gen/citynet";
import { regionNetworkKey } from "../map/generation/generationService";
import { isProcgenRegion } from "../model/fabric";
import { algorithmById } from "../gen/procgen/registry";

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
    await host.clearCacheOnDisk();
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
    const runsBefore = host.controller.generatorRunCount;
    const idsBefore = new Set(host.controller.regionFeatureIds(featureId));

    const ok = await host.controller.moveVertex(featureId, 0, [8, -28]); // nudge a corner outward
    expect(ok).toBe(true);

    // The edit must actually REGENERATE (a stale cache can silently pass the
    // containment check when the ring only grew): the generator ran, and the
    // painted feature set moved.
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore);
    const idsAfter = new Set(host.controller.regionFeatureIds(featureId));
    const overlap = [...idsAfter].filter((id) => idsBefore.has(id)).length;
    expect(overlap).toBeLessThan(idsAfter.size);

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

  it("applies a template via setRegionPreset — full commit path, no presetId persisted", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const runsBefore = host.controller.generatorRunCount;

    // The headless twin of the panel's Template dropdown.
    await host.controller.setRegionPreset(featureId, "na-grid");

    const feat = (await host.fabric()).features[0];
    expect(feat.properties.procgen?.params.profile).toBe("na-grid");
    // City presets carry no presetId — block stays byte-identical to the
    // pre-022 `{ profile }` shape (the Vespergate byte-intact guarantee).
    expect(feat.properties.procgen?.presetId).toBeUndefined();
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore); // recomputed
    expect((await host.log()).at(-1)?.type).toBe("sketch-procgen-set");
  });

  it("setRegionPreset keeps an orthogonal center param across a template change", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(
      RING,
      "city",
      { profile: "euro-medieval", center: [18, -18] }
    );
    await host.controller.setRegionPreset(featureId, "na-suburb");
    const params = (await host.fabric()).features[0].properties.procgen?.params;
    expect(params?.profile).toBe("na-suburb");
    expect(params?.center).toEqual([18, -18]); // placement survives the template swap
  });

  it("a legacy block (no presetId) validates and regenerates byte-identically after a presetId is stamped on", async () => {
    // presetId is DISPLAY ONLY — a generator never reads it. Prove it on the
    // SAME region: generate → persist a display-only presetId onto the block →
    // reopen (forces a fresh fabric load, which validates the now-presetId'd
    // block) → force-regenerate. Same featureId ⇒ same seed; same params ⇒
    // byte-identical output. The stamp must move NOTHING.
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache()) before.set(k, JSON.stringify(rec.features));

    // Stamp a display-only presetId onto the persisted block (as a future 022
    // template-pick would) and persist it back to the vault fabric file.
    const fabric = await host.fabric();
    fabric.features.find((f) => f.id === featureId)!.properties.procgen!.presetId = "euro-medieval";
    await host.adapter.write(fabricPath(host.campaign), JSON.stringify(fabric, null, 2));

    // Reopen (shares the adapter → same cache) and regenerate the same region.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    // The presetId'd block validated on load (no throw) and is visible.
    expect((await reopened.fabric()).features[0].properties.procgen?.presetId).toBe("euro-medieval");
    await reopened.controller.regenerateRegionById(featureId);

    const after = new Map<string, string>();
    for (const [k, rec] of await reopened.cache()) after.set(k, JSON.stringify(rec.features));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes); // presetId is inert
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

describe("MapController — version pinning", () => {
  it("creation writes the algorithm's currentVersion into the block", async () => {
    const host = cityHost();
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const block = (await host.fabric()).features[0].properties.procgen!;
    expect(block.version).toBe(algorithmById("city")!.currentVersion);
  });

  it("param edits, re-rolls, and vertex edits keep the pinned version", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const pinned = (await host.fabric()).features[0].properties.procgen!.version;

    await host.controller.setRegionParams(featureId, { profile: "na-grid" });
    expect((await host.fabric()).features[0].properties.procgen!.version).toBe(pinned);

    await host.controller.rerollRegion(featureId);
    expect((await host.fabric()).features[0].properties.procgen!.version).toBe(pinned);

    await host.controller.moveVertex(featureId, 0, [8, -28]);
    expect((await host.fabric()).features[0].properties.procgen!.version).toBe(pinned);
  });
});

describe("MapController — adoption lifecycle (pinned-old regions)", () => {
  /** A pinned-old fixture: create at v1, then simulate a city bump to v2. */
  async function pinnedOldHost(): Promise<{ host: FakeHost; featureId: string }> {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    host.controller.overrideCurrentVersionForTest("city", 2);
    return { host, featureId };
  }

  it("a param edit on a pinned-old region prompts; DECLINE cancels the edit entirely", async () => {
    const { host, featureId } = await pinnedOldHost();
    const runsBefore = host.controller.generatorRunCount;
    const logBefore = (await host.log()).length;

    host.controller.queueConfirmResponseForTest(false);
    await host.controller.setRegionParams(featureId, { profile: "na-grid" });

    const block = (await host.fabric()).features[0].properties.procgen!;
    expect(block.params.profile).toBe("euro-medieval"); // edit cancelled
    expect(block.version).toBe(1); // pin untouched
    expect(host.controller.generatorRunCount).toBe(runsBefore); // nothing regenerated
    expect((await host.log()).length).toBe(logBefore); // nothing logged
  });

  it("PROCEED adopts (version raised, migrated params), applies the edit, regenerates, logs before/after", async () => {
    const { host, featureId } = await pinnedOldHost();
    const runsBefore = host.controller.generatorRunCount;

    host.controller.queueConfirmResponseForTest(true);
    await host.controller.setRegionParams(featureId, { profile: "na-grid" });

    const block = (await host.fabric()).features[0].properties.procgen!;
    expect(block.version).toBe(2); // adopted
    expect(block.params.profile).toBe("na-grid"); // edit applied
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore);
    const last = (await host.log()).at(-1)!;
    expect(last.type).toBe("sketch-procgen-set");
    const data = last.data as unknown as { before: { version: number }; after: { version: number } };
    expect(data.before.version).toBe(1);
    expect(data.after.version).toBe(2);
    expect(host.controller.needsAdoptionIds()).toEqual([]);
    expect(host.controller.isRegionPinnedOld(featureId)).toBe(false);
  });

  it("a vertex edit on a pinned-old region prompts; decline reverts the geometry", async () => {
    const { host, featureId } = await pinnedOldHost();
    const ringBefore = JSON.stringify((await host.fabric()).features[0].geometry);

    host.controller.queueConfirmResponseForTest(false);
    const ok = await host.controller.moveVertex(featureId, 0, [6, -30]);

    expect(ok).toBe(false);
    expect(JSON.stringify((await host.fabric()).features[0].geometry)).toBe(ringBefore);
    expect((await host.fabric()).features[0].properties.procgen!.version).toBe(1);
  });

  it("a vertex edit accepted adopts first, then applies the reshape", async () => {
    const { host, featureId } = await pinnedOldHost();
    host.controller.queueConfirmResponseForTest(true);
    const ok = await host.controller.moveVertex(featureId, 0, [6, -30]);

    expect(ok).toBe(true);
    const feat = (await host.fabric()).features[0];
    expect(feat.properties.procgen!.version).toBe(2);
    // Both steps logged, adoption before the edit (each its own undo step).
    const types = (await host.log()).map((e) => e.type);
    expect(types.at(-1)).toBe("sketch-edit");
    expect(types.at(-2)).toBe("sketch-procgen-set");
  });

  it("with no queued response the host confirm sink decides (prompt surface)", async () => {
    const { host, featureId } = await pinnedOldHost();
    host.confirmResponse = true;
    await host.controller.rerollRegion(featureId);
    expect(host.confirms.length).toBe(1);
    expect(host.confirms[0]).toContain("older version");
    expect((await host.fabric()).features[0].properties.procgen!.version).toBe(2);
  });

  it("replay serves a pinned-old region from cache untouched (no prompt, no generator run)", async () => {
    const { host, featureId } = await pinnedOldHost();
    const bytesBefore = new Map<string, string>();
    for (const [k, rec] of await host.cache()) bytesBefore.set(k, JSON.stringify(rec.features));

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("city", 2);
    await reopened.controller.replayGeneratedManifest();

    expect(reopened.controller.generatorRunCount).toBe(0); // pure cache hits
    expect(reopened.controller.needsAdoptionIds()).toEqual([]); // no badge
    expect(reopened.confirms.length).toBe(0); // no prompt
    expect(reopened.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0); // painted
    for (const [k, rec] of await reopened.cache()) {
      expect(JSON.stringify(rec.features)).toBe(bytesBefore.get(k)); // bytes untouched
    }
  });

  it("cache missing: a pinned-old region renders NOTHING + a needs-adoption badge — never regenerates", async () => {
    const { host, featureId } = await pinnedOldHost();
    await host.clearCacheOnDisk();

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("city", 2);
    await reopened.controller.replayGeneratedManifest();

    expect(reopened.controller.generatorRunCount).toBe(0); // NEVER silently regenerated
    expect(reopened.controller.regionFeatureIds(featureId)).toEqual([]); // renders nothing
    expect(reopened.controller.needsAdoptionIds()).toEqual([featureId]); // badge
    expect(reopened.notices.some((n) => n.message.includes("needs adoption"))).toBe(true);
  });

  it("adoptRegion raises the pin, regenerates deterministically, and clears the badge", async () => {
    const { host, featureId } = await pinnedOldHost();
    await host.clearCacheOnDisk();
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("city", 2);
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.needsAdoptionIds()).toEqual([featureId]);

    const adopted = await reopened.controller.adoptRegion(featureId);
    expect(adopted).toBe(true);
    expect((await reopened.fabric()).features[0].properties.procgen!.version).toBe(2);
    expect(reopened.controller.needsAdoptionIds()).toEqual([]);
    expect(reopened.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0);

    // Determinism at the adopted version: delete cache ⇒ identical bytes.
    const bytes = new Map<string, string>();
    for (const [k, rec] of await reopened.cache()) bytes.set(k, JSON.stringify(rec.features));
    await reopened.clearCacheOnDisk();
    await reopened.controller.regenerateRegionById(featureId);
    for (const [k, rec] of await reopened.cache()) {
      expect(JSON.stringify(rec.features)).toBe(bytes.get(k));
    }
  });

  it("adoptRegion is a no-op on a current-version region", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    expect(await host.controller.adoptRegion(featureId)).toBe(false);
  });

  it("adoptAllRegions adopts every pinned-old region and reports the count", async () => {
    const host = cityHost();
    const a = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "A");
    const FOREST_RING: [number, number][] = [
      [-30, 10],
      [-14, 10],
      [-14, 26],
      [-30, 26],
    ];
    const b = await host.controller.createRegionForTest(
      FOREST_RING,
      "forest",
      { variety: "mixed", density: 0.6, clearings: 0.15, edgeRaggedness: 0.5 },
      "B",
      "forest"
    );
    host.controller.overrideCurrentVersionForTest("city", 2);
    host.controller.overrideCurrentVersionForTest("forest", 3);

    const count = await host.controller.adoptAllRegions();
    expect(count).toBe(2);
    const fabric = await host.fabric();
    expect(fabric.features.find((f) => f.id === a.featureId)!.properties.procgen!.version).toBe(2);
    expect(fabric.features.find((f) => f.id === b.featureId)!.properties.procgen!.version).toBe(3);
    expect(await host.controller.adoptAllRegions()).toBe(0); // idempotent
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

describe("MapController — spine (river) line-kind procgen", () => {
  // A kinked river line in display units (1 unit = 50 m), well inside bounds.
  const RIVER: [number, number][] = [
    [6, -30],
    [12, -22],
    [6, -14],
    [12, -6],
  ];
  const LAZY = { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2 };

  function regionKeys(recs: Map<string, { features: unknown }>, id: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, rec] of recs) if (k.startsWith(`region:${id}:`)) out.set(k, JSON.stringify(rec.features));
    return out;
  }

  it("generates channel features inside the corridor (containment holds)", async () => {
    const host = cityHost();
    const res = await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    expect(res.count).toBeGreaterThan(0);
    expect(res.outside).toBe(0);
    // The fabric feature carries a river procgen block with a persisted seed.
    const feature = (await host.fabric()).features.find((f) => f.id === res.featureId)!;
    expect(feature.properties.kind).toBe("river");
    expect(feature.properties.procgen?.algorithm).toBe("river");
    expect(typeof feature.properties.procgen?.seed).toBe("number");
    // Channel water was emitted; the render store holds region-keyed tiles.
    const ids = host.controller.regionFeatureIds(res.featureId, "river-channel");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("re-clips byte-identically after the cache is deleted (determinism)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    const before = regionKeys(await host.cache(), featureId);
    expect(before.size).toBeGreaterThan(0);
    await host.clearCacheOnDisk();
    await host.controller.regenerateRegionById(featureId);
    const after = regionKeys(await host.cache(), featureId);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
  });

  it("replays from cache on reopen without re-running any generator (explicit-only)", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.loadedTileCount).toBeGreaterThan(0);
    expect(reopened.controller.generatorRunCount).toBe(0);
  });

  it("a vertex edit adapts the river and stays contained; far segment is stable", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    const before = host.controller.regionContainmentReport(featureId).count;
    // Move the LAST vertex (open-index 3) — moveVertex runs the full commit path.
    const ok = await host.controller.moveVertex(featureId, 3, [16, -4]);
    expect(ok).toBe(true);
    const report = host.controller.regionContainmentReport(featureId);
    expect(report.count).toBeGreaterThan(0);
    expect(report.outside).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it("windiness increase widens the corridor (setRegionParams), still contained", async () => {
    const host = cityHost();
    const straight = { windiness: 0.1, braiding: 0, width: 12, widthGrowth: 0, braidBias: 0 };
    const { featureId } = await host.controller.createSpineForTest(RIVER, "river", "river", straight, "__spine_test__");
    expect(host.controller.regionContainmentReport(featureId).outside).toBe(0);
    await host.controller.setRegionParams(featureId, { ...straight, windiness: 0.95 });
    // Still contained against the NOW-WIDER corridor (buildRegionFromFeature
    // recomputes maxOffset from the new params).
    const report = host.controller.regionContainmentReport(featureId);
    expect(report.count).toBeGreaterThan(0);
    expect(report.outside).toBe(0);
  });

  it("re-roll changes the seed and the output", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    const seedBefore = (await host.fabric()).features.find((f) => f.id === featureId)!.properties.procgen!.seed;
    const before = regionKeys(await host.cache(), featureId);
    await host.controller.rerollRegion(featureId);
    const seedAfter = (await host.fabric()).features.find((f) => f.id === featureId)!.properties.procgen!.seed;
    expect(seedAfter).not.toBe(seedBefore);
    const after = regionKeys(await host.cache(), featureId);
    // At least the network record changed bytes.
    let changed = false;
    for (const [k, bytes] of before) if (after.get(k) !== bytes) changed = true;
    expect(changed).toBe(true);
  });

  it("undo restores the pre-edit river", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createSpineForTest(RIVER, "river", "river", LAZY, "__spine_test__");
    const before = regionKeys(await host.cache(), featureId);
    await host.controller.moveVertex(featureId, 3, [16, -4]);
    await host.controller.undoLastEdit();
    // The line geometry is back; regenerate and compare bytes.
    await host.controller.regenerateRegionById(featureId);
    const after = regionKeys(await host.cache(), featureId);
    for (const [k, bytes] of before) if (after.has(k)) expect(after.get(k)).toBe(bytes);
    expect(host.controller.regionContainmentReport(featureId).outside).toBe(0);
  });

  it("a plain sketched river (no modal confirm) stays inert — no region, no generation", async () => {
    const host = cityHost();
    const runsBefore = host.controller.generatorRunCount;
    const id = await host.controller.createFabricForTest("river", RIVER, "__plain_river__");
    const feature = (await host.fabric()).features.find((f) => f.id === id)!;
    expect(isProcgenRegion(feature)).toBe(false);
    expect(host.controller.regionFeatureIds(id).length).toBe(0);
    // No generator ran for a plain sketch.
    expect(host.controller.generatorRunCount).toBe(runsBefore);
  });

  it("rejects malformed river params at the zod boundary", async () => {
    const host = cityHost();
    await expect(
      host.controller.createSpineForTest(RIVER, "river", "river", { windiness: 2, braiding: 0, width: 12, widthGrowth: 0, braidBias: 0 }, "__spine_test__")
    ).rejects.toThrow();
  });
});

describe("MapController — forest polygon-kind procgen", () => {
  // An 800 m square forest region in display units (1 unit = 50 m).
  const FOREST_RING: [number, number][] = [
    [10, -26],
    [26, -26],
    [26, -10],
    [10, -10],
  ];
  const MIXED = { variety: "mixed", density: 0.6, clearings: 0.2, edgeRaggedness: 0.5 };

  it("generates canopy strictly inside the sketched forest (containment holds)", async () => {
    const host = cityHost();
    const res = await host.controller.createRegionForTest(FOREST_RING, "forest", MIXED, "Wolfswood", "forest");
    expect(res.count).toBeGreaterThan(0);
    expect(res.outside).toBe(0);
    const feature = (await host.fabric()).features.find((f) => f.id === res.featureId)!;
    expect(feature.properties.kind).toBe("forest");
    expect(feature.properties.procgen?.algorithm).toBe("forest");
    expect(typeof feature.properties.procgen?.seed).toBe("number");
    expect(host.controller.regionFeatureIds(res.featureId, "forest-canopy").length).toBeGreaterThan(0);
  });

  it("re-clips byte-identically after the cache is deleted (determinism)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(FOREST_RING, "forest", MIXED, "Wood", "forest");
    const keys = (recs: Map<string, { features: unknown }>) => {
      const out = new Map<string, string>();
      for (const [k, rec] of recs) if (k.startsWith(`region:${featureId}:`)) out.set(k, JSON.stringify(rec.features));
      return out;
    };
    const before = keys(await host.cache());
    expect(before.size).toBeGreaterThan(0);
    await host.clearCacheOnDisk();
    await host.controller.regenerateRegionById(featureId);
    const after = keys(await host.cache());
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
  });

  it("a vertex edit adapts the forest and keeps its seed and containment", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(FOREST_RING, "forest", MIXED, "Wood", "forest");
    const seedBefore = (await host.fabric()).features.find((f) => f.id === featureId)!.properties.procgen!.seed;
    const ok = await host.controller.moveVertex(featureId, 1, [30, -26]);
    expect(ok).toBe(true);
    const seedAfter = (await host.fabric()).features.find((f) => f.id === featureId)!.properties.procgen!.seed;
    expect(seedAfter).toBe(seedBefore); // edit adapts, never re-rolls
    const report = host.controller.regionContainmentReport(featureId);
    expect(report.count).toBeGreaterThan(0);
    expect(report.outside).toBe(0);
  });

  it("a forest may overlap a city (different algorithms don't clash)", async () => {
    const host = cityHost();
    await host.controller.createRegionForTest(FOREST_RING, "city", { profile: "euro-medieval" }, "Town", "district");
    // The SAME footprint as a forest — legal, because overlap keys on algorithm.
    const res = await host.controller.createRegionForTest(FOREST_RING, "forest", MIXED, "Wolfswood", "forest");
    expect(res.count).toBeGreaterThan(0);
    expect(res.outside).toBe(0);
    expect((await host.fabric()).features.filter((f) => f.properties.procgen).length).toBe(2);
  });

  it("a plain sketched forest (no modal confirm) stays inert — no generation", async () => {
    const host = cityHost();
    const runsBefore = host.controller.generatorRunCount;
    const id = await host.controller.createFabricForTest("forest", FOREST_RING, "__plain_forest__");
    const feature = (await host.fabric()).features.find((f) => f.id === id)!;
    expect(isProcgenRegion(feature)).toBe(false);
    expect(host.controller.regionFeatureIds(id).length).toBe(0);
    expect(host.controller.generatorRunCount).toBe(runsBefore);
  });

  it("rejects malformed forest params at the zod boundary", async () => {
    const host = cityHost();
    await expect(
      host.controller.createRegionForTest(FOREST_RING, "forest", { variety: "mixed", density: 5, clearings: 0, edgeRaggedness: 0 }, "Bad", "forest")
    ).rejects.toThrow();
  });
});

// ─── Cross-layer regen cascade ──────────────────────────────────────────────
// The suite feels like one world: editing an UPSTREAM procgen region (a
// mountain, stage 0) regenerates the DOWNSTREAM regions that read its output
// (a river's slope coupling, stage 1), and leaves non-dependents
// byte-identical. Fabric is in display units (1 unit = 50 m); worldBounds are
// [-48,-36,48,36] so every fixture must fit inside.
describe("MapController — cross-layer cascade", () => {
  it("a river param edit re-routes the downstream city (GENERATED channel consumed as data)", async () => {
    const host = cityHost();
    // A windy river crossing the future district: the city consumes the
    // river's generated channel as upstream data, not just the raw sketch
    // line — so a params-only river edit (sketch geometry unchanged) must
    // change the city's bytes. Severed upstream wiring leaves them identical.
    const river = await host.controller.createSpineForTest(
      [
        [6, -30],
        [18, -18],
        [30, -6],
      ],
      "river",
      "river",
      { windiness: 0.5 },
      "R"
    );
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const netKey = regionNetworkKey(city.featureId);
    const bytes1 = JSON.stringify((await host.cache()).get(netKey)!.features);

    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });

    const bytes2 = JSON.stringify((await host.cache()).get(netKey)!.features);
    expect(bytes2).not.toBe(bytes1);
  });

  // A mountain, lower-left; a river spine crossing its interior; a city far
  // top-right (no shared field, no bbox overlap → a clean non-dependent).
  const MTN_RING: [number, number][] = [
    [-34, -22],
    [-14, -22],
    [-14, -4],
    [-34, -4],
  ];
  const RIVER_LINE: [number, number][] = [
    [-40, -26],
    [-24, -13],
    [-8, 0],
  ];
  const FAR_CITY_RING: [number, number][] = [
    [20, 18],
    [36, 18],
    [36, 32],
    [20, 32],
  ];

  it("editing a mountain regenerates the river that reads its elevation; a far city is byte-identical", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const mtn = await host.controller.createRegionForTest(
      MTN_RING,
      "mountain",
      { terrain: "alpine", amplitude: 0.3, roughness: 0.4 },
      "__casc_mtn__",
      "mountain"
    );
    const river = await host.controller.createSpineForTest(
      RIVER_LINE,
      "river",
      "river",
      { windiness: 0.85, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 },
      "__casc_river__"
    );
    const city = await host.controller.createRegionForTest(
      FAR_CITY_RING,
      "city",
      { profile: "euro-medieval" },
      "__casc_city__",
      "district"
    );
    expect(river.count).toBeGreaterThan(0);
    expect(city.count).toBeGreaterThan(0);

    const cityBefore = host.controller.regionFeatureIds(city.featureId);
    const runsBefore = host.controller.generatorRunCount;

    // Edit the UPSTREAM mountain's relief (amplitude) — the cascade regenerates
    // the mountain and re-runs the river that reads it.
    await host.controller.setRegionParams(mtn.featureId, { terrain: "alpine", amplitude: 0.95, roughness: 0.6 });

    // The cascade regenerated exactly the DEPENDENTS (the river reads the
    // mountain's elevation field) — a DAG-deterministic, seed-
    // independent claim (an output-byte-diff would be seed-flaky: mm
    // quantization can round a small meander shift away). The mountain itself is
    // the edited ROOT (regenerated separately, not part of the downstream set).
    expect(host.controller.generatorRunCount).toBeGreaterThan(runsBefore);
    expect(host.controller.cascadeRegeneratedIds).toContain(river.featureId);
    // The far city consumes water/vegetation, not elevation, and is out of
    // range — a true non-dependent: NOT in the cascade, and byte-identical.
    expect(host.controller.cascadeRegeneratedIds).not.toContain(city.featureId);
    expect(host.controller.regionFeatureIds(city.featureId)).toEqual(cityBefore);
  });

  it("a city overlapping a mountain is NOT a dependent (produces/consumes edge gate)", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const mtn = await host.controller.createRegionForTest(
      MTN_RING,
      "mountain",
      { terrain: "alpine", amplitude: 0.4, roughness: 0.4 },
      "__casc2_mtn__",
      "mountain"
    );
    // A district overlapping the mountain (different algorithms may overlap).
    const city = await host.controller.createRegionForTest(
      [
        [-30, -18],
        [-18, -18],
        [-18, -8],
        [-30, -8],
      ],
      "city",
      { profile: "euro-medieval" },
      "__casc2_city__",
      "district"
    );
    const cityBefore = host.controller.regionFeatureIds(city.featureId);

    await host.controller.setRegionParams(mtn.featureId, { terrain: "alpine", amplitude: 0.95, roughness: 0.6 });

    // The city does not consume `elevation`, so despite the bbox overlap there
    // is no DAG edge mountain→city — the city is untouched (the §3-refined edge
    // rule, integration-proven).
    expect(host.controller.regionFeatureIds(city.featureId)).toEqual(cityBefore);
  });

  it("undo of a mountain edit restores the cascaded river byte-identically", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const mtn = await host.controller.createRegionForTest(
      MTN_RING,
      "mountain",
      { terrain: "alpine", amplitude: 0.3, roughness: 0.4 },
      "__casc3_mtn__",
      "mountain"
    );
    const river = await host.controller.createSpineForTest(
      RIVER_LINE,
      "river",
      "river",
      { windiness: 0.85, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 },
      "__casc3_river__"
    );
    const riverBefore = host.controller.regionFeatureIds(river.featureId).slice().sort();

    await host.controller.setRegionParams(mtn.featureId, { terrain: "alpine", amplitude: 0.95, roughness: 0.6 });
    // The cascade regenerated the river (deterministic — an output diff would be
    // seed-flaky).
    expect(host.controller.cascadeRegeneratedIds).toContain(river.featureId);

    // Undo re-runs the same cascade with the restored inputs → deterministic →
    // the river returns byte-identically.
    await host.controller.undoLastEdit();
    expect(host.controller.cascadeRegeneratedIds).toContain(river.featureId);
    expect(host.controller.regionFeatureIds(river.featureId).slice().sort()).toEqual(riverBefore);
  });
});

// ─── Plan 031-A — network computed once per forced regen (P1) ────────────────
// A forced regen of a multi-tile region previously recomputed the whole-region
// network once PER TILE (byte-identical waste) and appended one duplicate
// network record per tile. RING spans ~9 generation tiles (500–1300 m over a
// 600 m grid), so the buggy path ran the generator ~9× and wrote ~9 network
// records; the fix reads the network back after the first tile writes it.
describe("MapController — network once per forced regen (031-A)", () => {
  /** How many raw JSONL lines carry `key`. `readCachedTiles` dedups on read
   * (last-wins), so the deduped Map hides duplicate appends — the raw line
   * count is what actually catches P1's per-tile duplicate network records. */
  function rawRecordCount(host: FakeHost, key: string): number {
    const text = host.cacheShardText(key);
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as { key?: string }).key === key) n++;
      } catch {
        /* ignore non-JSON */
      }
    }
    return n;
  }

  it("runs the generator exactly once and writes one network record per forced regen", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const netKey = regionNetworkKey(featureId);
    // Sanity: the region genuinely spans multiple generation tiles (else the
    // "once per tile" bug is invisible and the test proves nothing).
    expect(host.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0);

    const runsBefore = host.controller.generatorRunCount;
    await host.controller.regenerateRegionById(featureId); // one forced regen
    expect(host.controller.generatorRunCount - runsBefore).toBe(1);
    // Exactly one network record survives the forced pass — no per-tile duplicates.
    expect(rawRecordCount(host, netKey)).toBe(1);
  });

  it("a forced regen leaves the region output byte-identical (P1 fix changes nothing)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache())
      if (k.startsWith(`region:${featureId}:`)) before.set(k, JSON.stringify(rec.features));
    expect(before.size).toBeGreaterThan(1);

    await host.controller.regenerateRegionById(featureId);

    const after = new Map<string, string>();
    for (const [k, rec] of await host.cache())
      if (k.startsWith(`region:${featureId}:`)) after.set(k, JSON.stringify(rec.features));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
  });
});

// ─── Plan 031-B — batching parity (one fp pass, one shared read, one paint) ───
// A multi-region flush/cascade previously recomputed fingerprints per region
// (O(R²)), re-read the whole `.mapcache` per upstream lookup, and fired one
// repaint per region. 031-B threads ONE fingerprint pass + ONE shared cache
// view and coalesces repaints — all byte-identical (only IO/paint counts move).
describe("MapController — batching parity (031-B)", () => {
  // A windy river crossing the future district — the city consumes its
  // generated channel, so a river regen cascades to the city (a 2-region batch).
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [30, -6],
  ];

  async function riverThenCity(host: FakeHost): Promise<{ riverId: string; cityId: string }> {
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    return { riverId: river.featureId, cityId: city.featureId };
  }

  it("a flush hashes once, reads the shared cache once, and paints once regardless of region count", async () => {
    const host = cityHost();
    const { riverId, cityId } = await riverThenCity(host);

    const fpBefore = host.controller.fingerprintPassCount;
    const readsBefore = host.readCachedCount;
    const paintsBefore = host.repaintGeneratedCount;

    // Queue a region regen of the river; the flush force-regens the river AND
    // cascades to the city that consumes its channel — a genuine 2-region batch.
    host.controller.queueRegionRegen(riverId);
    await host.controller.flushSketchRegen();

    expect(host.controller.cascadeRegeneratedIds).toContain(cityId); // batch really spanned both
    expect(host.controller.fingerprintPassCount - fpBefore).toBe(1); // ONE fp pass
    // ZERO disk reads: the persistent session view (032-B) was warmed during
    // setup, so this batch (and every later one) is served from memory. Under
    // 031-B alone this was 1 (one shared read per batch); 032-B drops it to 0.
    expect(host.readCachedCount - readsBefore).toBe(0);
    expect(host.repaintGeneratedCount - paintsBefore).toBe(1); // ONE coalesced paint
  });

  it("batched flush output is byte-identical to a from-scratch replay (parity by construction)", async () => {
    const host = cityHost();
    const { riverId, cityId } = await riverThenCity(host);
    host.controller.queueRegionRegen(riverId);
    await host.controller.flushSketchRegen();

    const netBytes = async (h: FakeHost): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      for (const [k, rec] of await h.cache())
        if (k === regionNetworkKey(riverId) || k === regionNetworkKey(cityId)) out.set(k, JSON.stringify(rec.features));
      return out;
    };
    const live = await netBytes(host);
    expect(live.size).toBe(2);

    // Reopen on the same vault, wipe the cache, and replay from scratch (stage
    // order). The batched-flush bytes must equal the from-scratch bytes.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.clearCacheOnDisk();
    await reopened.controller.replayGeneratedManifest();
    const replayed = await netBytes(reopened);

    for (const [k, bytes] of live) expect(replayed.get(k)).toBe(bytes);
  });
});

// ─── Plan 031-C — stage-ordered raw-sketch channel (P2/P3 correctness) ───────
// The raw-sketch reach previously force-regened affected regions in FABRIC FILE
// ORDER, so a downstream city ordered before its upstream river read the river's
// OLD channel, got stamped with a FRESH fingerprint, and survived reloads as
// permanently-stale bytes (research P2; P3 is the same in queue order). The fix
// merges the region-edit roots with the raw-sketch reach into ONE (stage,id)
// walk, so an upstream's fresh network always lands before a downstream reads it.
describe("MapController — stage-ordered raw channel (031-C)", () => {
  // A river flowing INTO the city — its mouth (last spine point [24,-14]) sits
  // inside the district ring, so a water polygon at the mouth is within
  // CONSTRAINT_REACH of BOTH the river and the city.
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [24, -14],
  ];
  const RIVER_PARAMS = { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.5 };
  // A water polygon CONTAINING the river's mouth [24,-14] — the estuary signal
  // the river generator reads. Editing it (ejecting the mouth) re-generates the
  // river to different bytes; it sits inside the city ring, so both river and
  // city land in the affected set.
  const WATER_RING: [number, number][] = [
    [22, -16],
    [26, -16],
    [26, -12],
    [22, -12],
  ];

  async function netBytes(host: FakeHost): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [k, rec] of await host.cache()) if (k.endsWith(":network")) out.set(k, JSON.stringify(rec.features));
    return out;
  }

  it("regenerates an upstream river BEFORE the downstream city that reads it, despite adversarial file order (P2)", async () => {
    const host = cityHost();
    // Adversarial FABRIC FILE ORDER: the city (stage 3) is created — and written
    // to Fabric.geojson — BEFORE the river (stage 1) it consumes. A file-order
    // walk regenerates the city first off the river's STALE channel; the fix
    // walks (stage, id) so the river always lands first.
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const waterId = await host.controller.createFabricForTest("water", WATER_RING, "W");
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", RIVER_PARAMS, "R");

    // Confirm the region FILE order really is the adversarial city-before-river.
    const regionOrder = (await host.fabric()).features.filter((f) => isProcgenRegion(f)).map((f) => f.id);
    expect(regionOrder).toEqual([city.featureId, river.featureId]);

    // Edit the WATER polygon (a raw sketch near both regions) — the direct,
    // non-debounced affected-tiles path.
    await host.controller.moveVertex(waterId, 0, [23, -15]);

    // The raw edit fanned out to BOTH the upstream river and the downstream city
    // (both within CONSTRAINT_REACH of the water).
    const order = host.controller.forceRegenOrder;
    expect(order).toContain(river.featureId);
    expect(order).toContain(city.featureId);
    // THE P2 DISCRIMINATOR: despite the city sorting FIRST in the fabric file,
    // the stage-ordered walk regenerated the upstream river strictly BEFORE the
    // downstream city — so the raw channel can never regenerate a city off a
    // stale river channel and stamp it fresh. This assertion FAILS on the pre-fix
    // file-order walk (verified by disabling the sort). End-to-end byte tracking
    // of a downstream off a fresh upstream is proven separately by the river
    // PARAM-edit cascade test above and by the fingerprint-fresh property below.
    expect(order.indexOf(river.featureId)).toBeLessThan(order.indexOf(city.featureId));
  });

  it("after a single edit, every region's live bytes equal a from-scratch replay (fingerprint fresh ⇒ bytes fresh)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    // A river param edit genuinely cascades (the city consumes the channel).
    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });

    const live = await netBytes(host);
    expect(live.size).toBe(2);

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.clearCacheOnDisk();
    await reopened.controller.replayGeneratedManifest();
    const replayed = await netBytes(reopened);
    expect([...replayed.keys()].sort()).toEqual([...live.keys()].sort());
    for (const [k, bytes] of live) expect(replayed.get(k)).toBe(bytes);
  });

  it("region bytes are invariant to Fabric.geojson feature order (walk is (stage,id), never file order)", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const inOrder = await netBytes(host);
    expect(inOrder.size).toBe(2);

    // Reverse the persisted feature order, wipe the cache, replay from scratch.
    const reopened = host.reopen({ zoom: 10 });
    const fabric = await reopened.fabric();
    const shuffled = { ...fabric, features: [...fabric.features].reverse() };
    await reopened.adapter.write(fabricPath(reopened.campaign), JSON.stringify(shuffled, null, 2));
    await reopened.clearCacheOnDisk();
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    const shuffledBytes = await netBytes(reopened);

    expect([...shuffledBytes.keys()].sort()).toEqual([...inOrder.keys()].sort());
    for (const [k, bytes] of inOrder) expect(shuffledBytes.get(k)).toBe(bytes);
  });
});

// ─── Plan 032-A — cache sharding + monolith migration ────────────────────────
// `.mapcache/generated.jsonl` is split per region (`region-<id>.jsonl`) + a
// shared `world.jsonl`, so a drop is a per-shard file delete (not a whole-cache
// rewrite) and reads/appends scope to a shard. A pre-032 monolith is migrated
// line-by-line on first load; pinned-old network records MUST survive
// byte-identically (plan §3 STOP condition — else the region blanks).
describe("MapController — cache sharding (032-A)", () => {
  const RING2: [number, number][] = [
    [-26, 10],
    [-10, 10],
    [-10, 26],
    [-26, 26],
  ];

  /** Fold every cache shard back into one legacy `generated.jsonl` and delete
   * the shards — reproduces a pre-032 on-disk cache to migrate. */
  function collapseToMonolith(host: FakeHost): void {
    const dir = `${host.cacheDir()}/`;
    const lines: string[] = [];
    for (const [path, text] of [...host.adapter.files.entries()]) {
      if (!path.startsWith(dir)) continue;
      const base = path.slice(dir.length);
      if (base === "world.jsonl" || (base.startsWith("region-") && base.endsWith(".jsonl"))) {
        for (const l of text.split("\n")) if (l.trim()) lines.push(l);
        host.adapter.files.delete(path);
      }
    }
    host.adapter.files.set(`${dir}generated.jsonl`, lines.join("\n") + "\n");
  }

  it("a region's records land in its own shard; the world shard is a separate file", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const shard = host.cacheShardPath(regionNetworkKey(featureId));
    expect(shard).toBe(`${host.cacheDir()}/region-${featureId}.jsonl`);
    expect(host.adapter.files.has(shard)).toBe(true);
    // No monolith is ever written on the sharded path.
    expect(host.adapter.files.has(`${host.cacheDir()}/generated.jsonl`)).toBe(false);
    // Every cache line in this campaign belongs to that region's shard.
    for (const [path] of host.adapter.files) {
      if (path.startsWith(`${host.cacheDir()}/region-`)) expect(path).toBe(shard);
    }
  });

  it("generating a region appends ONLY to its own shard (no world / sibling writes)", async () => {
    const host = cityHost();
    host.adapter.appends.length = 0;
    host.adapter.writes.length = 0;
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const shard = host.cacheShardPath(regionNetworkKey(featureId));
    const cacheIO = [...host.adapter.appends, ...host.adapter.writes].filter((p) =>
      p.startsWith(`${host.cacheDir()}/`) && (p.endsWith("world.jsonl") || p.includes("/region-"))
    );
    expect(cacheIO.length).toBeGreaterThan(0);
    for (const p of cacheIO) expect(p).toBe(shard); // every cache write hit ONE shard
    expect(cacheIO).not.toContain(`${host.cacheDir()}/world.jsonl`);
  });

  it("dropping a region DELETES its shard and never rewrites a sibling shard", async () => {
    const host = cityHost();
    const a = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const b = await host.controller.createRegionForTest(RING2, "city", { profile: "euro-medieval" });
    const shardA = host.cacheShardPath(regionNetworkKey(a.featureId));
    const shardB = host.cacheShardPath(regionNetworkKey(b.featureId));
    expect(host.adapter.files.has(shardA)).toBe(true);
    expect(host.adapter.files.has(shardB)).toBe(true);

    host.adapter.removes.length = 0;
    host.adapter.writes.length = 0;
    await host.controller.removeRegionById(a.featureId);

    // A's whole key set empties its shard ⇒ file delete, NOT a rewrite.
    expect(host.adapter.removes).toContain(shardA);
    expect(host.adapter.writes).not.toContain(shardA);
    expect(host.adapter.files.has(shardA)).toBe(false);
    // B's shard is never touched by A's drop (no whole-cache rewrite — research P6).
    expect(host.adapter.writes).not.toContain(shardB);
    expect(host.adapter.removes).not.toContain(shardB);
    expect(host.adapter.files.has(shardB)).toBe(true);
  });

  it("migrates a legacy monolith into shards on first read, then deletes it", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache()) before.set(k, JSON.stringify(rec.features));

    collapseToMonolith(host);
    const monolith = `${host.cacheDir()}/generated.jsonl`;
    expect(host.adapter.files.has(monolith)).toBe(true);

    // A fresh controller reads the cache → migration splits + deletes the monolith.
    const reopened = host.reopen({ zoom: 10 });
    const after = new Map<string, string>();
    for (const [k, rec] of await reopened.cache()) after.set(k, JSON.stringify(rec.features));

    expect(reopened.adapter.files.has(monolith)).toBe(false); // monolith gone
    expect(reopened.adapter.files.has(host.cacheShardPath(regionNetworkKey(featureId)))).toBe(true);
    // Every record survives the split byte-for-byte.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
  });

  it("STOP condition: a pinned-old region's network record survives migration BYTE-IDENTICALLY and still renders cache-only", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    host.controller.overrideCurrentVersionForTest("city", 2); // now pinned-old (v1 < v2)
    const netKey = regionNetworkKey(featureId);
    // Capture the exact raw JSONL line for the pinned network record.
    const shard = host.cacheShardText(netKey);
    const netLineBefore = shard
      .split("\n")
      .find((l: string) => l.trim() && (JSON.parse(l) as { key?: string }).key === netKey);
    expect(netLineBefore).toBeDefined();

    collapseToMonolith(host);

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("city", 2);
    await reopened.controller.replayGeneratedManifest();

    // The migrated shard holds the pinned network record's line verbatim.
    const netLineAfter = reopened
      .cacheShardText(netKey)
      .split("\n")
      .find((l: string) => l.trim() && (JSON.parse(l) as { key?: string }).key === netKey);
    expect(netLineAfter).toBe(netLineBefore); // byte-identical

    // Cache-only render holds: no generator ran, region paints, no adoption badge.
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.controller.needsAdoptionIds()).toEqual([]);
    expect(reopened.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0);
  });
});

// ─── Plan 032-B — persistent in-memory cache view ────────────────────────────
// The generated cache is read from disk ONCE per campaign open, then kept live:
// region appends `.set()` into it and drops `.delete()` from it, so no batch
// re-reads a shard it already holds (research P7). The view is controller-owned,
// so a fresh controller (reopen / switch) starts empty and reads disk fresh —
// which is exactly why a lost write is harmless (reopen regenerates from a
// fingerprint miss, byte-identically).
describe("MapController — persistent cache view (032-B)", () => {
  it("reads the cache from disk exactly ONCE per session; consecutive batches never re-read", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    // Building the region (generate + its cascade) warmed the view with a SINGLE
    // disk read; everything after is served from memory.
    expect(host.readCachedCount).toBe(1);
    expect(host.controller.cacheViewSize).toBeGreaterThan(0);

    const before = host.readCachedCount;
    await host.controller.regenerateRegionById(featureId); // batch 1
    await host.controller.regenerateRegionById(featureId); // batch 2
    expect(host.readCachedCount - before).toBe(0); // zero re-reads across two edit batches
  });

  it("a flush and a cascade in the same session share ONE disk read (no per-batch re-read)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(
      [
        [6, -30],
        [18, -18],
        [30, -6],
      ],
      "river",
      "river",
      { windiness: 0.5 },
      "R"
    );
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const before = host.readCachedCount;
    host.controller.queueRegionRegen(river.featureId);
    await host.controller.flushSketchRegen(); // force-regen river + cascade to city
    await host.controller.regenerateRegionById(river.featureId); // another batch
    expect(host.readCachedCount - before).toBe(0);
  });

  it("crash consistency: a lost cache write is a fingerprint MISS that regenerates byte-identically on reopen", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache()) before.set(k, JSON.stringify(rec.features));
    expect(before.size).toBeGreaterThan(0);

    // Simulate a crash before the write-behind flushed: the shard never reached
    // disk. (Determinism makes lost writes harmless — the plan's write-behind
    // fallback is exactly this: reopen regenerates from fingerprint misses.)
    await host.clearCacheOnDisk();
    expect((await host.cache()).size).toBe(0);

    // A FRESH controller drops the in-memory view, reads disk, misses, and
    // regenerates from the durable sketch — byte-identically.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.generatorRunCount).toBeGreaterThan(0); // it DID recompute
    expect(reopened.controller.cacheViewSize).toBeGreaterThan(0); // view rebuilt on the read miss
    expect(reopened.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0);

    const after = new Map<string, string>();
    for (const [k, rec] of await reopened.cache()) after.set(k, JSON.stringify(rec.features));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes); // byte-identical
  });

  it("a drop removes the key from the live view (a later regen reads no stale record)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const netKey = regionNetworkKey(featureId);
    expect(host.controller.cacheViewSize).toBeGreaterThan(0);
    await host.controller.removeRegionById(featureId); // strips procgen → drops the region's cache
    // The view no longer holds the region's network record (write-through drop).
    const view = await host.cache(); // disk is the source of truth after a drop
    expect(view.has(netKey)).toBe(false);
  });
});

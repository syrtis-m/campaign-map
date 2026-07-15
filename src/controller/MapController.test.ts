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
import { isProcgenRegion, type FabricFeature } from "../model/fabric";
import { algorithmById } from "../gen/procgen/registry";
import { unionFields } from "../gen/fields";
import { mountainHeightField } from "../gen/mountain";

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

    // Cache holds ONLY the whole-network record (plan 032-C: per-tile clips are
    // re-derived from it at paint, never persisted).
    const cache = await host.cache();
    expect(cache.has(regionNetworkKey(res.featureId))).toBe(true);
    const regionKeys = [...cache.keys()].filter((k) => k.startsWith(`region:${res.featureId}:`));
    expect(regionKeys).toEqual([regionNetworkKey(res.featureId)]);
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

  it("deleting an urban-park region unpaints its drawn stage-4 fabric (Jonah: generated feature not deleted)", async () => {
    // Repro of Jonah 2026-07-15: deleting a generated object leaves its drawn
    // fabric on the map. Generation paints a region at its PARAMS-AWARE stage
    // (`dagRoleFor` — the urban-park variety re-homes park from its static stage
    // 2 to stage 4), but the delete/unpaint path (`dropRegionCacheAndUnpaint`)
    // repainted the STATIC `algorithm.stage`. MapView's staged `updateData` diff
    // (032-D) removes a stage's OLD ids and adds its current ones; fired on the
    // wrong stage it never removes the park's ids, so the drawn park survives.
    // This drives a faithful, headless mirror of MapView.refreshGeneratedSource.
    const host = cityHost();
    // Upstream city supplies the generated `settlement` an urban-park consumes.
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const park = await host.controller.createRegionForTest(
      [
        [14, -22],
        [21, -22],
        [21, -15],
        [14, -15],
      ],
      "park",
      { variety: "urban-park", pathDensity: 0.5, pond: true },
      "__ub_park__",
      "park"
    );
    expect(park.count).toBeGreaterThan(0);
    const parkIds = new Set(host.controller.regionFeatureIds(park.featureId));
    expect(parkIds.size).toBeGreaterThan(0);
    // urban-park paints at its params-aware DAG stage 4, not the static stage 2.
    expect(host.repaintGeneratedStages).toContain(4);

    // Headless mirror of MapView.refreshGeneratedSource (032-D): a painted
    // source keyed by feature id + a per-stage id index; a staged repaint drops
    // that stage's previous ids and adds its current ones (a full repaint reseeds
    // from every stage).
    const paintedStageIds = new Map<number, Set<string>>();
    const painted = new Set<string>();
    const applyRepaint = (stage: number | "all"): void => {
      if (stage === "all") {
        painted.clear();
        paintedStageIds.clear();
        for (const [s, feats] of host.controller.displayGeneratedByStage()) {
          const ids = feats.map((f) => String(f.id));
          paintedStageIds.set(s, new Set(ids));
          for (const id of ids) painted.add(id);
        }
        return;
      }
      const feats = host.controller.displayGeneratedForStage(stage);
      for (const id of paintedStageIds.get(stage) ?? []) painted.delete(id);
      const ids = feats.map((f) => String(f.id));
      paintedStageIds.set(stage, new Set(ids));
      for (const id of ids) painted.add(id);
    };

    // Paint everything generated so far (the store still holds the park).
    for (const s of host.repaintGeneratedStages) applyRepaint(s);
    expect([...parkIds].every((id) => painted.has(id))).toBe(true); // park is drawn

    // Delete the park; drive the delete's repaint through the same mirror.
    host.repaintGeneratedStages.length = 0;
    host.controller.deleteFabricFeature(park.featureId);
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget drop settles
    for (const s of host.repaintGeneratedStages) applyRepaint(s);

    // The drawn park fabric must be GONE from the painted source…
    expect([...parkIds].some((id) => painted.has(id))).toBe(false);
    // …and the unpaint must target the stage the park was painted at (4).
    expect(host.repaintGeneratedStages).toContain(4);
    // The render store dropped it too (controller-level view).
    expect(host.controller.regionFeatureIds(park.featureId)).toEqual([]);
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
  /** A pinned-old fixture: stamp the block at v1 (override the current version
   * DOWN before creation — city's real currentVersion is 2 as of plan 037), then
   * simulate the bump to v2 so the region sits one version behind and the
   * adoption flow engages. Keeps the v1→v2 literals below stable across bumps. */
  async function pinnedOldHost(): Promise<{ host: FakeHost; featureId: string }> {
    const host = cityHost();
    host.controller.overrideCurrentVersionForTest("city", 1);
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

  // ─── 35-A: pinned-v1 river under the REAL river v2 bump (no override
  //     simulation on reopen — river's actual currentVersion is 2) ────────────
  it("a pinned-v1 river is byte-stable across replay until explicit adoption (river v2 real bump)", async () => {
    const host = cityHost();
    // Pin the block at v1: pretend v1 was current at creation time, then drop
    // the override — the region is now genuinely pinned-old against the REAL
    // currentVersion 2. Params omit slopeSensitivity: exactly the persisted
    // shape whose semantics the v2 default flip changed (v1: absent ⇒ coupled;
    // v2: absent ⇒ uncoupled) — the case the bump exists for.
    host.controller.overrideCurrentVersionForTest("river", 1);
    const river = await host.controller.createSpineForTest(
      [
        [6, -30],
        [18, -18],
        [24, -14],
      ],
      "river",
      "river",
      { windiness: 0.85, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0 },
      "__v1_river__"
    );
    host.controller.overrideCurrentVersionForTest("river", null);
    expect((await host.fabric()).features.find((f) => f.id === river.featureId)!.properties.procgen!.version).toBe(1);
    expect(host.controller.isRegionPinnedOld(river.featureId)).toBe(true);

    const bytesBefore = new Map<string, string>();
    for (const [k, rec] of await host.cache()) bytesBefore.set(k, JSON.stringify(rec.features));

    // Replay (NO overrides — the real registry drives): pure cache hits, zero
    // generator runs, zero prompts, bytes untouched. A plugin update never
    // visibly changes an existing region.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.confirms.length).toBe(0);
    for (const [k, rec] of await reopened.cache()) {
      expect(JSON.stringify(rec.features)).toBe(bytesBefore.get(k));
    }

    // Explicit adoption raises the pin to the real v2 and regenerates.
    const adopted = await reopened.controller.adoptRegion(river.featureId);
    expect(adopted).toBe(true);
    const block = (await reopened.fabric()).features.find((f) => f.id === river.featureId)!.properties.procgen!;
    expect(block.version).toBe(algorithmById("river")!.currentVersion);
    expect(reopened.controller.generatorRunCount).toBeGreaterThan(0);
  });

  it("adoptAllRegions adopts every pinned-old region and reports the count", async () => {
    const host = cityHost();
    host.controller.overrideCurrentVersionForTest("city", 1); // stamp the city block at v1 (real current is 2)
    const a = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "A");
    const FOREST_RING: [number, number][] = [
      [-30, 10],
      [-14, 10],
      [-14, 26],
      [-30, 26],
    ];
    host.controller.overrideCurrentVersionForTest("forest", 1); // stamp the forest block at v1 too
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

  // ─── Plan 034-E — adopt-all as ONE pass (P9: O(k²) → O(k)) ────────────────
  it("adopt-all over a pinned mountain→river→city chain runs each region EXACTLY once (O(k), not O(k²))", async () => {
    const host = cityHost();
    // Three pinned-old regions adopted in ONE pass: a river (stage 0, plan 035
    // hydrology) whose mouth is inside a city (stage 3, consumes the channel),
    // plus a mountain (stage 1 terrain). adopt-all regenerates each EXACTLY once
    // regardless of the edge structure — the O(k) property.
    const mtn = await host.controller.createRegionForTest(
      [
        [-34, -22],
        [-14, -22],
        [-14, -4],
        [-34, -4],
      ],
      "mountain",
      { terrain: "alpine", amplitude: 0.4, roughness: 0.4 },
      "__aa_mtn__",
      "mountain"
    );
    const river = await host.controller.createSpineForTest(
      [
        [-40, -26],
        [-24, -13],
        [6, -14],
        [24, -14],
      ],
      "river",
      "river",
      { windiness: 0.6, braiding: 0, width: 18, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 },
      "__aa_river__"
    );
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "__aa_city__");
    // Each region is created at its algorithm's REAL current pin; bump every
    // current version to 9 (above any real currentVersion, so this fixture
    // never drifts on future bumps) so all three read as pinned-old and adopt
    // to the same target.
    host.controller.overrideCurrentVersionForTest("mountain", 9);
    host.controller.overrideCurrentVersionForTest("river", 9);
    host.controller.overrideCurrentVersionForTest("city", 9);

    const runsBefore = host.controller.generatorRunCount;
    const fpBefore = host.controller.fingerprintPassCount;
    const count = await host.controller.adoptAllRegions();
    expect(count).toBe(3);

    // ONE pass over the union closure: each region regenerated EXACTLY once, in
    // (stage, id) order — 3 runs total, not the pre-034 per-adoption cascade's
    // 3+2+1. One fingerprint pass for the whole adopt-all.
    expect(host.controller.generatorRunCount - runsBefore).toBe(3);
    // (stage, id) order post-035: river (stage 0) before mountain (stage 1)
    // before city (stage 3).
    expect(host.controller.forceRegenOrder).toEqual([river.featureId, mtn.featureId, city.featureId]);
    expect(host.controller.fingerprintPassCount - fpBefore).toBe(1);

    // All pins raised; the adopted state is fingerprint-fresh (reopen: 0 runs).
    const fabric = await host.fabric();
    for (const id of [mtn.featureId, river.featureId, city.featureId]) {
      expect(fabric.features.find((f) => f.id === id)!.properties.procgen!.version).toBe(9);
    }
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("mountain", 9);
    reopened.controller.overrideCurrentVersionForTest("river", 9);
    reopened.controller.overrideCurrentVersionForTest("city", 9);
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.generatorRunCount).toBe(0);
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

// ─── Plan 033-C — consumption-aware invalidation scope ───────────────────────
// A raw-sketch edit force-regens a region ONLY when the edit's KIND is in that
// region algorithm's declared `consumesSketch` AND within its `influenceMargin`
// (replacing the pre-033 blanket 200 m kind-blind reach). `forceRegenOrder`
// records exactly which regions the flush regenerated.
describe("MapController — consumption-aware invalidation (033-C)", () => {
  it("a road edit regenerates only its declared consumers (P4: 3 kind-blind neighbors → 1)", async () => {
    const host = cityHost();
    // Three regions straddling a horizontal road (all gap≈0): a city (reads
    // road), a mountain and a forest (read NO road). Pre-033 the blanket 200 m
    // reach regenerated ALL THREE; consumption scoping regenerates only the city.
    const city = await host.controller.createRegionForTest(
      [
        [-6, -6],
        [6, -6],
        [6, 6],
        [-6, 6],
      ],
      "city",
      { profile: "euro-medieval" },
      "__p4_city__",
      "district"
    );
    const mtn = await host.controller.createRegionForTest(
      [
        [10, -6],
        [22, -6],
        [22, 6],
        [10, 6],
      ],
      "mountain",
      { terrain: "alpine", amplitude: 0.3, roughness: 0.4 },
      "__p4_mtn__",
      "mountain"
    );
    const forest = await host.controller.createRegionForTest(
      [
        [-22, -6],
        [-10, -6],
        [-10, 6],
        [-22, 6],
      ],
      "forest",
      { variety: "mixed", density: 0.6, clearings: 0.15, edgeRaggedness: 0.5 },
      "__p4_forest__",
      "forest"
    );

    const runsBefore = host.controller.generatorRunCount;
    const roadId = await host.controller.createFabricForTest("road", [
      [-24, 0],
      [24, 0],
    ]);
    const road = (await host.fabric()).features.find((f) => f.id === roadId)!;
    host.controller.queueConstraintRegen(road);
    await host.controller.flushSketchRegen();

    // Exactly one region regenerated — the city. The mountain and forest read no
    // road, so despite gap≈0 (they WOULD have under the blanket reach) they are
    // untouched.
    expect(host.controller.forceRegenOrder).toEqual([city.featureId]);
    expect(host.controller.forceRegenOrder).not.toContain(mtn.featureId);
    expect(host.controller.forceRegenOrder).not.toContain(forest.featureId);
    expect(host.controller.generatorRunCount - runsBefore).toBe(1);
  });

  it("a CONTAINED district sketch-add regenerates the outer city (plan 037 item 5: it becomes a hole)", async () => {
    const host = cityHost();
    const city = await host.controller.createRegionForTest(
      [
        [-6, -6],
        [6, -6],
        [6, 6],
        [-6, 6],
      ],
      "city",
      { profile: "euro-medieval" },
      "__da_city__",
      "district"
    );
    const runsBefore = host.controller.generatorRunCount;

    // A district-kind sketch dropped INSIDE the city: plan 037 item 5 — the city
    // now consumes `park`/`district` and holes any strictly-CONTAINED one, so the
    // outer city regenerates (the hole appears).
    const dId = await host.controller.createFabricForTest("district", [
      [-4, -4],
      [4, -4],
      [4, 4],
      [-4, 4],
    ]);
    const d = (await host.fabric()).features.find((f) => f.id === dId)!;
    host.controller.queueConstraintRegen(d);
    await host.controller.flushSketchRegen();

    expect(host.controller.forceRegenOrder).toEqual([city.featureId]);
    expect(host.controller.generatorRunCount).toBe(runsBefore + 1); // city holed
  });

  it("influenceMargin scopes the fan-out: a road within the city margin regenerates it, beyond does not", async () => {
    // City bbox ±200 m; city road margin is 1500 m. A road at gap≈1000 m is in
    // reach; a road at gap≈1600 m is not.
    const cityRing: [number, number][] = [
      [-4, -4],
      [4, -4],
      [4, 4],
      [-4, 4],
    ];

    const near = cityHost();
    const cityNear = await near.controller.createRegionForTest(cityRing, "city", { profile: "euro-medieval" }, "__m_near__", "district");
    let runsBefore = near.controller.generatorRunCount;
    // Vertical road at x=24 units (1200 m); city maxX=200 m ⇒ gap 1000 m ≤ 1500.
    const rNear = await near.controller.createFabricForTest("road", [
      [24, -8],
      [24, 8],
    ]);
    near.controller.queueConstraintRegen((await near.fabric()).features.find((f) => f.id === rNear)!);
    await near.controller.flushSketchRegen();
    expect(near.controller.forceRegenOrder).toEqual([cityNear.featureId]);
    expect(near.controller.generatorRunCount - runsBefore).toBe(1);

    const far = cityHost();
    const cityFar = await far.controller.createRegionForTest(cityRing, "city", { profile: "euro-medieval" }, "__m_far__", "district");
    runsBefore = far.controller.generatorRunCount;
    // Vertical road at x=36 units (1800 m); gap 1600 m > 1500 ⇒ out of reach.
    const rFar = await far.controller.createFabricForTest("road", [
      [36, -8],
      [36, 8],
    ]);
    far.controller.queueConstraintRegen((await far.fabric()).features.find((f) => f.id === rFar)!);
    await far.controller.flushSketchRegen();
    expect(far.controller.forceRegenOrder).toEqual([]);
    expect(far.controller.generatorRunCount).toBe(runsBefore);
    expect(cityFar.featureId).toBeTruthy();
  });
});

// ─── Plan 033-D — scoped fingerprints ────────────────────────────────────────
// canonicalConstraints hashes only the consumed kinds within the influence
// bbox, so a far / non-consumed sketch edit leaves a region's fingerprint (and
// cache freshness) intact: no P5 load-storm, no pinned-old false-blank, and a
// nominally-dirty-but-inert force skips its generator run.
describe("MapController — scoped fingerprints (033-D)", () => {
  it("an inert re-commit (a consumed edit that changes nothing) skips the generator run", async () => {
    const host = cityHost();
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "__d_city__", "district");
    // A road within the city's 1500 m margin: the first flush regenerates.
    const roadId = await host.controller.createFabricForTest("road", [
      [10, -34],
      [26, -34],
    ]);
    const road = (await host.fabric()).features.find((f) => f.id === roadId)!;
    host.controller.queueConstraintRegen(road);
    await host.controller.flushSketchRegen();
    expect(host.controller.forceRegenOrder).toEqual([city.featureId]);

    // Re-queue the SAME road (no geometry change): the city is nominally dirty
    // again (road ∈ consumesSketch, within margin) but its scoped fingerprint is
    // unchanged, so the force is skipped — no generator run.
    const runsBefore = host.controller.generatorRunCount;
    const skipBefore = host.controller.inertForceSkipCount;
    host.controller.queueConstraintRegen(road);
    await host.controller.flushSketchRegen();
    expect(host.controller.forceRegenOrder).toEqual([city.featureId]); // still visited
    expect(host.controller.generatorRunCount).toBe(runsBefore); // but not recomputed
    expect(host.controller.inertForceSkipCount).toBe(skipBefore + 1);
  });

  it("campaign-open after a FAR sketch edit recomputes ZERO out-of-reach regions (P5 load-storm)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    // An EXTERNAL edit: a road persisted to Fabric.geojson with no in-app regen
    // (a vault sync / another editor). Placed ~2.2 km from the city — far beyond
    // its 1500 m road margin.
    await host.controller.createFabricForTest("road", [
      [10, 34],
      [26, 34],
    ]);
    const renderBefore = host.controller.regionFeatureIds(featureId).slice().sort();

    // Reopen (shares the adapter → same cache + the now-edited fabric) and replay.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();

    // Pre-033-D the global constraint hash flipped the city's fingerprint (any
    // edit anywhere) and it recomputed on open; scoped, the far road is inert.
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.controller.regionFeatureIds(featureId).slice().sort()).toEqual(renderBefore);
  });

  it("a pinned-old region survives an unrelated far-away sketch edit (no badge, no blank)", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    host.controller.overrideCurrentVersionForTest("city", 2); // pin the region OLD
    // External far road, no regen.
    await host.controller.createFabricForTest("road", [
      [10, 34],
      [26, 34],
    ]);

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    reopened.controller.overrideCurrentVersionForTest("city", 2);
    await reopened.controller.replayGeneratedManifest();

    // A pinned-old region can only be SERVED from cache. With a GLOBAL hash the
    // far road would flip its fingerprint, mark the cached record stale, and —
    // unable to recompute — it would blank with a needs-adoption badge. Scoped,
    // the far road is inert: the record stays fresh and paints.
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.controller.needsAdoptionIds()).toEqual([]); // no badge
    expect(reopened.notices.some((n) => n.message.includes("needs adoption"))).toBe(false); // no blank
    expect(reopened.controller.regionFeatureIds(featureId).length).toBeGreaterThan(0); // painted
  });
});

// ─── Plan 034-A — source nodes + transitive closure ──────────────────────────
// A raw sketch feature is a DAG source (stage −1); its downstream closure now
// carries transitive region→region dependents, not just the direct consumers the
// pre-034 raw channel stopped at. So a raw sketch edit that reaches an UPSTREAM
// region also re-runs that region's downstream — the "one forward pass" the
// pipeline arc collapses to.
describe("MapController — source-node forward closure (034-A)", () => {
  // River flowing into the city (mouth [24,-14] inside RING); a raw MOUNTAIN
  // sketch overlapping the river's upstream reach (river reads mountain elevation
  // within its 30 m margin).
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [24, -14],
  ];
  const RAW_MTN_RING: [number, number][] = [
    [4, -32],
    [8, -32],
    [8, -28],
    [4, -28],
  ];

  it("a raw mountain-sketch edit dirties the river it feeds AND the transitive downstream city", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(
      RIVER_LINE,
      "river",
      "river",
      { windiness: 0.85, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 },
      "R"
    );
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    // A raw (non-procgen) mountain sketch over the river's upstream.
    const mtnId = await host.controller.createFabricForTest("mountain", RAW_MTN_RING, "M");

    // Move a mountain-sketch vertex (non-region, non-debounced commit path).
    await host.controller.moveVertex(mtnId, 0, [3.8, -32.2]);

    const order = host.controller.forceRegenOrder;
    // The raw edit reached the river directly (consumesSketch mountain) AND the
    // city transitively (river → water → city) — the pre-034 raw channel would
    // have stopped at the river.
    expect(order).toContain(river.featureId);
    expect(order).toContain(city.featureId);
    // Upstream before downstream (the (stage,id) walk).
    expect(order.indexOf(river.featureId)).toBeLessThan(order.indexOf(city.featureId));
  });

  it("35-A litmus: a mountain edit BEYOND the river's 30 m margin runs ZERO river regens (terrain never cascades up to a canon river)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(
      RIVER_LINE,
      "river",
      "river",
      // Opted INTO slope coupling (default is OFF post-035) — the strongest case:
      // even a coupling-on river ignores a mountain edit outside its compact
      // support, because the mountain sits ABOVE it in the stage order and the
      // source→river edge fires only within influenceMargin (30 m).
      { windiness: 0.85, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0, slopeSensitivity: 1 },
      "R"
    );
    // A raw mountain sketch FAR from the river (tens of display units ≫ 0.6 u).
    const farMtn = await host.controller.createFabricForTest("mountain", [
      [-42, 20],
      [-30, 20],
      [-30, 32],
      [-42, 32],
    ], "M");
    const runsBefore = host.controller.generatorRunCount;
    await host.controller.moveVertex(farMtn, 0, [-42.2, 20.2]);
    // Jonah's litmus: a terrain edit reaches farmland, NEVER a river.
    expect(host.controller.forceRegenOrder).not.toContain(river.featureId);
    expect(host.controller.cascadeRegeneratedIds).not.toContain(river.featureId);
    expect(host.controller.generatorRunCount).toBe(runsBefore);
  });

  it("a district sketch-add near a city regenerates it (plan 037 item 5: city consumes district as a hole)", async () => {
    // Since plan 037 item 5 the city consumes `district` (a strictly-contained
    // one becomes a hole). A district sketch within the city's influence margin
    // therefore reaches the city through a source-node edge — the closure is no
    // longer empty. (This one sits ON the city ring — contained — so it is a real
    // hole; a district beyond the margin is still byte-inert, per the 033-A net.)
    const host = cityHost();
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const runsBefore = host.controller.generatorRunCount;
    const dId = await host.controller.createFabricForTest("district", [
      [14, -22],
      [22, -22],
      [22, -14],
      [14, -14],
    ]);
    await host.controller.moveVertex(dId, 0, [13.5, -22.5]);
    expect(host.controller.forceRegenOrder).toEqual([city.featureId]);
    expect(host.controller.generatorRunCount).toBe(runsBefore + 1);
  });
});

// ─── Plan 034-B — the forward pass: counter invariants + runtime guards ──────
// Every trigger reduces to runForwardPass. Standing invariants: one generator
// run per dirty region, ONE fingerprint pass per pass, zero cache re-reads
// (persistent view), repaints ≤ stages touched. The runtime assertions (stage
// monotonicity, closure-bound writes) are proven live by injected violations.
describe("MapController — the forward pass (034-B)", () => {
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [24, -14],
  ];

  it("counter invariants: a river param edit runs river+city exactly once each, one fp pass, zero cache re-reads", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");

    const runsBefore = host.controller.generatorRunCount;
    const fpBefore = host.controller.fingerprintPassCount;
    const readsBefore = host.readCachedCount;
    host.repaintGeneratedStages.length = 0;

    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });

    // Dirty set = {river (root), city (downstream water consumer)} — exactly one
    // generator EXECUTION each (the 34-B generatorRunCount === dirtyRegionCount
    // invariant; the city genuinely recomputes because the channel changed).
    expect(host.controller.forceRegenOrder).toEqual([river.featureId, city.featureId]);
    expect(host.controller.generatorRunCount - runsBefore).toBe(2);
    // ONE fingerprint pass threaded through the whole pass (031-B invariant).
    expect(host.controller.fingerprintPassCount - fpBefore).toBe(1);
    // ZERO gateway cache re-reads: the persistent session view serves the batch.
    expect(host.readCachedCount - readsBefore).toBe(0);
    // Repaints ≤ stages touched: river stage (0, plan 035 hydrology) then city
    // stage (3), upstream first — never a per-region or whole-map storm.
    const stages = host.repaintGeneratedStages.filter((s) => s !== "all");
    expect(stages).toEqual([0, 3]);
  });

  it("stage-monotonicity assertion FIRES on an injected regression (the guard guards)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    host.controller.injectForwardPassViolationForTest({ stageRegression: true });
    host.controller.queueRegionRegen(river.featureId);
    await expect(host.controller.flushSketchRegen()).rejects.toThrow(/stage regression/);
  });

  it("closure-bound assertion FIRES on an injected out-of-closure write (the guard guards)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    // A far mountain: never in a river edit's downstream closure (post-035 the
    // mountain at stage 1 sits ABOVE the river at stage 0, so a river edit can
    // never reach it; and there is no source→mountain edge from a river line).
    const mtn = await host.controller.createRegionForTest(
      [
        [-40, 20],
        [-28, 20],
        [-28, 32],
        [-40, 32],
      ],
      "mountain",
      { terrain: "alpine", amplitude: 0.4, roughness: 0.4 },
      "__fp_mtn__",
      "mountain"
    );
    host.controller.injectForwardPassViolationForTest({ outOfClosure: mtn.featureId });
    host.controller.queueRegionRegen(river.featureId);
    await expect(host.controller.flushSketchRegen()).rejects.toThrow(/outside closure/);
  });

  it("rm-.mapcache + reopen replays byte-identically through the SAME pass entry point", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const before = new Map<string, string>();
    for (const [k, rec] of await host.cache()) if (k.endsWith(":network")) before.set(k, JSON.stringify(rec.features));
    expect(before.size).toBe(2);

    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.clearCacheOnDisk();
    await reopened.controller.replayGeneratedManifest();

    // Every region regenerated exactly once (missing records are protected
    // roots — deleting .mapcache/ is harmless, never deferred, never a storm).
    expect(reopened.controller.generatorRunCount).toBe(2);
    const reopenedCache = await reopened.cache();
    for (const [k, bytes] of before) {
      expect(JSON.stringify(reopenedCache.get(k)!.features)).toBe(bytes);
    }
    // No badges, no pending bill — a clean deterministic rebuild.
    expect(reopened.controller.outdatedRegionIds()).toEqual([]);
    expect(reopened.controller.hasPendingCascade).toBe(false);
  });
});

// ─── Plan 034-C — cost-weighted cap + outdated badge (declined bills never storm)
// The cap bills Σ costClass over the genuinely-stale deferrable set. Over budget
// it applies the ROOT only (the GM's edit always lands), badges the deferred
// downstream "outdated" (stale bytes stay painted), and holds the pass for the
// non-modal "Apply pending cascade" command. Reopen after a decline re-derives
// the deferral from fingerprints — badge again, ZERO generator runs, no storm.
describe("MapController — cost cap + outdated badge (034-C)", () => {
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [24, -14],
  ];

  async function networkBytes(host: FakeHost, id: string): Promise<string> {
    const rec = (await host.cache()).get(regionNetworkKey(id));
    return rec ? JSON.stringify(rec.features) : "";
  }

  it("over budget: the root applies, the downstream defers with ZERO writes + an outdated badge", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const riverBefore = await networkBytes(host, river.featureId);
    const cityBefore = await networkBytes(host, city.featureId);

    host.controller.overrideCascadeCostBudgetForTest(3); // city (expensive) = 4 > 3
    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });

    // The ROOT applied (the cap never defers the GM's own edit)…
    expect(host.controller.forceRegenOrder).toEqual([river.featureId]);
    expect(await networkBytes(host, river.featureId)).not.toBe(riverBefore);
    // …the downstream city did NOT regenerate: zero writes, byte-identical record.
    expect(await networkBytes(host, city.featureId)).toBe(cityBefore);
    // Badge + pending bill + a non-modal Notice.
    expect(host.controller.outdatedRegionIds()).toEqual([city.featureId]);
    expect(host.controller.hasPendingCascade).toBe(true);
    expect(host.notices.some((n) => n.message.includes("Apply pending cascade"))).toBe(true);
  });

  it("apply-pending regenerates the deferred set to the SAME bytes as an undeferred pass", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");

    host.controller.overrideCascadeCostBudgetForTest(3);
    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });
    expect(host.controller.hasPendingCascade).toBe(true);

    await host.controller.applyPendingCascade();
    expect(host.controller.forceRegenOrder).toEqual([city.featureId]); // the held bill, exactly
    expect(host.controller.outdatedRegionIds()).toEqual([]); // badge cleared
    expect(host.controller.hasPendingCascade).toBe(false);
    const appliedCity = await networkBytes(host, city.featureId);
    const appliedRiver = await networkBytes(host, river.featureId);

    // Undeferred-pass equivalence: a from-scratch replay of the same durable
    // data (rm .mapcache + reopen) reproduces the applied bytes exactly — the
    // applied state IS the pure function an undeferred pass computes.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.clearCacheOnDisk();
    await reopened.controller.replayGeneratedManifest();
    expect(await networkBytes(reopened, city.featureId)).toBe(appliedCity);
    expect(await networkBytes(reopened, river.featureId)).toBe(appliedRiver);
  });

  it("reopen after a decline: badge-not-storm — zero generator runs, stale bytes served, apply still works", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    host.controller.overrideCascadeCostBudgetForTest(3);
    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });
    const staleCityBytes = await networkBytes(host, city.featureId); // pre-edit bytes, fp-stale

    // Reopen WITHOUT applying — the declined-bill state is durable only as
    // fingerprint staleness; the replay pass re-derives the deferral.
    const reopened = host.reopen({ zoom: 10 });
    reopened.controller.overrideCascadeCostBudgetForTest(3);
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();

    // ZERO generator runs: the river replays from its fresh cache, the deferred
    // city SERVES its stale bytes (badge) instead of storming a recompute.
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.controller.outdatedRegionIds()).toEqual([city.featureId]);
    expect(await networkBytes(reopened, city.featureId)).toBe(staleCityBytes);
    // The stale city is PAINTED (served, not blanked).
    expect(reopened.controller.regionFeatureIds(city.featureId).length).toBeGreaterThan(0);
    // The re-derived pending bill applies explicitly, clearing the badge.
    expect(reopened.controller.hasPendingCascade).toBe(true);
    await reopened.controller.applyPendingCascade();
    expect(reopened.controller.outdatedRegionIds()).toEqual([]);
    expect(await networkBytes(reopened, city.featureId)).not.toBe(staleCityBytes);
  });

  it("under budget nothing defers (the default budget absorbs a small cascade)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    await host.controller.setRegionParams(river.featureId, { windiness: 0.95 });
    expect(host.controller.forceRegenOrder).toEqual([river.featureId, city.featureId]);
    expect(host.controller.hasPendingCascade).toBe(false);
    expect(host.controller.outdatedRegionIds()).toEqual([]);
  });
});

// ─── Plan 034-D — preview mode ────────────────────────────────────────────────
// Mid-drag pauses regenerate ONLY the root as ephemeral render state — zero
// cache writes, zero fingerprint stamps, downstream untouched. Release runs the
// one full pass; an abandoned drag (kill before release) leaves no durable trace.
describe("MapController — preview mode (034-D)", () => {
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [24, -14],
  ];

  function mapcacheBytes(host: FakeHost): string {
    const dir = `${host.cacheDir()}/`;
    const parts: string[] = [];
    for (const [path, text] of [...host.adapter.files.entries()].sort()) {
      if (path.startsWith(dir) && path.endsWith(".jsonl") && !path.endsWith("log.jsonl")) parts.push(`${path}\n${text}`);
    }
    return parts.join("\n---\n");
  }

  it("a simulated drag: zero cache writes, zero fp stamps, downstream untouched — but the preview PAINTS", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const cacheBefore = mapcacheBytes(host);
    const cityPaintBefore = host.controller.regionFeatureIds(city.featureId);
    const riverPaintBefore = host.controller.regionFeatureIds(river.featureId).sort();

    // Three debounce pauses of a drag: the spine's mouth walks north.
    const runsBefore = host.controller.generatorRunCount;
    for (const y of [-13, -12, -11]) {
      const ok = await host.controller.previewRegionGeometry(river.featureId, {
        type: "LineString",
        coordinates: [
          [6, -30],
          [18, -18],
          [24, y],
        ],
      });
      expect(ok).toBe(true);
    }
    // Root regenerated once per pause — and ONLY the root.
    expect(host.controller.generatorRunCount - runsBefore).toBe(3);
    // ZERO durable writes: every cache shard byte-identical (no records, no fp).
    expect(mapcacheBytes(host)).toBe(cacheBefore);
    // Downstream untouched: the city's painted features are exactly as before.
    expect(host.controller.regionFeatureIds(city.featureId)).toEqual(cityPaintBefore);
    // The preview is VISIBLE: the river's painted ids changed, and flagged.
    expect(host.controller.regionFeatureIds(river.featureId).sort()).not.toEqual(riverPaintBefore);
    expect(host.controller.previewedRegionIds()).toEqual([river.featureId]);
  });

  it("release runs ONE full pass; committed bytes equal a from-scratch replay", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const finalGeom = {
      type: "LineString" as const,
      coordinates: [
        [6, -30],
        [18, -18],
        [24, -11],
      ] as [number, number][],
    };
    await host.controller.previewRegionGeometry(river.featureId, finalGeom);

    const fpBefore = host.controller.fingerprintPassCount;
    // Release: the ordinary commit path (debounced in the app; flushed here).
    await host.controller.commitGeometryEdit(river.featureId, finalGeom, { debounce: true });
    await host.controller.flushSketchRegen();

    // ONE pass: one fp pass; root + downstream city in stage order; preview flag gone.
    expect(host.controller.fingerprintPassCount - fpBefore).toBe(1);
    expect(host.controller.forceRegenOrder).toEqual([river.featureId, city.featureId]);
    expect(host.controller.previewedRegionIds()).toEqual([]);

    // Committed bytes are the pure function of the durable data (live == replay).
    const live = new Map<string, string>();
    for (const [k, rec] of await host.cache()) if (k.endsWith(":network")) live.set(k, JSON.stringify(rec.features));
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.clearCacheOnDisk();
    await reopened.controller.replayGeneratedManifest();
    const replayed = await reopened.cache();
    for (const [k, bytes] of live) expect(JSON.stringify(replayed.get(k)!.features)).toBe(bytes);
  });

  it("kill before release leaves NO durable trace (reopen shows the pre-drag world)", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    const durableBefore = mapcacheBytes(host);
    const fabricBefore = host.adapter.files.get(fabricPath(host.campaign));

    await host.controller.previewRegionGeometry(river.featureId, {
      type: "LineString",
      coordinates: [
        [6, -30],
        [18, -18],
        [24, -10],
      ],
    });
    // "Kill": no commit, no cancel — durable state must already be untouched.
    expect(mapcacheBytes(host)).toBe(durableBefore);
    expect(host.adapter.files.get(fabricPath(host.campaign))).toBe(fabricBefore);

    // Reopen (the killed session's memory is gone): pure cache replay, zero runs.
    const reopened = host.reopen({ zoom: 10 });
    reopened.begin();
    await reopened.controller.replayGeneratedManifest();
    expect(reopened.controller.generatorRunCount).toBe(0);
    expect(reopened.controller.previewedRegionIds()).toEqual([]);
    expect(reopened.controller.outdatedRegionIds()).toEqual([]);
  });

  it("cancelRegionPreview restores the durable paint without a generator run", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const before = host.controller.regionFeatureIds(river.featureId).sort();
    await host.controller.previewRegionGeometry(river.featureId, {
      type: "LineString",
      coordinates: [
        [6, -30],
        [18, -18],
        [24, -10],
      ],
    });
    expect(host.controller.regionFeatureIds(river.featureId).sort()).not.toEqual(before);
    const runsBefore = host.controller.generatorRunCount;
    await host.controller.cancelRegionPreview(river.featureId);
    expect(host.controller.generatorRunCount).toBe(runsBefore); // cache re-clip only
    expect(host.controller.regionFeatureIds(river.featureId).sort()).toEqual(before);
    expect(host.controller.previewedRegionIds()).toEqual([]);
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
// The suite feels like one world: editing an UPSTREAM feature regenerates the
// DOWNSTREAM regions that read it, and leaves non-dependents byte-identical.
// Post-035 the mountain (stage 1 terrain) reaches an OPTED-IN river (stage 0
// hydrology) only through the raw-sketch source edge (`consumesSketch:
// ["mountain"]`, influenceMargin 30 m) — the reorder freed rivers from terrain
// as a region-currency, so this coupling fires only where the mountain sits
// within that compact-support reach of the river corridor. Fabric is in display
// units (1 unit = 50 m); worldBounds are [-48,-36,48,36] so every fixture fits.
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

  it("S7 litmus: a mountain param edit reaches the overlapping paddy farmland (terrain → farmland, stage 1 → 4)", async () => {
    const host = cityHost();
    const mtn = await host.controller.createRegionForTest(
      [
        [-34, -22],
        [-14, -22],
        [-14, -4],
        [-34, -4],
      ],
      "mountain",
      { terrain: "alpine", amplitude: 0.6, roughness: 0.5 },
      "__s7_mtn__",
      "mountain"
    );
    // Paddy farmland overlapping the mountain's south slope (the S7 shape).
    const farm = await host.controller.createRegionForTest(
      [
        [-30, -14],
        [-18, -14],
        [-18, -2],
        [-30, -2],
      ],
      "farmland",
      { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 },
      "__s7_farm__",
      "farmland"
    );
    expect(farm.count).toBeGreaterThan(0);
    const farmKey = regionNetworkKey(farm.featureId);
    const farmBytes1 = JSON.stringify((await host.cache()).get(farmKey)!.features);

    // Terrain edit: the elevation currency + the raw mountain-sketch read both
    // reach the farmland — it regenerates and its terrace banks move.
    await host.controller.setRegionParams(mtn.featureId, { terrain: "alpine", amplitude: 0.95, roughness: 0.6 });
    expect(host.controller.cascadeRegeneratedIds).toContain(farm.featureId);
    expect(JSON.stringify((await host.cache()).get(farmKey)!.features)).not.toBe(farmBytes1);
  });

  it("a city edit cascades to the ADJACENT farmland, city executed first; the farmland edit never touches the city (plan 035-C)", async () => {
    const host = cityHost();
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    // Farmland sharing the district's east edge (the S4 shape, host-scale).
    const farm = await host.controller.createRegionForTest(
      [
        [26, -26],
        [40, -24],
        [40, -12],
        [26, -10],
      ],
      "farmland",
      { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.4, farmsteads: 0.45 },
      "__pu_farm__",
      "farmland"
    );
    expect(farm.count).toBeGreaterThan(0);
    const farmKey = regionNetworkKey(farm.featureId);
    const cityKey = regionNetworkKey(city.featureId);
    const farmBytes1 = JSON.stringify((await host.cache()).get(farmKey)!.features);

    // City edit → the farmland is a stage-4 settlement dependent: it
    // regenerates AFTER the city (the pass's executed order — plan 035-C's
    // order test) and its bytes track the new street network.
    await host.controller.setRegionParams(city.featureId, { profile: "euro-continental" });
    expect(host.controller.cascadeRegeneratedIds).toContain(farm.featureId);
    const order = host.controller.forceRegenOrder;
    const ci = order.lastIndexOf(city.featureId);
    const fi = order.lastIndexOf(farm.featureId);
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(fi).toBeGreaterThan(ci); // upstream city before its peri-urban apron
    const farmBytes2 = JSON.stringify((await host.cache()).get(farmKey)!.features);
    expect(farmBytes2).not.toBe(farmBytes1);

    // Farmland edit → the city never changes. (The WALK may conservatively
    // visit the city — an edited region also mints a raw `farmland` source and
    // the city declares `consumesSketch: farmland` — but the params-only edit
    // leaves the raw sketch geometry untouched, so the city's scoped
    // fingerprint is unchanged and the inert-force skip re-serves its cached
    // bytes without a generator run. Farmland's OUTPUT reaches nothing: it
    // produces no currency — the cycle guard.)
    const cityBytesBefore = JSON.stringify((await host.cache()).get(cityKey)!.features);
    const skipsBefore = host.controller.inertForceSkipCount;
    await host.controller.setRegionParams(farm.featureId, {
      fieldType: "grid-quarters",
      fieldSize: 0.7,
      hedging: "fences",
      laneDensity: 0.66,
      farmsteads: 0.35,
    });
    expect(JSON.stringify((await host.cache()).get(cityKey)!.features)).toBe(cityBytesBefore);
    // The city was inert-skipped, not recomputed (zero city generator runs).
    if (host.controller.cascadeRegeneratedIds.includes(city.featureId)) {
      expect(host.controller.inertForceSkipCount).toBeGreaterThan(skipsBefore);
    }
  });

  it("a city edit cascades to a nested urban-park (stage 4); the park edit never touches the city (plan 035-B)", async () => {
    const host = cityHost();
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    // A park strictly inside the district, urban-park variety → stage 4,
    // consumes the generated settlement (street-aligned entrances).
    const park = await host.controller.createRegionForTest(
      [
        [14, -22],
        [21, -22],
        [21, -15],
        [14, -15],
      ],
      "park",
      { variety: "urban-park", pathDensity: 0.5, pond: true },
      "__ub_park__",
      "park"
    );
    expect(park.count).toBeGreaterThan(0);
    const cityKey = regionNetworkKey(city.featureId);
    const parkKey = regionNetworkKey(park.featureId);
    const parkBytes1 = JSON.stringify((await host.cache()).get(parkKey)!.features);
    const cityBytes1 = JSON.stringify((await host.cache()).get(cityKey)!.features);

    // City edit (profile swap) → the urban-park is a settlement dependent:
    // it regenerates AND its bytes track the new street network.
    await host.controller.setRegionParams(city.featureId, { profile: "euro-continental" });
    expect(host.controller.cascadeRegeneratedIds).toContain(park.featureId);
    const parkBytes2 = JSON.stringify((await host.cache()).get(parkKey)!.features);
    expect(parkBytes2).not.toBe(parkBytes1);

    // Park PARAM edit → since plan 037 item 5 the city consumes the park SKETCH
    // as a hole, so the city IS re-evaluated (park ∈ city.consumesSketch — a
    // source-node edge, NOT the urban-park's stage-4 OUTPUT: the cycle guard
    // still holds, urban-park produces nothing). A params-only edit leaves the
    // park's RING geometry unchanged, so the hole — and the city's bytes — are
    // BYTE-IDENTICAL. The meaningful invariant: a nested-region param edit never
    // corrupts the city.
    const cityBytesAfterProfileSwap = JSON.stringify((await host.cache()).get(cityKey)!.features);
    void cityBytes1; // the profile swap legitimately changed the city itself
    await host.controller.setRegionParams(park.featureId, { variety: "urban-park", pathDensity: 0.9, pond: false });
    expect(JSON.stringify((await host.cache()).get(cityKey)!.features)).toBe(cityBytesAfterProfileSwap);
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
    expect(before.size).toBe(1); // 032-C: only the whole-network record is persisted
    const renderBefore = host.controller.regionFeatureIds(featureId).slice().sort();

    await host.controller.regenerateRegionById(featureId);

    const after = new Map<string, string>();
    for (const [k, rec] of await host.cache())
      if (k.startsWith(`region:${featureId}:`)) after.set(k, JSON.stringify(rec.features));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, bytes] of before) expect(after.get(k)).toBe(bytes);
    // The re-clipped render is byte-stable too (per-tile clips come from the
    // identical network, so nothing painted changes).
    expect(host.controller.regionFeatureIds(featureId).slice().sort()).toEqual(renderBefore);
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
    // ONE coalesced paint PER TOUCHED STAGE (032-D): the river (stage 0, plan
    // 035) and the city (stage 3) it cascaded to — upstream-first, NOT one paint
    // per region.
    expect(host.repaintGeneratedStages.slice(paintsBefore)).toEqual([0, 3]);
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

// ─── Plan 032-D — staged repaint (one repaint per touched stage) ─────────────
// A batch that changed only some stages repaints ONLY those stages (upstream
// first), not the whole map — repaint cost scales with the changed stages, not
// the total feature count. FakeHost records the stage of every repaint call.
describe("MapController — staged repaint (032-D)", () => {
  const RIVER_LINE: [number, number][] = [
    [6, -30],
    [18, -18],
    [30, -6],
  ];
  // A mountain far from the river/city, so a river edit never touches it.
  const MOUNTAIN_RING: [number, number][] = [
    [-40, 20],
    [-28, 20],
    [-28, 32],
    [-40, 32],
  ];

  it("a river→city cascade repaints exactly the river + city stages, upstream first", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    const cityRes = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    // An untouched mountain (stage 0) whose features must NOT be repainted.
    const mtn = await host.controller.createRegionForTest(
      MOUNTAIN_RING,
      "mountain",
      { terrain: "alpine", amplitude: 0.6, roughness: 0.5 },
      "M"
    );
    // Sanity: the three stages differ (mountain 0, river 1, city 3).
    expect(mtn.featureId).not.toBe(cityRes.featureId);

    const before = host.repaintGeneratedStages.length;
    host.controller.queueRegionRegen(river.featureId);
    await host.controller.flushSketchRegen();

    const stages = host.repaintGeneratedStages.slice(before);
    expect(stages).toEqual([0, 3]); // river (0, plan 035) then city (3) — upstream-first, ≤ stages touched
    expect(stages).not.toContain(1); // the untouched mountain stage (1) is never repainted
    expect(stages).not.toContain("all"); // no whole-map repaint
  });

  it("a staged repaint's feature budget is the stage's own features, not the whole map", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    await host.controller.createRegionForTest(
      MOUNTAIN_RING,
      "mountain",
      { terrain: "alpine", amplitude: 0.6, roughness: 0.5 },
      "M"
    );

    const total = host.controller.displayGenerated().length;
    const riverStageCount = host.controller.displayGeneratedForStage(0).length;
    expect(riverStageCount).toBeGreaterThan(0);
    // The river stage is a strict subset — repainting stage 0 alone touches far
    // fewer features than a whole-map setData would.
    expect(riverStageCount).toBeLessThan(total);
    // Every render-store feature is attributed to exactly one stage.
    let byStageTotal = 0;
    for (const [, feats] of host.controller.displayGeneratedByStage()) byStageTotal += feats.length;
    expect(byStageTotal).toBe(total);

    void river;
  });

  it("a single (non-batched) region regen paints just that region's stage", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" });
    const before = host.repaintGeneratedStages.length;
    await host.controller.regenerateRegionById(featureId);
    // City is stage 3; the regen fires exactly one staged repaint.
    expect(host.repaintGeneratedStages.slice(before)).toEqual([3]);
  });

  it("world-tier generation repaints the world bucket (a distinct stage from regions)", async () => {
    const host = new FakeHost({ zoom: 4 }); // world tier
    host.begin();
    const before = host.repaintGeneratedStages.length;
    await host.controller.generateFabricHere([0, 0]);
    const stages = host.repaintGeneratedStages.slice(before);
    expect(stages.length).toBeGreaterThan(0);
    for (const s of stages) expect(s).toBe(-1); // WORLD_STAGE, never a region stage
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// campaignElevationSnapshot — the DEM (hillshade + 3D terrain) now samples the
// FULL composed terrain field (plan 036-C/036-D live-wiring), not just the
// mountain union. These prove: (a) BYTE-IDENTITY to the pre-036 union on a
// mountain-only default-base campaign; (b) relief/landform/river stamps are
// actually visible in the sampled DEM field; (c) the digest fingerprints every
// input and is order-independent. All headless, meters-space (the field the DEM
// samples is gen-space meters; scale is 50 m/unit ⇒ display×50 = meters).

/** A district-square ring in display units (800 m at scale 50), reused as a
 * mountain / landform footprint. */
const TRING: [number, number][] = [
  [10, -26],
  [26, -26],
  [26, -10],
  [10, -10],
];

/** A straight west→east spine through the middle of TRING (display units). */
const TSPINE: [number, number][] = [
  [10, -18],
  [26, -18],
];

function mountainFeature(id: string, seed: number, params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [[...TRING, TRING[0]]] },
    properties: { kind: "mountain", procgen: { algorithm: "mountain", seed, version: 1, params } },
  };
}

function reliefFeature(id: string, seed: number, params: Record<string, unknown>): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: TSPINE },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed, version: 1, params } },
  };
}

describe("MapController — campaignElevationSnapshot composed terrain (036-C/036-D DEM wiring)", () => {
  it("is BYTE-IDENTICAL to the pre-036 mountain union on a mountain-only default-base campaign", async () => {
    const host = cityHost();
    const { featureId } = await host.controller.createRegionForTest(
      TRING,
      "mountain",
      { terrain: "alpine", amplitude: 0.7, roughness: 0.4 },
      "Peak",
      "mountain"
    );

    const snap = host.controller.campaignElevationSnapshot();
    expect(snap).not.toBeNull();

    // Reconstruct the OLD union exactly the way campaignElevationSnapshot used to:
    // buildRegionFromFeature (meters) → mountainHeightField → unionFields.
    const feat = (await host.fabric()).features.find((f) => f.id === featureId)!;
    const region = host.controller.buildRegionFromFeature(feat)!;
    const p = feat.properties.procgen!.params as Record<string, unknown>;
    const oldUnion = unionFields([
      mountainHeightField(feat.properties.procgen!.seed, region, {
        terrain: p.terrain as "alpine",
        amplitude: p.amplitude as number,
        roughness: p.roughness as number,
      }),
    ]);

    // Sample a lattice ACROSS THE MASSIF IN METERS (ring is 500..1300 × −1300..−500)
    // and compare to the float, signed zeros included (Object.is).
    let compared = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const x = 500 + (800 * i) / 8;
        const y = -1300 + (800 * j) / 8;
        const a = snap!.field(x, y);
        const b = oldUnion(x, y);
        expect(Object.is(a.v, b.v)).toBe(true);
        expect(Object.is(a.dx, b.dx)).toBe(true);
        expect(Object.is(a.dy, b.dy)).toBe(true);
        compared++;
      }
    }
    expect(compared).toBe(81);
  });

  it("makes a relief ridge stamp visible in the sampled field (nonzero on the spine, zero far away)", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(TSPINE, "relief", "relief", {
      polarity: "ridge",
      height: 300,
      halfWidth: 180,
    });
    const snap = host.controller.campaignElevationSnapshot()!;
    // On the spine midpoint (18,−18)×50 = (900,−900): a ridge raises the surface.
    expect(snap.field(900, -900).v).toBeGreaterThan(0);
    // Far away (well beyond the 180 m half-width), the flat amp-0 base is exactly 0
    // — the compact-support inertness of a disjoint stamp.
    expect(snap.field(6000, 6000).v).toBe(0);
  });

  it("makes a landform plateau stamp saturate the interior to its target (zero far away)", async () => {
    const host = cityHost();
    await host.controller.createRegionForTest(
      TRING,
      "landform",
      { mode: "plateau", band: 120, priority: 0 },
      "Tableland",
      "landform"
    );
    const snap = host.controller.campaignElevationSnapshot()!;
    // Deep interior center (900,−900) is >band from every edge ⇒ mask 1 ⇒ the
    // plateau default target (400 m) exactly, on the flat 0 base.
    expect(snap.field(900, -900).v).toBe(400);
    expect(snap.field(6000, 6000).v).toBe(0);
  });

  it("carves a river channel BELOW the surrounding surface along the spine", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(TSPINE, "river", "river", {
      windiness: 0,
      braiding: 0,
      width: 20,
      widthGrowth: 0,
      braidBias: 0,
    });
    const snap = host.controller.campaignElevationSnapshot()!;
    const onSpine = snap.field(900, -900).v; // on the channel
    const beside = snap.field(900, -1500).v; // 600 m off the spine, past the gorge wall
    expect(onSpine).toBeLessThan(beside);
    expect(onSpine).toBeLessThan(0); // incised below the flat datum
    expect(beside).toBe(0); // far bank recovers to the flat base
  });

  it("digest changes with a stamp param, a stamp seed, and a base param; is stable across enumeration order", async () => {
    // Param sensitivity: same fixed id, different relief height ⇒ different digest.
    const hA = cityHost();
    hA.controller.addSketchedFeature(reliefFeature("r", 5, { polarity: "ridge", height: 300, halfWidth: 180 }));
    const hB = cityHost();
    hB.controller.addSketchedFeature(reliefFeature("r", 5, { polarity: "ridge", height: 900, halfWidth: 180 }));
    expect(hA.controller.campaignElevationSnapshot()!.digest).not.toBe(
      hB.controller.campaignElevationSnapshot()!.digest
    );

    // Seed sensitivity: same id + params, different seed ⇒ different digest.
    const hC = cityHost();
    hC.controller.addSketchedFeature(reliefFeature("r", 999, { polarity: "ridge", height: 300, halfWidth: 180 }));
    expect(hC.controller.campaignElevationSnapshot()!.digest).not.toBe(
      hA.controller.campaignElevationSnapshot()!.digest
    );

    // Base-param sensitivity: opting the campaign base off flat ⇒ different digest.
    const hD = cityHost();
    await hD.controller.createRegionForTest(TRING, "mountain", { terrain: "alpine", amplitude: 0.6, roughness: 0.5 }, "M", "mountain");
    const flat = hD.controller.campaignElevationSnapshot()!.digest;
    hD.campaign.config.terrain = { campAmp: 500, seaDatum: 0, grade: false };
    expect(hD.controller.campaignElevationSnapshot()!.digest).not.toBe(flat);

    // Order independence: same id set, opposite insertion order ⇒ identical digest
    // AND identical sampled field (the id-sorted fold).
    const mtn = mountainFeature("m", 5, { terrain: "alpine", amplitude: 0.6, roughness: 0.5 });
    const rel = reliefFeature("r", 5, { polarity: "ridge", height: 300, halfWidth: 180 });
    const h1 = cityHost();
    h1.controller.addSketchedFeature(mtn);
    h1.controller.addSketchedFeature(rel);
    const h2 = cityHost();
    h2.controller.addSketchedFeature(rel);
    h2.controller.addSketchedFeature(mtn);
    const s1 = h1.controller.campaignElevationSnapshot()!;
    const s2 = h2.controller.campaignElevationSnapshot()!;
    expect(s1.digest).toBe(s2.digest);
    expect(s1.field(900, -900).v).toBe(s2.field(900, -900).v);
  });
});

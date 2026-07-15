/**
 * Regression guard for the Cradle campaign's GLOBAL terrain (plan 041 /
 * cradle iter-4). The bug this locks in: an earlier emit drove the sea with a
 * whole-canvas `landform` REPLACE stamp whose outer ring covered the island
 * interior — and because the landform mask reads only `coordinates[0]` (polygon
 * holes are ignored for elevation), that replace flattened every relief-ridge
 * ADD inside it. Symptom in the live controller path: `campaignElevationSnapshot`
 * returned base-fBm-only (max ≈ 107 m, then ≈ 30 m once a plateau replace floored
 * it) with the highland ridges absent from the field.
 *
 * The fix (island-from-coastline `invert: true` sea) leaves the island INTERIOR
 * free of any replace stamp so the ridge ADDs survive. This test drives the
 * EMITTED fabric through the REAL controller path (FakeHost → loadFabric →
 * campaignElevationSnapshot, exactly as MapView does) and asserts the composed
 * field actually carries the highlands, the exterior is sea, and the islet is
 * re-lifted — so a future emitter change that re-covers the island with a replace
 * stamp fails here instead of silently rendering a flat island in-app.
 */
import { describe, it, expect } from "vitest";
import { FakeHost, MemAdapter } from "../src/controller/FakeHost";
import { fabricPath } from "../src/vault/fabricStore";
import { parseCampaignConfig, type ParsedCampaign } from "../src/model/campaignConfig";
import {
  buildCradleFabric,
  N,
  CRADLE_CAMPAIGN_SEED,
  SCALE_M_PER_UNIT,
  CRADLE_BASE,
  CRADLE_BOUNDS,
  CRADLE_THEME,
} from "./emit-cradle-campaign";

/** Load the emitted Cradle fabric through the real store + controller, with the
 * campaign config built by the SAME parser the app uses (`parseCampaignConfig`),
 * then return the composed elevation snapshot. */
async function cradleSnapshot() {
  const parsed = parseCampaignConfig("Campaigns/Cradle/Cradle.map.md", "Cradle", {
    "map-campaign": true,
    crs: "fictional",
    theme: CRADLE_THEME,
    seed: CRADLE_CAMPAIGN_SEED,
    scaleMetersPerUnit: SCALE_M_PER_UNIT,
    bounds: CRADLE_BOUNDS,
    terrain: { campAmp: CRADLE_BASE.campAmp, seaDatum: CRADLE_BASE.seaDatum },
  });
  expect(parsed.ok, parsed.ok ? "" : JSON.stringify((parsed as { error: unknown }).error)).toBe(true);
  const campaign = (parsed as { campaign: ParsedCampaign }).campaign;

  const adapter = new MemAdapter();
  adapter.files.set(fabricPath(campaign), JSON.stringify(buildCradleFabric(), null, 2));

  const host = new FakeHost({ share: { adapter, campaign } });
  host.begin();
  await host.controller.loadFabric();
  const snap = host.controller.campaignElevationSnapshot();
  expect(snap).not.toBeNull();
  return snap!;
}

describe("emit-cradle-campaign — global terrain reaches the live controller field", () => {
  it("keeps every terrain stamp in the composed-field inputs (no feature-less digest)", async () => {
    const snap = await cradleSnapshot();
    const stamps = snap.inputs.features.filter((f) =>
      ["relief", "landform"].includes(f.properties.procgen?.algorithm ?? "")
    );
    // 8 relief ridges + the inverted sea + the islet plateau = 10 terrain stamps.
    expect(stamps.length).toBe(10);
    // The digest fingerprints each stamp; the pre-fix symptom was a digest with an
    // EMPTY parts list (base only). Guard that both stamp kinds are represented.
    expect(snap.digest).toContain('"algorithm":"relief"');
    expect(snap.digest).toContain('"algorithm":"landform"');
  });

  it("lifts the highland ridges above 800 m (base-fBm-only would be ~107 m)", async () => {
    const snap = await cradleSnapshot();
    // Global max over the whole island (gen-space meters; the whole ±9-unit box
    // ×500 scale = ±4500 m). A base-fBm-only field peaks ~107 m; a replace-flattened
    // island ~30 m. The ridges must clear 800 m.
    let max = -Infinity;
    const HALF = 4500;
    const STEP = 40;
    for (let i = 0; i <= STEP; i++) {
      for (let j = 0; j <= STEP; j++) {
        const x = -HALF + (2 * HALF * i) / STEP;
        const y = -HALF + (2 * HALF * j) / STEP;
        max = Math.max(max, snap.field(x, y).v);
      }
    }
    expect(max).toBeGreaterThan(800);

    // The tallest stamp (North Heights, height 900) sampled directly on its crest.
    const [cx, cy] = N([61, 29]);
    expect(snap.field(cx, cy).v).toBeGreaterThan(800);
  });

  it("holds the open sea at the datum (0 m) and re-lifts the lighthouse islet (~20 m)", async () => {
    const snap = await cradleSnapshot();
    // Deep open ocean in the far NW exterior of the island coast → replaced to the
    // sea datum (0).
    expect(snap.field(...N([2, 2])).v).toBe(0);
    expect(snap.field(4400, 4400).v).toBe(0);

    // Lighthouse Rock: a plateau folded AFTER the sea (priority 1) re-lifts the
    // islet to its ~20 m target even though it sits in the inverted sea's exterior.
    expect(snap.field(...N([7, 80.5])).v).toBeCloseTo(20, 0);
  });
});

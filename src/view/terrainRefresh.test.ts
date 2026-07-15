/**
 * Terrain-refresh chokepoint tests (the "3D lags after a landform delete" fix).
 *
 * Two layers:
 *  1. UNIT — `TerrainRefresh` fires the DEM bust + provider re-register + contour
 *     refresh IFF the composed-elevation digest moved, contours always but the DEM
 *     work only when relief is on, and `refreshNow` forces it.
 *  2. INTEGRATION — a real headless `MapController` (FakeHost) wired exactly as
 *     MapView wires it (render callbacks → `refreshIfElevationChanged`, off the
 *     controller's `campaignElevationDigest`). Proves that DELETING a landform
 *     stamp — the path that previously did NOT refresh — fires the same bust +
 *     re-register + contour refresh a param edit does, while a pure (non-terrain)
 *     city op fires none of it.
 */
import { describe, it, expect } from "vitest";
import { TerrainRefresh, type TerrainRefreshDeps } from "./terrainRefresh";
import { FakeHost } from "../controller/FakeHost";
import { algorithmById } from "../gen/procgen/registry";

/** A spying deps harness with a settable digest + terrain toggle. */
function harness(opts: { digest?: string | null; enabled?: boolean } = {}) {
  const state = { digest: opts.digest ?? null, enabled: opts.enabled ?? true };
  const calls = { register: 0, bust: 0, contours: 0 };
  const deps: TerrainRefreshDeps = {
    readDigest: () => state.digest,
    terrainEnabled: () => state.enabled,
    registerProvider: () => void calls.register++,
    bustTileCache: () => void calls.bust++,
    refreshContours: () => void calls.contours++,
  };
  return { state, calls, tracker: new TerrainRefresh(deps) };
}

describe("TerrainRefresh — digest-gated chokepoint (unit)", () => {
  it("refreshIfElevationChanged fires the full refresh only when the digest moves", () => {
    const h = harness({ digest: "d1", enabled: true });
    h.tracker.seedBaseline(); // baseline = d1, no refresh

    // Same digest (a pure city repaint) — no-op.
    h.tracker.refreshIfElevationChanged();
    expect(h.calls).toEqual({ register: 0, bust: 0, contours: 0 });

    // Digest moved (a landform was deleted) — bust + re-register + contours.
    h.state.digest = "d2";
    h.tracker.refreshIfElevationChanged();
    expect(h.calls).toEqual({ register: 1, bust: 1, contours: 1 });

    // Stable again — no further work.
    h.tracker.refreshIfElevationChanged();
    expect(h.calls).toEqual({ register: 1, bust: 1, contours: 1 });
  });

  it("seedBaseline never refreshes, even off a non-null digest", () => {
    const h = harness({ digest: "d1", enabled: true });
    h.tracker.seedBaseline();
    expect(h.calls).toEqual({ register: 0, bust: 0, contours: 0 });
  });

  it("with terrain OFF, a digest move refreshes contours but not the DEM", () => {
    const h = harness({ digest: "d1", enabled: false });
    h.tracker.seedBaseline();
    h.state.digest = "d2";
    h.tracker.refreshIfElevationChanged();
    // Contours render regardless of the 3D toggle; DEM provider/bust do not.
    expect(h.calls).toEqual({ register: 0, bust: 0, contours: 1 });
  });

  it("refreshNow always refreshes and re-baselines (the explicit param/base-edit path)", () => {
    const h = harness({ digest: "d1", enabled: true });
    h.tracker.seedBaseline();
    h.tracker.refreshNow(); // forced even though digest is unchanged
    expect(h.calls).toEqual({ register: 1, bust: 1, contours: 1 });
    // Re-baselined to the current digest ⇒ a following chokepoint on the SAME
    // digest does not double-fire.
    h.tracker.refreshIfElevationChanged();
    expect(h.calls).toEqual({ register: 1, bust: 1, contours: 1 });
  });

  it("a null→value digest transition (fresh campaign) counts as a move", () => {
    const h = harness({ digest: null, enabled: true });
    h.tracker.seedBaseline(); // baseline null
    h.state.digest = "d1";
    h.tracker.refreshIfElevationChanged();
    expect(h.calls).toEqual({ register: 1, bust: 1, contours: 1 });
  });
});

/** A landform ring (display units) and a disjoint district ring for the city op. */
const LANDFORM_RING: [number, number][] = [
  [10, -26],
  [26, -26],
  [26, -10],
  [10, -10],
];
const CITY_RING: [number, number][] = [
  [-40, 8],
  [-24, 8],
  [-24, 24],
  [-40, 24],
];

/** Wire a FakeHost's controller to a TerrainRefresh exactly as MapView does:
 * both repaint callbacks drive `refreshIfElevationChanged` off the controller's
 * live `campaignElevationDigest`. `terrainEnabled` simulates the 3D toggle. */
function wireTerrain(host: FakeHost, enabled = true) {
  const calls = { register: 0, bust: 0, contours: 0 };
  const tracker = new TerrainRefresh({
    readDigest: () => host.controller.campaignElevationDigest(),
    terrainEnabled: () => enabled,
    registerProvider: () => void calls.register++,
    bustTileCache: () => void calls.bust++,
    refreshContours: () => void calls.contours++,
  });
  host.onAnyRepaint = () => tracker.refreshIfElevationChanged();
  tracker.seedBaseline();
  return { calls, tracker };
}

describe("TerrainRefresh — controller integration (FakeHost twin)", () => {
  it("DELETING a landform fires the DEM bust + provider re-register + contour refresh", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const w = wireTerrain(host, /* terrainEnabled */ true);

    // Create the landform stamp — a terrain-affecting change moves the digest.
    const params = algorithmById("landform")!.defaultParams("obsidian-native");
    const { featureId } = await host.controller.createRegionForTest(
      LANDFORM_RING,
      "landform",
      params,
      "Plateau",
      "landform"
    );
    expect(w.calls.bust).toBeGreaterThanOrEqual(1);
    expect(w.calls.register).toBeGreaterThanOrEqual(1);
    expect(w.calls.contours).toBeGreaterThanOrEqual(1);

    // The bug: deleting the landform previously did NOT refresh the DEM, so the
    // retained 3D tiles stayed stale. Now it converges through the chokepoint.
    const before = { ...w.calls };
    host.controller.deleteFabricFeature(featureId);
    await Promise.resolve(); // let any trailing async repaint settle
    expect(w.calls.bust).toBeGreaterThan(before.bust);
    expect(w.calls.register).toBeGreaterThan(before.register);
    expect(w.calls.contours).toBeGreaterThan(before.contours);
  });

  it("a param edit on a landform still refreshes the DEM (regression guard)", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const w = wireTerrain(host, true);
    const { featureId } = await host.controller.createRegionForTest(
      LANDFORM_RING,
      "landform",
      algorithmById("landform")!.defaultParams("obsidian-native"),
      "Plateau",
      "landform"
    );

    const before = { ...w.calls };
    // Switch the landform to a different preset ⇒ new params ⇒ moved field.
    const other = algorithmById("landform")!.presets.find((p) => p.id !== "plateau")!;
    await host.controller.setRegionPreset(featureId, other.id);
    expect(w.calls.bust).toBeGreaterThan(before.bust);
    expect(w.calls.contours).toBeGreaterThan(before.contours);
  });

  it("a pure (non-terrain) city op fires NO DEM/contour refresh", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const w = wireTerrain(host, true);

    await host.controller.createRegionForTest(CITY_RING, "city", { profile: "euro-medieval" }, "Old Town");
    // A city carries no elevation contribution (grading off) ⇒ the digest never
    // moves ⇒ the chokepoint stays a no-op despite many repaints.
    expect(w.calls).toEqual({ register: 0, bust: 0, contours: 0 });
  });

  it("with terrain OFF, a landform delete still refreshes contours but not the DEM", async () => {
    const host = new FakeHost({ zoom: 10 });
    host.begin();
    const w = wireTerrain(host, /* terrainEnabled */ false);
    const { featureId } = await host.controller.createRegionForTest(
      LANDFORM_RING,
      "landform",
      algorithmById("landform")!.defaultParams("obsidian-native"),
      "Plateau",
      "landform"
    );
    const before = { ...w.calls };
    host.controller.deleteFabricFeature(featureId);
    await Promise.resolve();
    expect(w.calls.contours).toBeGreaterThan(before.contours);
    expect(w.calls.bust).toBe(before.bust); // DEM untouched while relief is off
    expect(w.calls.register).toBe(before.register);
  });
});

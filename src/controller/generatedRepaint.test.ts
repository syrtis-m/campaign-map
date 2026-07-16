/**
 * Regression: a vertex edit must REPAINT the generated fabric (moved-vertex bug,
 * 2026-07-15). A generated feature spanning a tile boundary is clipped into
 * every covered tile under the SAME (position-hashed) feature id, so the
 * flattened `generated` collection carried DUPLICATE ids. MapLibre's staged
 * `updateData` (032-D) requires globally-unique ids (`isUpdateableGeoJSON`); a
 * single duplicate makes the whole source non-updateable, and a later staged
 * `updateData` silently no-ops in the worker — the regenerated store never
 * reached the map (the sketch spine repainted via a full `setData`, so the GM
 * saw the new vertices but the OLD ribbon).
 *
 * Two guards:
 *  1. Controller — `displayGenerated*` render ids are globally unique + non-null
 *     (the `isUpdateableGeoJSON` precondition), at create AND after a vertex edit
 *     through the real host debounced path, for a river (line) AND a city
 *     (polygon), in both flush/reload interleave orders.
 *  2. End-to-end — a faithful twin of MapLibre's GeoJSONSource
 *     (`isUpdateableGeoJSON` + `applySourceDiff` + the silent no-op on a
 *     non-updateable source) driven exactly as MapView drives it: a vertex edit
 *     lands NEW geometry in the source.
 */
import { describe, it, expect } from "vitest";
import { FakeHost } from "./FakeHost";
import type { FabricGeometry } from "../model/fabric";

const RING: [number, number][] = [
  [10, -26],
  [26, -26],
  [26, -10],
  [10, -10],
];
const RIVER_LINE: [number, number][] = [
  [6, -30],
  [16, -20],
  [24, -12],
];

function cityHost(): FakeHost {
  const host = new FakeHost({ zoom: 10 });
  host.begin();
  return host;
}

/** MapLibre's `isUpdateableGeoJSON` precondition: every feature id non-null and
 * globally unique across the source collection. */
function assertUpdateable(feats: GeoJSON.Feature[], label: string): void {
  const seen = new Set<string | number>();
  const dup: (string | number)[] = [];
  let nullIds = 0;
  for (const f of feats) {
    if (f.id === undefined || f.id === null) {
      nullIds++;
      continue;
    }
    if (seen.has(f.id)) dup.push(f.id);
    seen.add(f.id);
  }
  expect(`${label}: nullIds=${nullIds} dups=${dup.length}`).toBe(`${label}: nullIds=0 dups=0`);
}

/** Render-id-prefixed painted geometry of a region (namespaced id is
 * `region:<regionId>:<x>:<y>#<featureId>`). */
function regionPaintedGeom(feats: GeoJSON.Feature[], regionId: string): string {
  return feats
    .filter((f) => String(f.id).startsWith(`region:${regionId}:`))
    .map((f) => JSON.stringify(f.geometry))
    .sort()
    .join("|");
}

/** Faithful twin of a MapLibre v4.7.1 GeoJSONSource's updateability semantics:
 * `setData` rebuilds an id→feature map ONLY when the collection is updateable;
 * otherwise the map is dropped and a later `updateData` silently retains the
 * old data (the worker throws + the error is swallowed — visible as a no-op). */
class FakeGeoJSONSource {
  data: GeoJSON.Feature[] = [];
  private byId: Map<string | number, GeoJSON.Feature> | undefined;
  updateData = (diff: { remove?: (string | number)[]; add?: GeoJSON.Feature[] }): void => {
    if (!this.byId) return; // non-updateable ⇒ silent no-op (stale paint)
    for (const id of diff.remove ?? []) this.byId.delete(id);
    for (const f of diff.add ?? []) if (f.id != null) this.byId.set(f.id, f);
    this.data = [...this.byId.values()];
  };
  setData(fc: { type?: string; features: GeoJSON.Feature[] }): void {
    this.data = fc.features;
    const seen = new Map<string | number, GeoJSON.Feature>();
    let ok = true;
    for (const f of fc.features) {
      if (f.id == null || seen.has(f.id)) {
        ok = false;
        break;
      }
      seen.set(f.id, f);
    }
    this.byId = ok ? seen : undefined;
  }
}

/** A faithful twin of MapView.refreshGeneratedSource + paintGeneratedFull that
 * drains the controller's recorded per-stage repaint signals into a
 * FakeGeoJSONSource, so the test exercises the exact staged-vs-full choice the
 * app makes. */
function makeGeneratedPainter(host: FakeHost, source: FakeGeoJSONSource) {
  const paintedStageIds = new Map<number, Set<string | number>>();
  let updateable = true;
  let drained = 0;

  const full = (): void => {
    const features = host.controller.displayGenerated();
    source.setData({ type: "FeatureCollection", features });
    const seen = new Set<string | number>();
    let ok = true;
    for (const f of features) {
      if (f.id == null || seen.has(f.id)) {
        ok = false;
        break;
      }
      seen.add(f.id);
    }
    updateable = ok;
    paintedStageIds.clear();
    for (const [s, feats] of host.controller.displayGeneratedByStage()) {
      paintedStageIds.set(s, new Set(feats.map((f) => f.id as string | number)));
    }
  };

  const refresh = (stage: number | "all"): void => {
    if (stage === "all") return full();
    if (!updateable) return full(); // MapView fallback
    const feats = host.controller.displayGeneratedForStage(stage);
    const oldIds = paintedStageIds.get(stage) ?? new Set<string | number>();
    source.updateData({ remove: [...oldIds], add: feats });
    paintedStageIds.set(stage, new Set(feats.map((f) => f.id as string | number)));
  };

  return {
    /** Initial authoritative paint (MapView's load/styledata path). */
    paintInitial: full,
    /** Replay every repaint signal recorded since the last drain. */
    drain: (): void => {
      for (; drained < host.repaintGeneratedStages.length; drained++) {
        refresh(host.repaintGeneratedStages[drained]);
      }
    },
    get sourceUpdateable() {
      return updateable;
    },
  };
}

describe("generated-source updateability (moved-vertex repaint guard)", () => {
  it("river: render ids stay unique through a vertex edit (both interleave orders)", async () => {
    for (const order of ["flush-then-reload", "reload-then-flush"] as const) {
      const host = cityHost();
      const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
      assertUpdateable(host.controller.displayGenerated(), `river/${order}/create`);

      const finalGeom: FabricGeometry = {
        type: "LineString",
        coordinates: [
          [6, -30],
          [18, -18],
          [24, -11],
        ],
      };
      await host.controller.commitGeometryEdit(river.featureId, finalGeom, { debounce: true });
      if (order === "flush-then-reload") {
        await host.controller.flushSketchRegen();
        await host.controller.reloadFabricFromDisk();
      } else {
        await host.controller.reloadFabricFromDisk();
        await host.controller.flushSketchRegen();
      }
      assertUpdateable(host.controller.displayGenerated(), `river/${order}/edited`);
    }
  });

  it("city polygon: render ids stay unique through a vertex edit (both interleave orders)", async () => {
    for (const order of ["flush-then-reload", "reload-then-flush"] as const) {
      const host = cityHost();
      const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
      assertUpdateable(host.controller.displayGenerated(), `city/${order}/create`);

      const newRing: FabricGeometry = {
        type: "Polygon",
        coordinates: [
          [
            [10, -26],
            [30, -26],
            [30, -10],
            [10, -10],
            [10, -26],
          ],
        ],
      };
      await host.controller.commitGeometryEdit(city.featureId, newRing, { debounce: true });
      if (order === "flush-then-reload") {
        await host.controller.flushSketchRegen();
        await host.controller.reloadFabricFromDisk();
      } else {
        await host.controller.reloadFabricFromDisk();
        await host.controller.flushSketchRegen();
      }
      assertUpdateable(host.controller.displayGenerated(), `city/${order}/edited`);
    }
  });

  it("per-stage render ids are unique (staged updateData add-set never collides)", async () => {
    const host = cityHost();
    await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");
    await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");
    for (const [stage, feats] of host.controller.displayGeneratedByStage()) {
      assertUpdateable(feats, `stage-${stage}`);
    }
  });

  it("END-TO-END: a river vertex edit lands NEW geometry in a MapLibre-faithful source", async () => {
    const host = cityHost();
    const river = await host.controller.createSpineForTest(RIVER_LINE, "river", "river", { windiness: 0.5 }, "R");

    const source = new FakeGeoJSONSource();
    const painter = makeGeneratedPainter(host, source);
    // Mirror the app load: an authoritative full paint seeds the source from the
    // real (tile-clipped) collection BEFORE any staged edit — the exact path
    // that used to strand the source in a non-updateable state.
    painter.paintInitial();
    expect(painter.sourceUpdateable).toBe(true); // the fix: no duplicate ids
    const before = regionPaintedGeom(source.data, river.featureId);
    expect(before).not.toBe(""); // the river is painted

    const finalGeom: FabricGeometry = {
      type: "LineString",
      coordinates: [
        [6, -30],
        [18, -18],
        [24, -11],
      ],
    };
    await host.controller.commitGeometryEdit(river.featureId, finalGeom, { debounce: true });
    await host.controller.flushSketchRegen();
    await host.controller.reloadFabricFromDisk();
    painter.drain(); // replay the staged repaint signals through the source

    const after = regionPaintedGeom(source.data, river.featureId);
    expect(after).not.toBe(before); // the moved vertex actually repainted
  });

  it("END-TO-END: a city vertex edit lands NEW geometry in a MapLibre-faithful source", async () => {
    const host = cityHost();
    const city = await host.controller.createRegionForTest(RING, "city", { profile: "euro-medieval" }, "C");

    const source = new FakeGeoJSONSource();
    const painter = makeGeneratedPainter(host, source);
    painter.paintInitial();
    expect(painter.sourceUpdateable).toBe(true);
    const before = regionPaintedGeom(source.data, city.featureId);
    expect(before).not.toBe("");

    const newRing: FabricGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [10, -26],
          [30, -26],
          [30, -10],
          [10, -10],
          [10, -26],
        ],
      ],
    };
    await host.controller.commitGeometryEdit(city.featureId, newRing, { debounce: true });
    await host.controller.flushSketchRegen();
    await host.controller.reloadFabricFromDisk();
    painter.drain();

    const after = regionPaintedGeom(source.data, city.featureId);
    expect(after).not.toBe(before);
  });
});

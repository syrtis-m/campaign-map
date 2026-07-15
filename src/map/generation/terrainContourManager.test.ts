import { describe, it, expect } from "vitest";
import { TerrainContourManager } from "./terrainContourManager";
import type { SerializableTerrainInputs } from "../../gen/worker/generationWorker";
import type { FabricFeature } from "../../model/fabric";

/**
 * The viewport-keyed contour manager: on `update()` it fills the touched
 * world-aligned tiles from the composed terrain field (worker or main-thread
 * fallback), converts them to DISPLAY units, and setData's the source. These
 * tests drive it with a fake map + no worker (fallback path), asserting the
 * ruling (relief lines render off the global field), the meter→display
 * conversion, laziness/LRU, and the flat-campaign empty case.
 */

type Pt = [number, number];

function relief(id: string, spine: Pt[]): FabricFeature {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: spine },
    properties: { kind: "relief", procgen: { algorithm: "relief", seed: 1, version: 1, params: { polarity: "ridge", height: 400, halfWidth: 150 } } },
  } as FabricFeature;
}

function inputsFor(features: FabricFeature[]): SerializableTerrainInputs {
  return { features, base: { campAmp: 0, seaDatum: 0 }, campaignSeed: 7, include: { relief: true, landform: true, carve: true, grade: false } };
}

/** A fake MapLibre map with fixed bounds + a capturing GeoJSON source. */
function fakeMap(bounds: { west: number; east: number; south: number; north: number }) {
  let lastData: GeoJSON.FeatureCollection | null = null;
  const source = {
    setData: (d: GeoJSON.FeatureCollection): void => {
      lastData = d;
    },
  };
  const map = {
    getBounds: () => ({
      getWest: () => bounds.west,
      getEast: () => bounds.east,
      getSouth: () => bounds.south,
      getNorth: () => bounds.north,
    }),
    getSource: () => source,
  };
  return { map, get last() { return lastData; } };
}

const SCALE = 1; // meters == display units, so conversion is the identity here

function manager(features: FabricFeature[], mapLike: ReturnType<typeof fakeMap>): TerrainContourManager {
  return new TerrainContourManager({
    sourceId: "terrain-contour",
    scaleMetersPerUnit: SCALE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMap: () => mapLike.map as any,
    getSnapshot: () => ({ digest: `d:${features.map((f) => f.id).join(",")}`, inputs: inputsFor(features) }),
    getWorker: () => Promise.resolve(null), // fallback: synchronous trace
  });
}

describe("TerrainContourManager — global relief off the composed field", () => {
  it("fills terrain-contour features over a relief ridge (no mountain polygon)", async () => {
    const view = fakeMap({ west: 0, east: 400, south: 0, north: 400 });
    const mgr = manager([relief("r", [[40, 200], [360, 200]])], view);
    await mgr.update();
    const data = view.last!;
    expect(data).not.toBeNull();
    expect(data.features.length).toBeGreaterThan(0);
    for (const f of data.features) {
      expect((f.properties as { generatorId?: string }).generatorId).toBe("terrain-contour");
      expect(f.geometry.type).toBe("LineString");
    }
    expect(mgr.computedLeaves).toBeGreaterThan(0);
  });

  it("a flat campaign yields an empty contour source", async () => {
    const view = fakeMap({ west: 0, east: 400, south: 0, north: 400 });
    const mgr = manager([], view);
    await mgr.update();
    expect(view.last!.features).toEqual([]);
  });

  it("re-touching the same viewport reuses cached leaves (laziness)", async () => {
    const view = fakeMap({ west: 0, east: 400, south: 0, north: 400 });
    const mgr = manager([relief("r", [[40, 200], [360, 200]])], view);
    await mgr.update();
    const afterFirst = mgr.computedLeaves;
    expect(afterFirst).toBeGreaterThan(0);
    await mgr.update(); // same digest + LOD → every tile a cache hit
    expect(mgr.computedLeaves).toBe(afterFirst);
  });

  it("emits coordinates in DISPLAY units (meters ÷ scale)", async () => {
    // Two managers over the IDENTICAL meter viewport [0,400] (so they tile the
    // field identically) but different scales: scale 1's display bounds are
    // [0,400], scale 2's are [0,200]. Both trace the same meter contours; the
    // scale-2 display coords must be exactly HALF the scale-1 ones.
    const feat = relief("r", [[40, 200], [360, 200]]);
    const view1 = fakeMap({ west: 0, east: 400, south: 0, north: 400 });
    const mgr1 = new TerrainContourManager({
      sourceId: "terrain-contour",
      scaleMetersPerUnit: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMap: () => view1.map as any,
      getSnapshot: () => ({ digest: "d", inputs: inputsFor([feat]) }),
      getWorker: () => Promise.resolve(null),
    });
    const view2 = fakeMap({ west: 0, east: 200, south: 0, north: 200 });
    const mgr2 = new TerrainContourManager({
      sourceId: "terrain-contour",
      scaleMetersPerUnit: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMap: () => view2.map as any,
      getSnapshot: () => ({ digest: "d", inputs: inputsFor([feat]) }),
      getWorker: () => Promise.resolve(null),
    });
    await mgr1.update();
    await mgr2.update();
    const byId = (d: GeoJSON.FeatureCollection): Map<string, Pt[]> => {
      const m = new Map<string, Pt[]>();
      for (const f of d.features) m.set(String(f.id), (f.geometry as GeoJSON.LineString).coordinates as Pt[]);
      return m;
    };
    const a = byId(view1.last!);
    const b = byId(view2.last!);
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBe(a.size); // same meter field ⇒ same feature ids
    for (const [id, coordsA] of a) {
      const coordsB = b.get(id)!;
      expect(coordsB.length).toBe(coordsA.length);
      for (let i = 0; i < coordsA.length; i++) {
        expect(coordsB[i][0] * 2).toBeCloseTo(coordsA[i][0], 6); // scale-2 display = meters/2
        expect(coordsB[i][1] * 2).toBeCloseTo(coordsA[i][1], 6);
      }
    }
  });
});

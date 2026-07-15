/**
 * Headless SketchController state-machine tests (plan 040 Phase 0).
 *
 * SketchController needs a MapLibre map + DOM, neither of which exists in the
 * node test tier — so this drives the REAL controller against a hand-rolled
 * mock map that records the handful of map APIs the controller touches
 * (`on`/`off`, source/layer add/remove, `queryRenderedFeatures`, `project`,
 * `dragPan`, canvas cursor). Pointer sequences are simulated by firing the
 * controller's own registered handlers (`map.fire`), the same way MapView's
 * live listeners would. Modals/real drags hang the CLI; this is their twin.
 *
 * The click-out contract (Jonah 2026-07-15 — "editing a shape and click out
 * just deletes the shape"): a finishable draft left implicitly (Select tool /
 * kind switch / ✕ done) is COMMITTED, never silently discarded; a deselect of a
 * persisted shape never mutates it.
 */
import { describe, it, expect } from "vitest";
import { SketchController, type SketchControllerHandlers } from "./SketchController";
import type { FabricGeometry, FabricKind } from "../model/fabric";

/** Minimal MapLibre stand-in — only the surface SketchController calls. */
function mockMap() {
  const handlers: Record<string, Function[]> = {};
  const sources: Record<string, { setData(d: unknown): void; _data: unknown }> = {};
  const layers: Record<string, unknown> = {};
  const canvas = { style: { cursor: "" } };
  let queryReturn: unknown[] = [];
  const map = {
    on: (t: string, h: Function) => void (handlers[t] ??= []).push(h),
    off: (t: string, h: Function) => void (handlers[t] = (handlers[t] ?? []).filter((x) => x !== h)),
    getSource: (id: string) => sources[id],
    addSource: (id: string, spec: { data: unknown }) => {
      sources[id] = { _data: spec.data, setData(d: unknown) { this._data = d; } };
    },
    getLayer: (id: string) => layers[id],
    addLayer: (spec: { id: string }) => void (layers[spec.id] = spec),
    removeLayer: (id: string) => void delete layers[id],
    removeSource: (id: string) => void delete sources[id],
    getCanvas: () => canvas,
    project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: -lat * 10 }),
    unproject: (p: { x: number; y: number }) => ({ lng: p.x / 10, lat: -p.y / 10 }),
    queryRenderedFeatures: () => queryReturn,
    dragPan: { enable() {}, disable() {} },
    fire: (t: string, e: unknown) => (handlers[t] ?? []).forEach((h) => h(e)),
    setQuery: (r: unknown[]) => void (queryReturn = r),
    draftFeatures: () => (sources["fabric-draft"]?._data as { features: unknown[] })?.features ?? [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return map as any;
}

function ev(lng: number, lat: number) {
  return { point: { x: lng * 10, y: -lat * 10 }, lngLat: { lng, lat }, preventDefault() {} };
}

const POLY: FabricGeometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
};

function makeController(over: Partial<SketchControllerHandlers> = {}) {
  const map = mockMap();
  const edits: { id: string; geometry: FabricGeometry }[] = [];
  const drafts: { geometry: FabricGeometry; kind: FabricKind }[] = [];
  const handlers: SketchControllerHandlers = {
    onGeometryEdit: (id, geometry) => edits.push({ id, geometry }),
    onDraftCommit: (geometry, kind) => drafts.push({ geometry, kind }),
    ...over,
  };
  const c = new SketchController(map, "#ff0000", handlers);
  return { map, c, edits, drafts };
}

describe("SketchController — click-out contract (plan 040 Phase 0)", () => {
  it("deselecting a persisted shape (click empty) never mutates it", () => {
    const { c, edits, drafts } = makeController();
    c.activate("landform");
    c.setTool("select");
    c.select({ id: "L1", geometry: POLY, kind: "landform", center: null });
    expect(c.editingFeatureId).toBe("L1");
    c.clearSelection(); // MapView.deselectFabric → clearSelection on click-empty
    expect(c.editingFeatureId).toBeNull();
    expect(edits).toHaveLength(0); // no whole-feature commit → geometry untouched
    expect(drafts).toHaveLength(0); // deselect is not a draft commit
  });

  it("finishable draft COMMITS (not discards) when switching to the Select tool", () => {
    const { c, drafts } = makeController();
    c.activate("landform"); // polygon, min 3
    c.addVertex([0, 0]);
    c.addVertex([4, 0]);
    c.addVertex([4, 4]);
    expect(c.isFinishableDraft).toBe(true);
    c.setTool("select"); // the "click out to edit" gesture
    expect(c.isDrawing).toBe(false);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("landform");
    expect(drafts[0].geometry.type).toBe("Polygon");
    // ring closed (first === last)
    const ring = (drafts[0].geometry as { coordinates: [number, number][][] }).coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("too-short draft is still DISCARDED on tool switch (no phantom shape)", () => {
    const { c, drafts } = makeController();
    c.activate("landform"); // polygon needs 3
    c.addVertex([0, 0]);
    c.addVertex([4, 0]); // only 2
    expect(c.isFinishableDraft).toBe(false);
    c.setTool("select");
    expect(c.isDrawing).toBe(false);
    expect(drafts).toHaveLength(0);
  });

  it("switching kind mid-draw commits the old-kind draft, then draws the new kind", () => {
    const { c, drafts } = makeController();
    c.activate("road"); // line, min 2
    c.addVertex([0, 0]);
    c.addVertex([4, 0]);
    c.setKind("river");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe("road"); // committed under the kind it was drawn as
    expect(drafts[0].geometry.type).toBe("LineString");
    expect(c.currentKind).toBe("river");
    expect(c.isDrawing).toBe(false);
  });

  it("commitDraftIfAny (the ✕ done / exit path) commits a finishable draft", () => {
    const { c, drafts } = makeController();
    c.activate("road");
    c.addVertex([0, 0]);
    c.addVertex([4, 0]);
    c.commitDraftIfAny();
    expect(drafts).toHaveLength(1);
    expect(c.isDrawing).toBe(false);
  });

  it("commitDraftIfAny is a no-op when not drawing", () => {
    const { c, drafts } = makeController();
    c.activate("road");
    c.commitDraftIfAny();
    expect(drafts).toHaveLength(0);
  });

  it("Esc-style cancel() stays a deliberate discard (no commit)", () => {
    const { c, drafts } = makeController();
    c.activate("road");
    c.addVertex([0, 0]);
    c.addVertex([4, 0]);
    c.cancel(); // MapView Escape → cancel()
    expect(c.isDrawing).toBe(false);
    expect(drafts).toHaveLength(0);
  });
});

describe("SketchController — vertex drag still commits once (regression)", () => {
  it("grab a vertex, drag, release → one onGeometryEdit, click consumed", () => {
    const { map, c, edits } = makeController();
    c.activate("landform");
    c.setTool("select");
    c.select({ id: "L1", geometry: POLY, kind: "landform", center: null });
    // vertex 0 is at project([0,0]) = {x:0,y:0}; the handle hit-test reads it back
    map.setQuery([{ properties: { handle: "vertex", index: 0 }, geometry: { type: "Point", coordinates: [0, 0] } }]);
    map.fire("mousedown", ev(0, 0));
    map.fire("mousemove", ev(1, 1));
    map.fire("mouseup", ev(1, 1));
    expect(edits).toHaveLength(1);
    expect(c.consumeInteraction()).toBe(true); // trailing click is eaten, not a deselect
  });
});

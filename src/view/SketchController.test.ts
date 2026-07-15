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
    unproject: (p: { x: number; y: number } | [number, number]) =>
      Array.isArray(p) ? { lng: p[0] / 10, lat: -p[1] / 10 } : { lng: p.x / 10, lat: -p.y / 10 },
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
  return { point: { x: lng * 10, y: -lat * 10 }, lngLat: { lng, lat }, preventDefault() {}, originalEvent: { shiftKey: false } };
}

/** Event at explicit screen pixels (height drag is screen-Y driven). */
function pxEv(x: number, y: number, shiftKey = false) {
  return { point: { x, y }, lngLat: { lng: x / 10, lat: -y / 10 }, preventDefault() {}, originalEvent: { shiftKey } };
}

const POLY: FabricGeometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
};

function makeController(over: Partial<SketchControllerHandlers> = {}) {
  const map = mockMap();
  const edits: { id: string; geometry: FabricGeometry }[] = [];
  const drafts: { geometry: FabricGeometry; kind: FabricKind }[] = [];
  const heightDrags: { id: string; value: number }[] = [];
  const heightCommits: { id: string; value: number }[] = [];
  const handlers: SketchControllerHandlers = {
    onGeometryEdit: (id, geometry) => edits.push({ id, geometry }),
    onDraftCommit: (geometry, kind) => drafts.push({ geometry, kind }),
    onHeightDrag: (id, value) => heightDrags.push({ id, value }),
    onHeightCommit: (id, value) => heightCommits.push({ id, value }),
    ...over,
  };
  const c = new SketchController(map, "#ff0000", handlers);
  return { map, c, edits, drafts, heightDrags, heightCommits };
}

const RELIEF_LINE: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [4, 0]] };
/** The height grip for value 300 on RELIEF_LINE: centroid [2,0]→screen (20,0),
 * idle offset 300/12≈25px up → grip screen (20,-25) → lngLat [2,2.5]. */
const GRIP_COORD: [number, number] = [2, 2.5];
function selectReliefWithHeight(c: SketchController, value = 300) {
  c.setTool("select");
  c.select({ id: "R1", geometry: RELIEF_LINE, kind: "relief", center: null, height: { value, min: -4000, max: 4000 } });
}
function armGripQuery(map: ReturnType<typeof mockMap>) {
  map.setQuery([{ properties: { handle: "height", index: 0 }, geometry: { type: "Point", coordinates: GRIP_COORD } }]);
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

describe("SketchController — drag-to-extrude height handle (plan 040 Phase 1)", () => {
  it("renders a height grip + ghost stem for a selected relief", () => {
    const { map, c } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    const feats = map.draftFeatures() as { properties: { handle?: string } }[];
    expect(feats.some((f) => f.properties.handle === "height")).toBe(true);
    expect(feats.some((f) => f.properties.handle === "height-stem")).toBe(true);
  });

  it("dragging the grip up raises the value and commits once on release", () => {
    const { map, c, heightDrags, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    armGripQuery(map);
    map.fire("mousedown", pxEv(20, -25)); // grab the grip at its screen pos
    map.fire("mousemove", pxEv(20, -145)); // 120 px up → +1440 m at coarse mpp
    expect(heightDrags.at(-1)?.value).toBe(1740);
    expect(c.heightHandleValue).toBe(1740);
    map.fire("mouseup", pxEv(20, -145));
    expect(heightCommits).toEqual([{ id: "R1", value: 1740 }]);
  });

  it("Shift drags fine (smaller metres/pixel)", () => {
    const { map, c, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    armGripQuery(map);
    map.fire("mousedown", pxEv(20, -25));
    map.fire("mousemove", pxEv(20, -145, true)); // shift → mpp 3 → +360
    map.fire("mouseup", pxEv(20, -145, true));
    expect(heightCommits).toEqual([{ id: "R1", value: 660 }]);
  });

  it("a sub-deadzone grab (no real drag) does NOT commit and snaps back", () => {
    const { map, c, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    armGripQuery(map);
    map.fire("mousedown", pxEv(20, -25));
    map.fire("mouseup", pxEv(20, -25)); // released without moving
    expect(heightCommits).toHaveLength(0);
    expect(c.heightHandleValue).toBe(300);
  });

  it("setHeightValue clamps and does not commit (type-to-refine seam)", () => {
    const { c, heightCommits } = makeController();
    c.activate("landform");
    c.setTool("select");
    c.select({
      id: "L9",
      geometry: POLY,
      kind: "landform",
      center: null,
      height: { value: 0, min: -4000, max: 4000 },
    });
    c.setHeightValue(99999);
    expect(c.heightHandleValue).toBe(4000);
    expect(heightCommits).toHaveLength(0);
  });

  it("no height handle for a shape selected without a height descriptor", () => {
    const { map, c } = makeController();
    c.activate("district");
    c.setTool("select");
    c.select({ id: "D1", geometry: POLY, kind: "district", center: null });
    const feats = map.draftFeatures() as { properties: { handle?: string } }[];
    expect(feats.some((f) => f.properties.handle === "height")).toBe(false);
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

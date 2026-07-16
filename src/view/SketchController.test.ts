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

/** A DOM-element stand-in — the extrude grip/stem overlay is created via the
 * canvas container's `ownerDocument`; in the node tier there is no real DOM, so
 * the controller drives this recorder instead. `fire` replays a pointer event
 * through the listeners the controller registered (the headless twin of a real
 * pointerdown/move/up on the grip). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockEl(): any {
  const listeners: Record<string, Function[]> = {};
  return {
    className: "",
    style: {} as Record<string, string>,
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener: (t: string, h: Function) => void (listeners[t] ??= []).push(h),
    removeEventListener: (t: string, h: Function) =>
      void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== h)),
    appendChild() {},
    remove() {},
    fire: (t: string, e: unknown) => (listeners[t] ?? []).slice().forEach((h) => h(e)),
  };
}

/** Minimal MapLibre stand-in — only the surface SketchController calls. */
function mockMap() {
  const handlers: Record<string, Function[]> = {};
  const sources: Record<string, { setData(d: unknown): void; _data: unknown }> = {};
  const layers: Record<string, unknown> = {};
  const canvas = { style: { cursor: "" } };
  const canvasContainer = mockEl();
  canvasContainer.ownerDocument = { createElement: () => mockEl() };
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
    getCanvasContainer: () => canvasContainer,
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

/** A pointer event on the grip element — client-Y + shift drive the vertical
 * height/depth grips; client-X is 0 by default (a band grip on a horizontal
 * spine has a vertical screen normal, so only client-Y moves it). The value
 * math reads deltas, so the map-canvas offset cancels. */
function ptr(clientY: number, shiftKey = false, pointerId = 1, clientX = 0) {
  return { clientX, clientY, shiftKey, pointerId, stopPropagation() {}, preventDefault() {} };
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
  const depthDrags: { id: string; index: number; value: number }[] = [];
  const depthCommits: { id: string; values: number[] }[] = [];
  const bandDrags: { id: string; param: string; value: number }[] = [];
  const bandCommits: { id: string; params: Record<string, unknown> }[] = [];
  const handlers: SketchControllerHandlers = {
    onGeometryEdit: (id, geometry) => edits.push({ id, geometry }),
    onDraftCommit: (geometry, kind) => drafts.push({ geometry, kind }),
    onHeightDrag: (id, value) => heightDrags.push({ id, value }),
    onHeightCommit: (id, value) => heightCommits.push({ id, value }),
    onDepthDrag: (id, index, value) => depthDrags.push({ id, index, value }),
    onDepthCommit: (id, values) => depthCommits.push({ id, values }),
    onBandDrag: (id, param, value) => bandDrags.push({ id, param, value }),
    onBandCommit: (id, params) => bandCommits.push({ id, params }),
    ...over,
  };
  const c = new SketchController(map, "#ff0000", handlers);
  return { map, c, edits, drafts, heightDrags, heightCommits, depthDrags, depthCommits, bandDrags, bandCommits };
}

const RELIEF_LINE: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [4, 0]] };
function selectReliefWithHeight(c: SketchController, value = 300) {
  c.setTool("select");
  c.select({ id: "R1", geometry: RELIEF_LINE, kind: "relief", center: null, height: { value, min: -4000, max: 4000 } });
}

describe("SketchController — hover hit-test is gated (Cradle: 'slow to click around')", () => {
  it("a mousemove FAR from the selected shape runs NO queryRenderedFeatures; a near one does", () => {
    const { c, map } = makeController();
    c.activate("landform");
    c.setTool("select");
    c.select({ id: "L1", geometry: POLY, kind: "landform", center: null }); // verts project to screen x[0..40], y[-40..0]

    // Count the render-tree query the hover hit-test would otherwise run per frame.
    let queries = 0;
    const orig = map.queryRenderedFeatures;
    map.queryRenderedFeatures = (...args: unknown[]) => {
      queries++;
      return orig(...args);
    };

    // Roam the pointer far from every handle (screen ~10000,10000) many times —
    // the cheap projected-bbox pre-check must short-circuit before any query.
    for (let i = 0; i < 30; i++) map.fire("mousemove", ev(1000 + i, 1000 + i));
    expect(queries).toBe(0);

    // A mousemove onto a vertex ([0,0] → screen 0,0) is inside the skirt → query runs.
    map.fire("mousemove", ev(0, 0));
    expect(queries).toBe(1);
  });
});

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

describe("SketchController — drag-to-extrude height grip (plan 040, screen-space overlay)", () => {
  it("renders a DOM grip + ghost stem for a selected relief", () => {
    const { c } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    expect(c.heightGripElement).not.toBeNull();
    expect(c.heightStemElement).not.toBeNull();
    // The grip is the accent core + white ring, ≥ 22 px (r11-scale prominence).
    expect(c.heightGripElement?.style.width).toBe("22px");
    expect(c.heightGripElement?.style.cursor).toBe("ns-resize");
    // …and it is NOT a draped GeoJSON feature (the projection bug's mechanism).
    expect(c.heightStemElement?.className).toContain("height-stem");
  });

  it("dragging the grip up raises the value and commits once on release", () => {
    const { c, heightDrags, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    const grip = c.heightGripElement as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200)); // client-Y baseline
    grip.fire("pointermove", ptr(80)); // 120 px up → +1440 m at coarse mpp
    expect(heightDrags.at(-1)?.value).toBe(1740);
    expect(c.heightHandleValue).toBe(1740);
    grip.fire("pointerup", ptr(80));
    expect(heightCommits).toEqual([{ id: "R1", value: 1740 }]);
  });

  it("Shift drags fine (smaller metres/pixel)", () => {
    const { c, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    const grip = c.heightGripElement as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointermove", ptr(80, true)); // shift → mpp 3 → +360
    grip.fire("pointerup", ptr(80, true));
    expect(heightCommits).toEqual([{ id: "R1", value: 660 }]);
  });

  it("a sub-deadzone grab (no real drag) does NOT commit and snaps back", () => {
    const { c, heightCommits } = makeController();
    c.activate("relief");
    selectReliefWithHeight(c, 300);
    const grip = c.heightGripElement as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointerup", ptr(200)); // released without moving
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

  it("no grip for a shape selected without a height descriptor; deselect tears it down", () => {
    const { c } = makeController();
    c.activate("district");
    c.setTool("select");
    c.select({ id: "D1", geometry: POLY, kind: "district", center: null });
    expect(c.heightGripElement).toBeNull();
    // …and a relief grip is removed (no leaked DOM) once deselected.
    c.select({ id: "R1", geometry: RELIEF_LINE, kind: "relief", center: null, height: { value: 300, min: -4000, max: 4000 } });
    expect(c.heightGripElement).not.toBeNull();
    c.clearSelection();
    expect(c.heightGripElement).toBeNull();
  });
});

const RIVER_LINE: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [4, 0], [8, 0]] };
function selectRiverWithDepths(c: SketchController, values = [90, 90, 90]) {
  c.setTool("select");
  c.select({ id: "RV", geometry: RIVER_LINE, kind: "river", center: null, depths: { values: [...values], min: 0, max: 4000 } });
}

describe("SketchController — river per-vertex depth grips (plan 040 river depths)", () => {
  it("grows one depth grip per spine vertex", () => {
    const { c } = makeController();
    c.activate("river");
    selectRiverWithDepths(c);
    expect(c.depthGripElements).toHaveLength(3);
    expect(c.depthGripElements[0].style.width).toBe("14px"); // the smaller per-vertex grip
    expect(c.depthValues).toEqual([90, 90, 90]);
  });

  it("dragging a vertex grip DOWN deepens that vertex and commits the array on release", () => {
    const { c, depthDrags, depthCommits } = makeController();
    c.activate("river");
    selectRiverWithDepths(c);
    const grip = c.depthGripElements[1] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointermove", ptr(300)); // 100 px DOWN → +400 m at coarse mpp 4
    expect(c.depthValues?.[1]).toBe(490);
    expect(depthDrags.at(-1)).toEqual({ id: "RV", index: 1, value: 490 });
    grip.fire("pointerup", ptr(300));
    // Vertex 1 deepened to 490; the monotone clamp pulls the (shallower) mouth
    // vertex 2 down to match (no vertex's bed sits above the one upstream).
    expect(depthCommits).toEqual([{ id: "RV", values: [90, 490, 490] }]);
  });

  it("a vertex dragged SHALLOWER than upstream is clamped back on commit (no uphill flow)", () => {
    const { c, depthCommits } = makeController();
    c.activate("river");
    selectRiverWithDepths(c, [90, 90, 90]);
    const grip = c.depthGripElements[1] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointermove", ptr(60)); // 140 px UP → −560 m → clamped to min 0
    expect(c.depthValues?.[1]).toBe(0);
    grip.fire("pointerup", ptr(60));
    expect(depthCommits).toEqual([{ id: "RV", values: [90, 90, 90] }]); // shallow middle pulled back to upstream
  });

  it("a sub-deadzone grab does not commit and snaps back", () => {
    const { c, depthCommits } = makeController();
    c.activate("river");
    selectRiverWithDepths(c, [90, 90, 90]);
    const grip = c.depthGripElements[0] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointerup", ptr(200)); // no movement
    expect(depthCommits).toHaveLength(0);
    expect(c.depthValues).toEqual([90, 90, 90]);
  });

  it("no depth grips for a non-river shape; deselect tears them down (no leaked DOM)", () => {
    const { c } = makeController();
    c.activate("landform");
    c.setTool("select");
    c.select({ id: "L1", geometry: POLY, kind: "landform", center: null });
    expect(c.depthGripElements).toHaveLength(0);
    selectRiverWithDepths(c);
    expect(c.depthGripElements).toHaveLength(3);
    c.clearSelection();
    expect(c.depthGripElements).toHaveLength(0);
  });
});

const RELIEF_BAND_LINE: FabricGeometry = { type: "LineString", coordinates: [[0, 0], [4, 0]] };
// The presented band value for a relief is ONE width (= halfWidth + apron —
// the field reads only the sum; 2026-07-16 unification).
function selectReliefWithBand(c: SketchController, values = { width: 180 }) {
  c.setTool("select");
  c.select({ id: "R1", geometry: RELIEF_BAND_LINE, kind: "relief", center: null, band: { values: { ...values }, metersPerUnit: 50 } });
}
function selectLandformWithBand(c: SketchController, band = 120) {
  c.setTool("select");
  c.select({ id: "L1", geometry: POLY, kind: "landform", center: null, band: { values: { band }, metersPerUnit: 50 } });
}

describe("SketchController — band ghost + edge grips (plan 040 Phase 2)", () => {
  it("paints ONE ±width fade-out pair for a relief (no separate apron skirt)", () => {
    const { map, c } = makeController();
    c.activate("relief");
    selectReliefWithBand(c);
    const feats = map.draftFeatures() as { properties?: { ghost?: string }; geometry: { type: string; coordinates: [number, number][] } }[];
    const band = feats.filter((f) => f.properties?.ghost === "band");
    const faint = feats.filter((f) => f.properties?.ghost === "band-faint");
    expect(band).toHaveLength(2); // both sides of the one width edge
    expect(faint).toHaveLength(0); // the two-edge split is gone
    // Horizontal spine, metersPerUnit 50 ⇒ width 180 m = 3.6 units on ±y.
    const ys = band.flatMap((f) => f.geometry.coordinates.map((c2) => c2[1])).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-3.6, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(3.6, 9);
  });

  it("paints an inset band ring for a landform", () => {
    const { map, c } = makeController();
    c.activate("landform");
    selectLandformWithBand(c, 100); // 100 m / 50 = 2 units, under the 45% cap (1.8) ⇒ clamped
    const feats = map.draftFeatures() as { properties?: { ghost?: string } }[];
    expect(feats.filter((f) => f.properties?.ghost === "band")).toHaveLength(1);
  });

  it("grows one band grip per edge (relief: 1, landform: 1)", () => {
    const { c } = makeController();
    c.activate("relief");
    selectReliefWithBand(c);
    expect(c.bandGripElements).toHaveLength(1);
    expect(c.bandGripElements[0].style.width).toBe("13px"); // the small band grip
    selectLandformWithBand(c);
    expect(c.bandGripElements).toHaveLength(1);
  });

  it("dragging the width grip out widens the fade-out and commits once on release", () => {
    const { c, bandDrags, bandCommits } = makeController();
    c.activate("relief");
    selectReliefWithBand(c);
    const grip = c.bandGripElements[0] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200)); // client-Y baseline
    // Screen normal is (0,−1) for a horizontal spine; metres/px = 50/10 = 5.
    grip.fire("pointermove", ptr(100)); // 100 px UP → +500 m → 180 → 680
    expect(c.bandParamValues?.width).toBe(680);
    expect(bandDrags.at(-1)).toEqual({ id: "R1", param: "width", value: 680 });
    grip.fire("pointerup", ptr(100));
    expect(bandCommits).toEqual([{ id: "R1", params: { width: 680 } }]);
  });

  it("dragging the landform band grip inward resizes band and commits once", () => {
    const { c, bandCommits } = makeController();
    c.activate("landform");
    selectLandformWithBand(c, 120);
    const grip = c.bandGripElements[0] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointermove", ptr(140)); // 60 px UP (inward normal is +y ⇒ screen −y) → +300 m → 420
    expect(c.bandParamValues?.band).toBe(420);
    grip.fire("pointerup", ptr(140));
    expect(bandCommits).toEqual([{ id: "L1", params: { band: 420 } }]);
  });

  it("a sub-deadzone grab does NOT commit and snaps back", () => {
    const { c, bandCommits } = makeController();
    c.activate("relief");
    selectReliefWithBand(c);
    const grip = c.bandGripElements[0] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointerup", ptr(200)); // released without moving
    expect(bandCommits).toHaveLength(0);
    expect(c.bandParamValues?.width).toBe(180);
  });

  it("clamps the width grip to its min on a big inward drag", () => {
    const { c, bandCommits } = makeController();
    c.activate("relief");
    selectReliefWithBand(c);
    const grip = c.bandGripElements[0] as unknown as { fire(t: string, e: unknown): void };
    grip.fire("pointerdown", ptr(200));
    grip.fire("pointermove", ptr(400)); // 200 px DOWN → −1000 m → clamped to min 1
    expect(c.bandParamValues?.width).toBe(1);
    grip.fire("pointerup", ptr(400));
    expect(bandCommits).toEqual([{ id: "R1", params: { width: 1 } }]);
  });

  it("no band grips for a non-terrain shape; deselect tears them down (no leaked DOM)", () => {
    const { c } = makeController();
    c.activate("district");
    c.setTool("select");
    c.select({ id: "D1", geometry: POLY, kind: "district", center: null });
    expect(c.bandGripElements).toHaveLength(0);
    selectReliefWithBand(c);
    expect(c.bandGripElements).toHaveLength(1);
    c.clearSelection();
    expect(c.bandGripElements).toHaveLength(0);
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

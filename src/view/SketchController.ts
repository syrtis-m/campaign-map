import type { Map as MapLibreMap, MapMouseEvent, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import { isPolygonKind, minVerticesFor, type FabricGeometry, type FabricKind } from "../model/fabric";
import {
  HEIGHT_MPP_COARSE,
  HEIGHT_MPP_FINE,
  HEIGHT_DRAG_DEADZONE_M,
  DEPTH_MPP_COARSE,
  DEPTH_MPP_FINE,
  valueFromDrag,
  depthFromDrag,
  clampDepthsMonotone,
  clampHeight,
} from "./heightHandle";
import {
  bandEdges,
  bandParamFromOffset,
  offsetFromBandDrag,
  offsetPolyline,
  insetRing,
  safeInsetDistance,
  polylineMidNormal,
  ringInsetNormal,
  type Pt as PlanarPt,
} from "./bandGhost";

const DRAFT_SOURCE = "fabric-draft";
const DRAFT_LAYERS = [
  "fabric-draft-fill",
  "fabric-draft-line",
  "fabric-draft-band",
  "fabric-draft-band-faint",
  "fabric-draft-midpoint",
  "fabric-draft-vertex",
  "fabric-draft-center",
] as const;
/** Handle layers hit-tested during a vertex/midpoint/center grab. The extrude
 * grip is NOT here — it is a screen-space DOM overlay (see the grip section
 * below), never a draped GeoJSON feature. */
const HANDLE_LAYERS = ["fabric-draft-center", "fabric-draft-vertex", "fabric-draft-midpoint"];
/** Screen-space skirt (px) around the selected shape's projected vertex/center
 * bbox inside which the per-mousemove hover hit-test is worth running. Covers the
 * handle hit box (±8 px) plus the largest rendered handle radius with headroom, so
 * the pre-check NEVER skips a real handle — a false "near" merely runs the
 * (correct) query; only a false "far" could miss one, and this margin makes that
 * impossible. See `cursorNearHandles`. */
const HOVER_PRECHECK_MARGIN_PX = 24;
/** Idle grip offset (px) from the anchor caps here so a tall stamp's grip
 * stays on screen; during a drag the grip follows the cursor 1:1. */
const HEIGHT_REST_CAP_PX = 100;
/** Extrude-grip core diameter (px) + its white ring — the r11-scale prominence
 * of the old circle-radius:11 grip, now the largest deliberate DOM target
 * (core ≥ 22 px per the plan-040 bar). */
const HEIGHT_GRIP_CORE_PX = 22;
const HEIGHT_GRIP_RING_PX = 4;
const HEIGHT_GRIP_OUTER_PX = HEIGHT_GRIP_CORE_PX + HEIGHT_GRIP_RING_PX * 2;
/** River depth grips are smaller than the single terrain-stamp grip — there is
 * one PER vertex, so they read as a row of small handles, not one big target. */
const DEPTH_GRIP_CORE_PX = 14;
const DEPTH_GRIP_OUTER_PX = DEPTH_GRIP_CORE_PX + HEIGHT_GRIP_RING_PX * 2;
/** Band-edge grips (plan 040 Phase 2): small hollow handles that sit ON the
 * ghost footprint outline (the ground band a relief/landform reaches), dragged
 * perpendicular to the outline to resize `halfWidth`/`apron`/`band`. */
const BAND_GRIP_CORE_PX = 13;
const BAND_GRIP_OUTER_PX = BAND_GRIP_CORE_PX + HEIGHT_GRIP_RING_PX * 2;
/** Below this many metres of offset change a band-grip release is a click, not a
 * resize — no commit (mirrors the height/depth deadzone). */
const BAND_DRAG_DEADZONE_M = HEIGHT_DRAG_DEADZONE_M;

type Pt = [number, number];

/** What the controller reports back to the host on a committed edit — a
 * whole-feature geometry replacement (MapView turns it into a `sketch-edit`
 * mutation-log entry + persist + regen). */
export interface SketchControllerHandlers {
  onGeometryEdit(featureId: string, geometry: FabricGeometry): void;
  /** A finishable in-progress draft (≥ min vertices) is being committed
   * because the GM "clicked out" of the draw context — switched to the Select
   * tool, switched kind, or left sketch mode — INSTEAD of the old behaviour of
   * silently discarding it. The host persists it exactly as a double-click /
   * Enter finish would (same `sketch-add` + optional procgen offer). A
   * too-short draft is still discarded, never reported here. */
  onDraftCommit?(geometry: FabricGeometry, kind: FabricKind): void;
  /** Drag-commit of a procgen region's generation center, display units. Only
   * regions pass a center to `select`. */
  onCenterEdit?(featureId: string, center: Pt): void;
  /** Live signed value (m) during a height-handle drag — the host updates a
   * readout HUD; no regen (the terrain re-compose waits for release). */
  onHeightDrag?(featureId: string, value: number): void;
  /** Release-commit of the drag-to-extrude height handle: the final signed
   * value (m). The host maps it back to the algorithm's params
   * (`heightParamsFromValue`) and runs the normal `setRegionParams` path
   * (validate → log → cascade → undo). Only a past-deadzone drag reports here. */
  onHeightCommit?(featureId: string, value: number): void;
  /** Live signed value (m) during a per-vertex river DEPTH-grip drag — the host
   * shows a readout HUD; no regen until release. */
  onDepthDrag?(featureId: string, index: number, value: number): void;
  /** Release-commit of a river's per-vertex carve depths: the FULL (monotone-
   * clamped) depths array. The host merges it into the live params
   * (`depthParamsFromValues`) and runs the normal `setRegionParams` path. Only a
   * past-deadzone drag reports here. */
  onDepthCommit?(featureId: string, values: number[]): void;
  /** Live param value (m) during a band-edge grip drag (plan 040 Phase 2) — the
   * host updates a readout HUD; no terrain recompute (that waits for release).
   * `param` is the zod key the edge sets (`halfWidth`/`apron`/`band`). */
  onBandDrag?(featureId: string, param: string, value: number): void;
  /** Release-commit of a band-edge grip: the single param the edge sets, merged
   * into the live params by the host and run through the normal `setRegionParams`
   * path (validate → log → cascade → undo). Only a past-deadzone drag reports. */
  onBandCommit?(featureId: string, params: Record<string, unknown>): void;
  /** Mid-drag geometry (fired on every move of a grabbed handle; the host
   * debounces). Plan 034-D preview mode: the host paints an EPHEMERAL
   * root-only regen per pause — never cached, never fingerprinted; the full
   * forward pass runs once on release via `onGeometryEdit`. */
  onGeometryPreview?(featureId: string, geometry: FabricGeometry): void;
}

/** The feature the Select tool is editing (open vertex list = no closing
 * duplicate; the same indexing `moveVertex`/`deleteVertex` use). */
interface EditState {
  featureId: string;
  type: FabricGeometry["type"];
  kind: FabricKind;
  vertices: Pt[];
  /** Effective generation center (display units) for a procgen region — a
   * distinct draggable handle; null for non-region shapes. */
  center: Pt | null;
  /** Drag-to-extrude height handle state (relief/landform terrain stamps) —
   * the signed elevation the grip represents + its UI bounds; null for kinds
   * without a height handle. */
  height: { value: number; min: number; max: number } | null;
  /** Per-vertex river carve-depth grips (plan 040 river depths) — one depth (m)
   * per spine vertex, aligned to `vertices`; null for kinds without depth grips
   * (everything but a river). */
  depths: { values: number[]; min: number; max: number } | null;
  /** Band-edge grips (plan 040 Phase 2) — the effective ground band a
   * relief/landform reaches, editable on the map. `values` are the LIVE param
   * metres the ghost outline + grips are computed from (`halfWidth`+`apron` for
   * relief; `band` for landform); `metersPerUnit` converts them into the base
   * geometry's planar units for the offset. Null for kinds without a band. */
  band: { values: Record<string, number>; metersPerUnit: number } | null;
}

/**
 * Hand-rolled draw + edit controller.
 *
 * DRAW tool: straight-segment line/polygon — click to add a vertex,
 * double-click/Enter to finish, Esc to cancel.
 *
 * SELECT tool (PowerPoint-style): click a fabric feature (routed
 * from MapView.handleClick — one click pipeline, no second handler race) to
 * select it; the shape gets an accent highlight, draggable vertex handles, and
 * midpoint insert handles. Drag a vertex to move it; drag a midpoint to insert
 * a vertex there; Backspace/Delete on a grabbed/hovered vertex removes it (min
 * 2 line / 3 polygon). Every geometry change is a whole-feature commit through
 * `onGeometryEdit` (MapView validates region rings, logs, persists, regens).
 *
 * The controller owns the mousedown/move/up dance for handle dragging itself
 * (map.dragPan disabled during a grab), and a live preview through a temp
 * `fabric-draft` geojson source it adds lazily so a theme switch's setStyle
 * wiping it is self-healing on the next render.
 */
export class SketchController {
  private vertices: Pt[] = [];
  private cursor: Pt | null = null;
  private kind: FabricKind = "road";
  private tool: "draw" | "select" = "draw";
  private edit: EditState | null = null;
  private dragVertexIndex: number | null = null;
  private hoverVertexIndex: number | null = null;
  /** True while the (single) center handle is being dragged. */
  private draggingCenter = false;
  /** Extrude-grip drag bookkeeping: the pointer's client-Y at grab + the value
   * baseline + the grip's pixel offset at grab (so the grip follows the cursor
   * 1:1 while dragging). Client-Y only appears in a DELTA, so the map-canvas
   * offset cancels; the value math (`valueFromDrag`) is unchanged. Null when no
   * extrude drag is active. */
  private heightDrag: { startClientY: number; startValue: number; startOffsetPx: number } | null = null;
  /** Screen-space extrude overlay (plan 040 projection fix): the grip is a DOM
   * element offset PURELY in screen pixels above the terrain-projected anchor,
   * so the stem rises vertically at ANY pitch/bearing — never a draped GeoJSON
   * point that reads as lying on the ground. Null when no terrain stamp with a
   * height handle is selected. */
  private gripEl: HTMLElement | null = null;
  private stemEl: HTMLElement | null = null;
  /** Current pixel offset of the grip above its anchor (negative = below, for a
   * valley/basin). Idle it tracks value/coarse-mpp (capped); mid-drag it follows
   * the cursor 1:1. */
  private gripOffsetPx = 0;
  /** Camera-move reposition hook (terrain-aware `project` reruns), registered
   * only while a grip exists. */
  private gripMoveHook: (() => void) | null = null;

  // ── River per-vertex depth grips (plan 040 river depths) ──────────────────
  // A river grows ONE depth grip per spine vertex (unlike the terrain stamps'
  // single centroid grip). Same screen-space DOM-overlay idiom + `depthFromDrag`
  // math, generalized to N grips: each is anchored under its vertex and dragged
  // DOWN to deepen the carve THERE.
  private depthGrips: HTMLElement[] = [];
  private depthStems: HTMLElement[] = [];
  /** Per-grip idle pixel offset BELOW its vertex anchor (tracks depth; mid-drag
   * the dragged grip follows the cursor 1:1). */
  private depthOffsetsPx: number[] = [];
  /** Active depth-grip drag: which vertex, the pointer-Y + value + offset
   * baselines at grab. Null when no depth drag is in flight. */
  private depthDrag: { index: number; startClientY: number; startValue: number; startOffsetPx: number } | null = null;
  /** Camera-move reposition hook for the depth grips, registered only while they
   * exist. */
  private depthMoveHook: (() => void) | null = null;
  /** Per-grip pointerdown closures (each captures its vertex index), kept for
   * teardown. */
  private depthDownHandlers: ((e: PointerEvent) => void)[] = [];

  // ── Band-edge grips (plan 040 Phase 2) ────────────────────────────────────
  // One grip per draggable band edge (relief: halfWidth + apron; landform:
  // band). Unlike the height/depth grips (a fixed screen-Y axis, decoupled from
  // the map surface), a band edge IS a ground footprint, so its grip lives on
  // the ghost outline via a TRUE `project`, and its drag is measured along the
  // outline's screen normal with metres/pixel folded from the live map scale.
  private bandGrips: HTMLElement[] = [];
  /** Active band-drag bookkeeping: which edge + its param, the pointer client
   * position at grab, the outline's unit screen normal + metres/pixel captured
   * at grab, and the offset baseline. Null when no band drag is in flight. */
  private bandDrag: {
    index: number;
    param: "halfWidth" | "apron" | "band";
    startClientX: number;
    startClientY: number;
    screenNormal: PlanarPt;
    metresPerPixel: number;
    startOffset: number;
    startValues: Record<string, number>;
  } | null = null;
  /** Camera-move reposition hook for the band grips, registered only while they
   * exist. */
  private bandMoveHook: (() => void) | null = null;
  /** Per-grip pointerdown closures (each captures its edge index), kept for
   * teardown. */
  private bandDownHandlers: ((e: PointerEvent) => void)[] = [];
  /** Set true when a mousedown grabs a handle, so the trailing `click`
   * MapLibre may fire is suppressed (see `consumeInteraction`). Cleared at the
   * start of every mousedown so a stale flag can never silently eat the next
   * legitimate click (defensive — a drag with dragPan off may fire no click). */
  private interactionConsumed = false;
  private active = false;

  private readonly moveHandler = (e: MapMouseEvent): void => {
    if (!this.isDrawing) return;
    this.cursor = [e.lngLat.lng, e.lngLat.lat];
    this.renderDraft();
  };

  /** Select-tool hover: tracks which vertex handle the cursor is over (for the
   * Delete-hovered-vertex path and the move cursor). No-op while drawing. */
  private readonly hoverHandler = (e: MapMouseEvent): void => {
    if (!this.active || this.tool !== "select" || !this.edit || this.dragVertexIndex !== null) return;
    // Cheap screen-space pre-check FIRST (Jonah 2026-07-15, Cradle: "everything
    // feels very slow to click around"). Projecting the edit vertices is O(N)
    // matrix math — orders of magnitude cheaper than a queryRenderedFeatures
    // render-tree walk, which this handler otherwise ran on EVERY mousemove while
    // a big shape (the 128-vertex coast donut) was selected. The pointer is far
    // from every handle for almost all of its travel, so skip the query then.
    if (!this.cursorNearHandles(e.point.x, e.point.y)) {
      this.hoverVertexIndex = null;
      this.map.getCanvas().style.cursor = "";
      return;
    }
    const hit = this.handleAt(e.point.x, e.point.y);
    this.hoverVertexIndex = hit && hit.handle === "vertex" ? hit.index : null;
    // The extrude grip owns its own ns-resize cursor (it is a DOM element); the
    // map-canvas hit-test only cues the move handles now.
    this.map.getCanvas().style.cursor = hit ? "move" : "";
  };

  /** Is the cursor within the hover-hit skirt of the selected shape's handles?
   * Projects the edit vertices (+ the region center handle) to a screen bbox and
   * tests the cursor against it expanded by `HOVER_PRECHECK_MARGIN_PX`. Handles
   * only ever sit at a vertex, an edge midpoint (inside the vertex bbox), or the
   * center — all covered — so a "false" here provably means no handle is hittable
   * and the queryRenderedFeatures can be skipped. */
  private cursorNearHandles(x: number, y: number): boolean {
    const edit = this.edit;
    if (!edit) return false;
    const pts = edit.center ? [...edit.vertices, edit.center] : edit.vertices;
    if (pts.length === 0) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const v of pts) {
      const p = this.map.project(v as Pt);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const m = HOVER_PRECHECK_MARGIN_PX;
    return x >= minX - m && x <= maxX + m && y >= minY - m && y <= maxY + m;
  }

  private readonly downHandler = (e: MapMouseEvent): void => {
    this.interactionConsumed = false; // defensive: never let a stale flag eat a click
    if (!this.active || this.tool !== "select" || !this.edit || this.isDrawing) return;
    const hit = this.handleAt(e.point.x, e.point.y);
    if (!hit) return; // empty ground — let the click deselect/select
    e.preventDefault();
    if (hit.handle === "center") {
      this.draggingCenter = true;
      this.edit.center = [e.lngLat.lng, e.lngLat.lat];
    } else if (hit.handle === "midpoint") {
      // Insert a vertex on this edge, then drag it — index shifts to edgeIndex+1.
      this.edit.vertices.splice(hit.index + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
      this.dragVertexIndex = hit.index + 1;
    } else {
      this.dragVertexIndex = hit.index;
    }
    this.interactionConsumed = true;
    this.map.dragPan.disable();
    this.renderDraft();
    this.map.on("mousemove", this.dragMove);
    this.map.on("mouseup", this.dragUp);
  };

  private readonly dragMove = (e: MapMouseEvent): void => {
    if (!this.edit) return;
    if (this.draggingCenter) {
      this.edit.center = [e.lngLat.lng, e.lngLat.lat];
      this.renderDraft();
      return;
    }
    if (this.dragVertexIndex === null) return;
    this.edit.vertices[this.dragVertexIndex] = [e.lngLat.lng, e.lngLat.lat];
    this.renderDraft();
    // Preview mode (plan 034-D): report the in-progress shape; the host
    // debounces + paints an ephemeral root-only regen per pause.
    this.handlers.onGeometryPreview?.(this.edit.featureId, this.geometryOf(this.edit));
  };

  private readonly dragUp = (): void => {
    this.map.off("mousemove", this.dragMove);
    this.map.off("mouseup", this.dragUp);
    this.map.dragPan.enable();
    if (this.draggingCenter) {
      this.draggingCenter = false;
      if (this.edit && this.edit.center) this.handlers.onCenterEdit?.(this.edit.featureId, this.edit.center);
      return;
    }
    this.dragVertexIndex = null;
    if (this.edit) this.commitEdit();
  };

  // ── Extrude grip (screen-space DOM overlay) ──────────────────────────────
  // The grip runs its OWN pointer capture instead of the map's mouse pipeline,
  // so the drag is decoupled from the terrain surface: client-Y deltas drive
  // the unchanged `valueFromDrag` math, and the grip is positioned in raw
  // screen pixels above a terrain-aware `map.project` of the anchor.

  /** Swallow the grip's mousedown so MapLibre's DragPanHandler (mouse-based)
   * never starts a pan under the grab — pointer capture owns the gesture. */
  private readonly onGripMouseDown = (e: Event): void => {
    e.stopPropagation();
  };

  private readonly onGripPointerDown = (e: PointerEvent): void => {
    if (!this.edit?.height || !this.gripEl) return;
    // Stop the event reaching the map canvas → no map drag, no trailing click
    // (so the selection is never deselected by grabbing the grip).
    e.stopPropagation();
    e.preventDefault();
    try {
      this.gripEl.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / headless mock has no capture — the delta math still runs */
    }
    this.heightDrag = {
      startClientY: e.clientY,
      startValue: this.edit.height.value,
      startOffsetPx: this.gripOffsetPx,
    };
    this.gripEl.addEventListener("pointermove", this.onGripPointerMove);
    this.gripEl.addEventListener("pointerup", this.onGripPointerUp);
    this.gripEl.addEventListener("pointercancel", this.onGripPointerUp);
    this.map.dragPan.disable();
  };

  private readonly onGripPointerMove = (e: PointerEvent): void => {
    if (!this.heightDrag || !this.edit?.height) return;
    const dyUp = this.heightDrag.startClientY - e.clientY; // up = raise
    const mpp = e.shiftKey ? HEIGHT_MPP_FINE : HEIGHT_MPP_COARSE;
    const v = valueFromDrag(this.heightDrag.startValue, dyUp, mpp, this.edit.height.min, this.edit.height.max);
    this.edit.height.value = v;
    this.gripOffsetPx = this.heightDrag.startOffsetPx + dyUp; // grip follows cursor 1:1
    this.repositionHeightGrip();
    this.handlers.onHeightDrag?.(this.edit.featureId, v);
  };

  private readonly onGripPointerUp = (e: PointerEvent): void => {
    if (!this.heightDrag) return;
    const { startValue } = this.heightDrag;
    this.heightDrag = null;
    if (this.gripEl) {
      try {
        this.gripEl.releasePointerCapture(e.pointerId);
      } catch {
        /* headless mock */
      }
      this.gripEl.removeEventListener("pointermove", this.onGripPointerMove);
      this.gripEl.removeEventListener("pointerup", this.onGripPointerUp);
      this.gripEl.removeEventListener("pointercancel", this.onGripPointerUp);
    }
    this.map.dragPan.enable();
    if (this.edit?.height) {
      const v = this.edit.height.value;
      if (Math.abs(v - startValue) >= HEIGHT_DRAG_DEADZONE_M) {
        this.handlers.onHeightCommit?.(this.edit.featureId, v);
      } else {
        this.edit.height.value = startValue; // deadzone: treat as a click, snap back
      }
    }
    this.repositionHeightGrip();
  };

  constructor(
    private map: MapLibreMap,
    private accent: string,
    private handlers: SketchControllerHandlers
  ) {}

  get isDrawing(): boolean {
    return this.vertices.length > 0;
  }

  get currentKind(): FabricKind {
    return this.kind;
  }

  get currentTool(): "draw" | "select" {
    return this.tool;
  }

  get editingFeatureId(): string | null {
    return this.edit?.featureId ?? null;
  }

  /** A vertex is under the cursor or being dragged — Delete targets it (else
   * the whole shape, handled by MapView). */
  get hasActiveVertex(): boolean {
    return this.dragVertexIndex !== null || this.hoverVertexIndex !== null;
  }

  activate(kind: FabricKind): void {
    this.kind = kind;
    this.active = true;
    this.ensureDraftInfra();
    this.map.on("mousemove", this.moveHandler);
    this.map.on("mousemove", this.hoverHandler);
    this.map.on("mousedown", this.downHandler);
    this.applyToolCursor();
  }

  /** Switching kind mid-draw COMMITS a finishable draft under the OLD kind
   * (you keep the road you drew and start a river), then switches — only a
   * too-short draft is discarded. An active selection is kept. */
  setKind(kind: FabricKind): void {
    if (this.kind !== kind && this.isDrawing) this.commitDraftIfAny();
    this.kind = kind;
  }

  /** Switch between the draw palette and the Select arrow. Entering Select
   * COMMITS a finishable draft (never silently deletes it — the click-out bug);
   * leaving Select clears the edit selection. */
  setTool(tool: "draw" | "select"): void {
    if (this.tool === tool) return;
    if (tool === "select") this.commitDraftIfAny();
    else this.clearSelection();
    this.tool = tool;
    this.applyToolCursor();
  }

  /**
   * Commit an in-progress draft the same way a double-click / Enter finish
   * would (reports it through `onDraftCommit` so the host persists it), OR
   * discard it if it is too short to be a shape. No-op when not drawing.
   *
   * This is the fix for "editing a shape and click out just deletes it": every
   * transition OUT of the draw context (Select tool, kind switch, exit sketch
   * mode / the ✕ done button) routes through here instead of `cancel()`, so
   * work is never thrown away by an implicit gesture. The one deliberate
   * discard affordance stays `Esc` (host-driven `cancel()`).
   */
  commitDraftIfAny(): void {
    if (!this.isDrawing) return;
    const kind = this.kind;
    const geometry = this.finish(); // null (and self-cancels) when too short
    if (geometry) this.handlers.onDraftCommit?.(geometry, kind);
  }

  /** True when the in-progress draft has enough vertices to become a shape
   * (line ≥2 / polygon ≥3) — a `commitDraftIfAny` would commit, not discard. */
  get isFinishableDraft(): boolean {
    if (!this.isDrawing) return false;
    return this.vertices.length >= (isPolygonKind(this.kind) ? 3 : 2);
  }

  private applyToolCursor(): void {
    if (!this.active) return;
    this.map.getCanvas().style.cursor = this.tool === "draw" ? "crosshair" : "";
  }

  deactivate(): void {
    this.active = false;
    this.vertices = [];
    this.cursor = null;
    this.edit = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.removeHeightGrip();
    this.removeDepthGrips();
    this.removeBandGrips();
    this.map.off("mousemove", this.moveHandler);
    this.map.off("mousemove", this.hoverHandler);
    this.map.off("mousedown", this.downHandler);
    this.map.off("mousemove", this.dragMove);
    this.map.off("mouseup", this.dragUp);
    this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = "";
    for (const id of DRAFT_LAYERS) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource(DRAFT_SOURCE)) this.map.removeSource(DRAFT_SOURCE);
  }

  addVertex(lngLat: Pt): void {
    if (!this.active || this.tool !== "draw") return;
    this.clearSelection();
    // Dedupe the double-fired click of a finishing dblclick (and accidental
    // double-taps): a vertex within ~3px of the previous one is the same one.
    const last = this.vertices[this.vertices.length - 1];
    if (last) {
      const a = this.map.project(last);
      const b = this.map.project(lngLat);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return;
    }
    this.vertices.push(lngLat);
    this.renderDraft();
  }

  /** Finalizes the draft into a geometry, or null if it's too short (line
   * needs ≥2 vertices, polygon ≥3 — the too-short draft is discarded). */
  finish(): FabricGeometry | null {
    const polygon = isPolygonKind(this.kind);
    const minVertices = polygon ? 3 : 2;
    if (this.vertices.length < minVertices) {
      this.cancel();
      return null;
    }
    const vertices = this.vertices;
    this.vertices = [];
    this.cursor = null;
    this.renderDraft();
    if (polygon) {
      return { type: "Polygon", coordinates: [[...vertices, vertices[0]]] };
    }
    return { type: "LineString", coordinates: vertices };
  }

  cancel(): void {
    this.vertices = [];
    this.cursor = null;
    this.renderDraft();
  }

  /** Enter the edit state for an existing fabric feature (Select tool). The
   * open vertex list is the working copy; a committed drag/insert/delete
   * reports the whole new geometry through `onGeometryEdit`. Re-selecting the
   * same feature after a commit resets the baseline to its persisted geometry. */
  select(feature: {
    id: string;
    geometry: FabricGeometry;
    kind: FabricKind;
    center?: Pt | null;
    height?: { value: number; min: number; max: number } | null;
    depths?: { values: number[]; min: number; max: number } | null;
    band?: { values: Record<string, number>; metersPerUnit: number } | null;
  }): void {
    this.vertices = [];
    this.cursor = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.draggingCenter = false;
    this.heightDrag = null;
    this.depthDrag = null;
    this.bandDrag = null;
    const vertices = openVertices(feature.geometry);
    // Depth grips align to the spine vertices; a mismatched persisted array is
    // ignored upstream (`riverDepthValues`), but guard here too.
    const depths = feature.depths && feature.depths.values.length === vertices.length ? feature.depths : null;
    this.edit = {
      featureId: feature.id,
      type: feature.geometry.type,
      kind: feature.kind,
      vertices,
      center: feature.center ?? null,
      height: feature.height ?? null,
      depths,
      band: feature.band ?? null,
    };
    this.renderDraft();
  }

  /** Set the height handle's value programmatically (type-to-refine, Phase 3;
   * also the headless-test entry for the readout/commit path). Clamped to the
   * handle bounds; no commit — the caller decides when to persist. */
  setHeightValue(value: number): void {
    if (!this.edit?.height) return;
    this.edit.height.value = clampHeight(value, this.edit.height.min, this.edit.height.max);
    this.renderDraft();
  }

  get heightHandleValue(): number | null {
    return this.edit?.height?.value ?? null;
  }

  clearSelection(): void {
    this.edit = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.draggingCenter = false;
    this.heightDrag = null;
    this.depthDrag = null;
    this.bandDrag = null;
    this.renderDraft();
  }

  /**
   * Delete the grabbed-or-hovered vertex (Backspace/Delete). Returns:
   *  - "deleted": removed + committed;
   *  - "min": at the min-vertex floor (line 2 / polygon 3) — ignored;
   *  - "none": no vertex under the cursor (MapView deletes the whole shape).
   */
  deleteActiveVertex(): "deleted" | "min" | "none" {
    if (!this.edit) return "none";
    const index = this.dragVertexIndex ?? this.hoverVertexIndex;
    if (index === null || index < 0 || index >= this.edit.vertices.length) return "none";
    if (this.edit.vertices.length <= minVerticesFor(this.geometryOf(this.edit))) return "min";
    this.edit.vertices.splice(index, 1);
    this.hoverVertexIndex = null;
    this.dragVertexIndex = null;
    this.renderDraft();
    this.commitEdit();
    return "deleted";
  }

  /** Was the just-fired click preceded by a handle grab? (Consumed once —
   * MapView calls this before its select/deselect logic so a vertex drag or
   * insert doesn't also reselect/deselect.) */
  consumeInteraction(): boolean {
    const v = this.interactionConsumed;
    this.interactionConsumed = false;
    return v;
  }

  private commitEdit(): void {
    if (!this.edit) return;
    this.handlers.onGeometryEdit(this.edit.featureId, this.geometryOf(this.edit));
  }

  private geometryOf(edit: EditState): FabricGeometry {
    if (edit.type === "Polygon") {
      return { type: "Polygon", coordinates: [[...edit.vertices, edit.vertices[0]]] };
    }
    return { type: "LineString", coordinates: [...edit.vertices] };
  }

  /** Hit-test the handle layers at a screen point; nearest handle wins, with
   * vertices preferred over midpoints on a tie. */
  private handleAt(
    x: number,
    y: number
  ): { handle: "vertex" | "midpoint" | "center"; index: number } | null {
    const layers = HANDLE_LAYERS.filter((l) => this.map.getLayer(l));
    if (layers.length === 0) return null;
    const box: [[number, number], [number, number]] = [
      [x - 8, y - 8],
      [x + 8, y + 8],
    ];
    const hits = this.map.queryRenderedFeatures(box, { layers });
    let best: { handle: "vertex" | "midpoint" | "center"; index: number } | null = null;
    let bestScore = Infinity;
    for (const f of hits) {
      const handle = f.properties?.handle as "vertex" | "midpoint" | "center" | undefined;
      const index = f.properties?.index as number | undefined;
      if (handle === undefined || index === undefined) continue;
      if (f.geometry.type !== "Point") continue;
      const p = this.map.project(f.geometry.coordinates as Pt);
      // Distance, with a small bias so center wins over vertex wins over
      // midpoint on a near-tie (the big deliberate targets go first). The
      // extrude grip is no longer here — it is a DOM overlay with its own
      // pointer capture, so it can never be confused with a center grab (the
      // old "extrude feels horizontal" report's root cause).
      const bias = handle === "center" ? -1 : handle === "vertex" ? 0 : 0.5;
      const d = Math.hypot(p.x - x, p.y - y) + bias;
      if (d < bestScore) {
        bestScore = d;
        best = { handle, index };
      }
    }
    return best;
  }

  /** Lazily (re)creates the draft source + preview/handle layers — also
   * self-heals after a theme switch's setStyle wipes user-added sources. */
  private ensureDraftInfra(): void {
    if (!this.map.getSource(DRAFT_SOURCE)) {
      this.map.addSource(DRAFT_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    const layers: LayerSpecification[] = [
      {
        id: "fabric-draft-fill",
        type: "fill",
        source: DRAFT_SOURCE,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": this.accent, "fill-opacity": 0.12 },
      } as unknown as LayerSpecification,
      {
        id: "fabric-draft-line",
        type: "line",
        source: DRAFT_SOURCE,
        // Exclude the band ghost lines — they have their own fainter layers.
        filter: ["all", ["!=", ["geometry-type"], "Point"], ["!", ["has", "ghost"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": this.accent,
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      } as unknown as LayerSpecification,
      {
        // Band ghost — the effective footprint edge (halfWidth corridor / band
        // ring). Dashed accent, drawn UNDER the handles; a fainter dash than the
        // edit outline so the reach reads as a guide, not the shape itself.
        id: "fabric-draft-band",
        type: "line",
        source: DRAFT_SOURCE,
        filter: ["==", ["get", "ghost"], "band"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": this.accent,
          "line-width": 1.5,
          "line-opacity": 0.55,
          "line-dasharray": [3, 3],
        },
      } as unknown as LayerSpecification,
      {
        // Fainter apron-skirt ghost (halfWidth + apron): the foothill reach,
        // fainter still so it reads as the outer feather.
        id: "fabric-draft-band-faint",
        type: "line",
        source: DRAFT_SOURCE,
        filter: ["==", ["get", "ghost"], "band-faint"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": this.accent,
          "line-width": 1,
          "line-opacity": 0.28,
          "line-dasharray": [2, 4],
        },
      } as unknown as LayerSpecification,
      {
        // Midpoint insert handles: hollow (white fill, accent ring), smaller
        // than vertices so the two read distinctly. Drawn UNDER vertices.
        id: "fabric-draft-midpoint",
        type: "circle",
        source: DRAFT_SOURCE,
        filter: ["==", ["get", "handle"], "midpoint"],
        paint: {
          "circle-radius": 3,
          "circle-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": this.accent,
        },
      } as unknown as LayerSpecification,
      {
        // Vertices: filled accent dots (draft-placed vertices, which carry no
        // `handle`, also match here — they must stay visible while drawing).
        id: "fabric-draft-vertex",
        type: "circle",
        source: DRAFT_SOURCE,
        filter: [
          "all",
          ["==", ["geometry-type"], "Point"],
          ["!=", ["get", "handle"], "midpoint"],
          ["!=", ["get", "handle"], "center"],
        ],
        paint: {
          "circle-radius": 4,
          "circle-color": this.accent,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      } as unknown as LayerSpecification,
      {
        // Generation-center handle: deliberately UNLIKE a vertex —
        // bigger, inverted (white core, thick accent ring) so it reads as "the
        // plaza / city center," not another corner. Drawn on top.
        id: "fabric-draft-center",
        type: "circle",
        source: DRAFT_SOURCE,
        filter: ["==", ["get", "handle"], "center"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#ffffff",
          "circle-stroke-width": 3,
          "circle-stroke-color": this.accent,
        },
      } as unknown as LayerSpecification,
    ];
    // NB: the drag-to-extrude grip is intentionally NOT a draft layer — a
    // GeoJSON point/line drapes onto 3D terrain under a pitched camera and
    // reads as lying flat on the ground (the plan-040 projection bug). It is a
    // screen-space DOM overlay instead — see `ensureHeightGrip`.
    for (const layer of layers) {
      if (!this.map.getLayer(layer.id)) this.map.addLayer(layer);
    }
  }

  private renderDraft(): void {
    if (!this.active) return;
    this.ensureDraftInfra();
    const features: GeoJSON.Feature[] = [];

    // Select-tool edit state: outline highlight + vertex + midpoint handles.
    if (this.edit) {
      const geom = this.geometryOf(this.edit);
      features.push({ type: "Feature", geometry: geom as GeoJSON.Geometry, properties: {} });
      const open = this.edit.vertices;
      open.forEach((v, i) => {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: v },
          properties: { handle: "vertex", index: i },
        });
      });
      const edgeCount = this.edit.type === "Polygon" ? open.length : open.length - 1;
      for (let i = 0; i < edgeCount; i++) {
        const a = open[i];
        const b = open[(i + 1) % open.length];
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          properties: { handle: "midpoint", index: i },
        });
      }
      if (this.edit.center) {
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: this.edit.center },
          properties: { handle: "center", index: 0 },
        });
      }
      for (const f of this.bandGhostFeatures()) features.push(f);
    }

    if (this.isDrawing) {
      const preview = this.cursor ? [...this.vertices, this.cursor] : [...this.vertices];
      if (preview.length >= 2) {
        if (isPolygonKind(this.kind) && preview.length >= 3) {
          features.push({
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [[...preview, preview[0]]] },
            properties: {},
          });
        } else {
          features.push({
            type: "Feature",
            geometry: { type: "LineString", coordinates: preview },
            properties: {},
          });
        }
      }
      for (const v of this.vertices) {
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: v }, properties: {} });
      }
    }

    const source = this.map.getSource(DRAFT_SOURCE) as GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features });
    this.syncHeightGrip();
    this.syncDepthGrips();
    this.syncBandGrips();
  }

  /** Display-only ghost outlines of the effective band a relief/landform stamp
   * reaches (plan 040 Phase 2): relief → the ±halfWidth corridor (solid ghost)
   * + the fainter ±(halfWidth+apron) skirt; landform → the inset band ring.
   * Offset in the base geometry's planar units (metres ÷ metresPerUnit); pure
   * `offsetPolyline`/`insetRing`. Draping onto terrain is fine — the band IS a
   * ground footprint. */
  private bandGhostFeatures(): GeoJSON.Feature[] {
    if (!this.edit?.band) return [];
    const { values, metersPerUnit } = this.edit.band;
    const toUnits = (m: number): number => m / metersPerUnit;
    const out: GeoJSON.Feature[] = [];
    if (this.edit.kind === "relief") {
      const hw = toUnits(bandEdges("relief", values)[0].offsetMeters);
      const outer = toUnits(bandEdges("relief", values)[1].offsetMeters);
      const line = (coords: PlanarPt[], ghost: string): GeoJSON.Feature => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: { ghost },
      });
      out.push(line(offsetPolyline(this.edit.vertices, hw), "band"));
      out.push(line(offsetPolyline(this.edit.vertices, -hw), "band"));
      if (outer > hw + 1e-9) {
        out.push(line(offsetPolyline(this.edit.vertices, outer), "band-faint"));
        out.push(line(offsetPolyline(this.edit.vertices, -outer), "band-faint"));
      }
    } else if (this.edit.kind === "landform") {
      const d = safeInsetDistance(this.edit.vertices, toUnits(values.band ?? 0));
      if (d > 1e-9) {
        out.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: insetRing(this.edit.vertices, d) },
          properties: { ghost: "band" },
        });
      }
    }
    return out;
  }

  // ── Extrude-grip overlay lifecycle ───────────────────────────────────────

  /** Create/position the grip when a terrain stamp with a height handle is
   * selected; tear it down otherwise. Idempotent — safe to call every render. */
  private syncHeightGrip(): void {
    if (this.active && this.edit?.height) {
      this.ensureHeightGrip();
      this.repositionHeightGrip();
    } else {
      this.removeHeightGrip();
    }
  }

  /** The shared screen-space grip + dashed-stem DOM pair — the ONE overlay idiom
   * the terrain-stamp height grip and the river depth grips both use (created as
   * absolutely-positioned children of the map's canvas container, inline-styled
   * so no stylesheet is needed; accent core + white ring). `cls` distinguishes
   * the height grip from a depth grip in the DOM / tests. */
  private makeGripPair(cls: string): { grip: HTMLElement; stem: HTMLElement } {
    const container = this.map.getCanvasContainer();
    const doc = container.ownerDocument;

    const stem = doc.createElement("div");
    stem.className = `campaign-map-${cls}-stem`;
    stem.style.position = "absolute";
    stem.style.width = "0px";
    stem.style.borderLeft = `2px dashed ${this.accent}`;
    stem.style.pointerEvents = "none";
    stem.style.zIndex = "5";

    const grip = this.makeGripCore(cls, HEIGHT_GRIP_CORE_PX, this.accent, "ns-resize");

    container.appendChild(stem);
    container.appendChild(grip);
    return { grip, stem };
  }

  /** One grip element (no stem) — the shared circular DOM target the height,
   * depth, and band grips are all built from: `corePx` core, white ring,
   * `background` fill, `cursor` cue. `cls` distinguishes it in the DOM / tests.
   * Not yet parented — the caller appends it. */
  private makeGripCore(cls: string, corePx: number, background: string, cursor: string): HTMLElement {
    const doc = this.map.getCanvasContainer().ownerDocument;
    const grip = doc.createElement("div");
    grip.className = `campaign-map-${cls}-grip`;
    grip.style.position = "absolute";
    grip.style.width = `${corePx}px`;
    grip.style.height = `${corePx}px`;
    grip.style.borderRadius = "50%";
    grip.style.background = background;
    grip.style.border = `${HEIGHT_GRIP_RING_PX}px solid #ffffff`;
    grip.style.boxSizing = "content-box"; // core stays corePx; ring adds outside
    grip.style.cursor = cursor;
    grip.style.zIndex = "6";
    grip.style.touchAction = "none"; // pointer capture owns the gesture
    return grip;
  }

  /** Lazily build the height grip + dashed stem, and start tracking camera moves
   * so it stays glued to the stamp (project() is terrain-aware when terrain is
   * on). */
  private ensureHeightGrip(): void {
    if (this.gripEl) return;
    const { grip, stem } = this.makeGripPair("height");
    grip.addEventListener("pointerdown", this.onGripPointerDown);
    grip.addEventListener("mousedown", this.onGripMouseDown);
    this.stemEl = stem;
    this.gripEl = grip;
    this.gripMoveHook = () => this.repositionHeightGrip();
    this.map.on("move", this.gripMoveHook);
    this.map.on("render", this.gripMoveHook);
  }

  /** Place the grip in raw screen pixels above (or below) the terrain-projected
   * anchor, and stretch the dashed stem between them. Idle offset tracks the
   * value; mid-drag it follows the cursor (set by the pointer-move handler). */
  private repositionHeightGrip(): void {
    if (!this.gripEl || !this.stemEl || !this.edit?.height) return;
    const anchor = this.map.project(centroid(this.edit.vertices));
    if (!this.heightDrag) {
      this.gripOffsetPx = clampHeight(
        this.edit.height.value / HEIGHT_MPP_COARSE,
        -HEIGHT_REST_CAP_PX,
        HEIGHT_REST_CAP_PX
      );
    }
    const gripX = anchor.x;
    const gripY = anchor.y - this.gripOffsetPx; // +offset = up (screen −y)
    const half = HEIGHT_GRIP_OUTER_PX / 2;
    this.gripEl.style.left = `${gripX - half}px`;
    this.gripEl.style.top = `${gripY - half}px`;
    const stemTop = Math.min(anchor.y, gripY);
    this.stemEl.style.left = `${gripX - 1}px`;
    this.stemEl.style.top = `${stemTop}px`;
    this.stemEl.style.height = `${Math.abs(gripY - anchor.y)}px`;
  }

  /** Remove the grip + stem, unwire every listener, and re-enable dragPan if a
   * drag was mid-flight — no leaked DOM or handlers on deselect/teardown. */
  private removeHeightGrip(): void {
    if (this.gripMoveHook) {
      this.map.off("move", this.gripMoveHook);
      this.map.off("render", this.gripMoveHook);
      this.gripMoveHook = null;
    }
    if (this.heightDrag) {
      this.map.dragPan.enable();
      this.heightDrag = null;
    }
    if (this.gripEl) {
      this.gripEl.removeEventListener("pointerdown", this.onGripPointerDown);
      this.gripEl.removeEventListener("mousedown", this.onGripMouseDown);
      this.gripEl.removeEventListener("pointermove", this.onGripPointerMove);
      this.gripEl.removeEventListener("pointerup", this.onGripPointerUp);
      this.gripEl.removeEventListener("pointercancel", this.onGripPointerUp);
      this.gripEl.remove();
      this.gripEl = null;
    }
    this.stemEl?.remove();
    this.stemEl = null;
  }

  /** The grip DOM element (or null) — the headless-test seam for driving the
   * pointer sequence directly, mirroring `heightHandleValue` for the value. */
  get heightGripElement(): HTMLElement | null {
    return this.gripEl;
  }

  /** The dashed-stem DOM element (or null) — test seam for the ghost stem. */
  get heightStemElement(): HTMLElement | null {
    return this.stemEl;
  }

  // ── River depth-grip overlay lifecycle (plan 040 river depths) ────────────
  // Same idiom as the height grip, one grip PER spine vertex. Dragging a grip
  // DOWN deepens the carve at that vertex (`depthFromDrag`); release commits the
  // whole (monotone-clamped) depths array.

  /** Create/position the row of depth grips when a river with depths is
   * selected; tear them down otherwise. Idempotent — safe every render. */
  private syncDepthGrips(): void {
    if (this.active && this.edit?.depths && this.edit.depths.values.length === this.edit.vertices.length) {
      this.ensureDepthGrips();
      this.repositionDepthGrips();
    } else {
      this.removeDepthGrips();
    }
  }

  /** Lazily build one grip + stem per spine vertex and start tracking camera
   * moves. Each grip's pointerdown captures its vertex index. */
  private ensureDepthGrips(): void {
    if (this.depthGrips.length > 0 || !this.edit?.depths) return;
    const n = this.edit.vertices.length;
    this.depthOffsetsPx = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const { grip, stem } = this.makeGripPair("depth");
      grip.style.width = `${DEPTH_GRIP_CORE_PX}px`;
      grip.style.height = `${DEPTH_GRIP_CORE_PX}px`;
      const down = (e: PointerEvent): void => this.onDepthPointerDown(e, i);
      this.depthDownHandlers[i] = down;
      grip.addEventListener("pointerdown", down);
      grip.addEventListener("mousedown", this.onGripMouseDown);
      this.depthGrips[i] = grip;
      this.depthStems[i] = stem;
    }
    this.depthMoveHook = () => this.repositionDepthGrips();
    this.map.on("move", this.depthMoveHook);
    this.map.on("render", this.depthMoveHook);
  }

  private readonly onDepthPointerDown = (e: PointerEvent, index: number): void => {
    if (!this.edit?.depths || !this.depthGrips[index]) return;
    e.stopPropagation();
    e.preventDefault();
    const grip = this.depthGrips[index];
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* headless mock has no capture — the delta math still runs */
    }
    this.depthDrag = {
      index,
      startClientY: e.clientY,
      startValue: this.edit.depths.values[index],
      startOffsetPx: this.depthOffsetsPx[index] ?? 0,
    };
    grip.addEventListener("pointermove", this.onDepthPointerMove);
    grip.addEventListener("pointerup", this.onDepthPointerUp);
    grip.addEventListener("pointercancel", this.onDepthPointerUp);
    this.map.dragPan.disable();
  };

  private readonly onDepthPointerMove = (e: PointerEvent): void => {
    if (!this.depthDrag || !this.edit?.depths) return;
    const { index } = this.depthDrag;
    const dyDown = e.clientY - this.depthDrag.startClientY; // down = deeper
    const mpp = e.shiftKey ? DEPTH_MPP_FINE : DEPTH_MPP_COARSE;
    const v = depthFromDrag(this.depthDrag.startValue, dyDown, mpp);
    this.edit.depths.values[index] = v;
    this.depthOffsetsPx[index] = this.depthDrag.startOffsetPx + dyDown; // grip follows cursor 1:1
    this.repositionDepthGrips();
    this.handlers.onDepthDrag?.(this.edit.featureId, index, v);
  };

  private readonly onDepthPointerUp = (e: PointerEvent): void => {
    if (!this.depthDrag) return;
    const { index, startValue } = this.depthDrag;
    this.depthDrag = null;
    const grip = this.depthGrips[index];
    if (grip) {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* headless mock */
      }
      grip.removeEventListener("pointermove", this.onDepthPointerMove);
      grip.removeEventListener("pointerup", this.onDepthPointerUp);
      grip.removeEventListener("pointercancel", this.onDepthPointerUp);
    }
    this.map.dragPan.enable();
    if (this.edit?.depths) {
      const v = this.edit.depths.values[index];
      if (Math.abs(v - startValue) >= HEIGHT_DRAG_DEADZONE_M) {
        // Monotone-clamp on commit: no vertex's (flat-reference) bed sits higher
        // than the one upstream — the UI half of the downhill guarantee.
        const clamped = clampDepthsMonotone(this.edit.depths.values);
        this.edit.depths.values = clamped;
        this.handlers.onDepthCommit?.(this.edit.featureId, clamped.slice());
      } else {
        this.edit.depths.values[index] = startValue; // deadzone: treat as a click
      }
    }
    this.repositionDepthGrips();
  };

  /** Place each depth grip BELOW its vertex by its depth (screen px), and
   * stretch the dashed stem from the vertex down to it. Idle offset tracks the
   * depth; mid-drag the dragged grip follows the cursor. */
  private repositionDepthGrips(): void {
    if (!this.edit?.depths || this.depthGrips.length === 0) return;
    const values = this.edit.depths.values;
    for (let i = 0; i < this.depthGrips.length; i++) {
      const grip = this.depthGrips[i];
      const stem = this.depthStems[i];
      const vertex = this.edit.vertices[i];
      if (!grip || !stem || !vertex) continue;
      const anchor = this.map.project(vertex);
      if (!this.depthDrag || this.depthDrag.index !== i) {
        this.depthOffsetsPx[i] = clampHeight(values[i] / DEPTH_MPP_COARSE, 0, HEIGHT_REST_CAP_PX);
      }
      const offset = this.depthOffsetsPx[i] ?? 0;
      const gripX = anchor.x;
      const gripY = anchor.y + offset; // +offset = BELOW (a downward cut)
      const half = DEPTH_GRIP_OUTER_PX / 2;
      grip.style.left = `${gripX - half}px`;
      grip.style.top = `${gripY - half}px`;
      stem.style.left = `${gripX - 1}px`;
      stem.style.top = `${Math.min(anchor.y, gripY)}px`;
      stem.style.height = `${Math.abs(gripY - anchor.y)}px`;
    }
  }

  /** Remove every depth grip + stem, unwire listeners, re-enable dragPan if a
   * drag was mid-flight — no leaked DOM/handlers on deselect/teardown. */
  private removeDepthGrips(): void {
    if (this.depthMoveHook) {
      this.map.off("move", this.depthMoveHook);
      this.map.off("render", this.depthMoveHook);
      this.depthMoveHook = null;
    }
    if (this.depthDrag) {
      this.map.dragPan.enable();
      this.depthDrag = null;
    }
    for (let i = 0; i < this.depthGrips.length; i++) {
      const grip = this.depthGrips[i];
      if (!grip) continue;
      const down = this.depthDownHandlers[i];
      if (down) grip.removeEventListener("pointerdown", down);
      grip.removeEventListener("mousedown", this.onGripMouseDown);
      grip.removeEventListener("pointermove", this.onDepthPointerMove);
      grip.removeEventListener("pointerup", this.onDepthPointerUp);
      grip.removeEventListener("pointercancel", this.onDepthPointerUp);
      grip.remove();
      this.depthStems[i]?.remove();
    }
    this.depthGrips = [];
    this.depthStems = [];
    this.depthOffsetsPx = [];
    this.depthDownHandlers = [];
  }

  /** The depth-grip DOM elements — headless-test seam (one per spine vertex). */
  get depthGripElements(): HTMLElement[] {
    return this.depthGrips;
  }

  /** Current per-vertex depth values (or null) — test/readout seam. */
  get depthValues(): number[] | null {
    return this.edit?.depths?.values ?? null;
  }

  // ── Band-edge grip overlay lifecycle (plan 040 Phase 2) ───────────────────
  // One grip per draggable band edge. The grip sits ON the ghost footprint (a
  // TRUE `project` of the offset outline point), and its drag is measured along
  // the outline's SCREEN normal with metres/pixel folded from the live map
  // scale — so the grip tracks the true edge as it widens, and the ghost
  // re-offsets live (`renderDraft`). No terrain recompute until release.

  /** Create/position the band grips when a relief/landform with a band is
   * selected; tear them down otherwise. Idempotent — safe every render. */
  private syncBandGrips(): void {
    const edgeCount = this.active && this.edit?.band ? bandEdges(this.edit.kind, this.edit.band.values).length : 0;
    if (edgeCount > 0) {
      // Rebuild when the edge count changed (e.g. re-selecting relief↔landform,
      // 2 grips vs 1) — the lazy guard alone would keep the stale count.
      if (this.bandGrips.length !== edgeCount) this.removeBandGrips();
      this.ensureBandGrips();
      this.repositionBandGrips();
    } else {
      this.removeBandGrips();
    }
  }

  /** The base geometry's anchor + unit normal (planar/display units) the band
   * grips ride out along: the relief spine's mid-segment left normal, or the
   * landform ring's inward normal at edge 0. */
  private bandAnchorNormal(): { anchor: PlanarPt; normal: PlanarPt } {
    if (this.edit?.kind === "landform") return ringInsetNormal(this.edit.vertices);
    return polylineMidNormal(this.edit?.vertices ?? []);
  }

  private ensureBandGrips(): void {
    if (this.bandGrips.length > 0 || !this.edit?.band) return;
    const edges = bandEdges(this.edit.kind, this.edit.band.values);
    for (let i = 0; i < edges.length; i++) {
      const grip = this.makeGripCore("band", BAND_GRIP_CORE_PX, "#ffffff", "move");
      // Hollow (white core, accent ring) so a band grip reads distinctly from
      // the filled vertex dots and the terrain-stamp height grip.
      grip.style.border = `2px solid ${this.accent}`;
      const down = (e: PointerEvent): void => this.onBandPointerDown(e, i);
      this.bandDownHandlers[i] = down;
      grip.addEventListener("pointerdown", down);
      grip.addEventListener("mousedown", this.onGripMouseDown);
      this.map.getCanvasContainer().appendChild(grip);
      this.bandGrips[i] = grip;
    }
    this.bandMoveHook = () => this.repositionBandGrips();
    this.map.on("move", this.bandMoveHook);
    this.map.on("render", this.bandMoveHook);
  }

  private readonly onBandPointerDown = (e: PointerEvent, index: number): void => {
    if (!this.edit?.band || !this.bandGrips[index]) return;
    const edges = bandEdges(this.edit.kind, this.edit.band.values);
    const edge = edges[index];
    if (!edge) return;
    e.stopPropagation();
    e.preventDefault();
    const grip = this.bandGrips[index];
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* headless mock has no capture — the delta math still runs */
    }
    // Capture the outline's screen normal + metres/pixel at grab (constant for
    // the drag — the camera is fixed while dragging). project() is terrain-aware
    // when terrain is on, so the grip tracks the ground band under a pitch.
    const { anchor, normal } = this.bandAnchorNormal();
    const a = this.map.project(anchor);
    const b = this.map.project([anchor[0] + normal[0], anchor[1] + normal[1]]);
    const rawX = b.x - a.x;
    const rawY = b.y - a.y;
    const pxPerUnit = Math.hypot(rawX, rawY) || 1;
    this.bandDrag = {
      index,
      param: edge.param,
      startClientX: e.clientX,
      startClientY: e.clientY,
      screenNormal: [rawX / pxPerUnit, rawY / pxPerUnit],
      metresPerPixel: this.edit.band.metersPerUnit / pxPerUnit,
      startOffset: edge.offsetMeters,
      startValues: { ...this.edit.band.values },
    };
    grip.addEventListener("pointermove", this.onBandPointerMove);
    grip.addEventListener("pointerup", this.onBandPointerUp);
    grip.addEventListener("pointercancel", this.onBandPointerUp);
    this.map.dragPan.disable();
  };

  private readonly onBandPointerMove = (e: PointerEvent): void => {
    if (!this.bandDrag || !this.edit?.band) return;
    const { param, screenNormal, metresPerPixel, startOffset, startValues } = this.bandDrag;
    // Signed pixel travel along the outward screen normal (widen = positive).
    const deltaPx = (e.clientX - this.bandDrag.startClientX) * screenNormal[0] + (e.clientY - this.bandDrag.startClientY) * screenNormal[1];
    // Bounds are stable against the drag's start params (halfWidth doesn't move
    // under an apron drag).
    const edge = bandEdges(this.edit.kind, startValues).find((x) => x.param === param);
    if (!edge) return;
    const offset = offsetFromBandDrag(startOffset, deltaPx, metresPerPixel, edge.minOffset, edge.maxOffset);
    const upd = bandParamFromOffset(param, offset, startValues.halfWidth ?? 0);
    this.edit.band.values[upd.key] = upd.value;
    this.renderDraft(); // live ghost re-offset + grip reposition (no regen)
    this.handlers.onBandDrag?.(this.edit.featureId, param, upd.value);
  };

  private readonly onBandPointerUp = (e: PointerEvent): void => {
    if (!this.bandDrag) return;
    const { index, param, startValues } = this.bandDrag;
    this.bandDrag = null;
    const grip = this.bandGrips[index];
    if (grip) {
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* headless mock */
      }
      grip.removeEventListener("pointermove", this.onBandPointerMove);
      grip.removeEventListener("pointerup", this.onBandPointerUp);
      grip.removeEventListener("pointercancel", this.onBandPointerUp);
    }
    this.map.dragPan.enable();
    if (this.edit?.band) {
      const value = this.edit.band.values[param] ?? 0;
      if (Math.abs(value - (startValues[param] ?? 0)) >= BAND_DRAG_DEADZONE_M) {
        this.handlers.onBandCommit?.(this.edit.featureId, { [param]: value });
      } else {
        this.edit.band.values = { ...startValues }; // deadzone: treat as a click
      }
    }
    this.renderDraft();
  };

  /** Place each band grip on its ghost outline: `project(anchor + normal ·
   * offsetUnits)`. Recomputed every render from the live param values, so a
   * halfWidth drag slides the apron grip out with it. */
  private repositionBandGrips(): void {
    if (!this.edit?.band || this.bandGrips.length === 0) return;
    const edges = bandEdges(this.edit.kind, this.edit.band.values);
    const { anchor, normal } = this.bandAnchorNormal();
    const metersPerUnit = this.edit.band.metersPerUnit;
    const half = BAND_GRIP_OUTER_PX / 2;
    for (let i = 0; i < this.bandGrips.length; i++) {
      const grip = this.bandGrips[i];
      const edge = edges[i];
      if (!grip || !edge) continue;
      // Landform grips ride the CLAMPED inset ring (`safeInsetDistance`) so the
      // grip stays on the drawn ghost even when the band exceeds the polygon —
      // the readout still shows the true metres. Relief corridors never invert.
      const rawUnits = edge.offsetMeters / metersPerUnit;
      const offUnits = this.edit.kind === "landform" ? safeInsetDistance(this.edit.vertices, rawUnits) : rawUnits;
      const p = this.map.project([anchor[0] + normal[0] * offUnits, anchor[1] + normal[1] * offUnits]);
      grip.style.left = `${p.x - half}px`;
      grip.style.top = `${p.y - half}px`;
    }
  }

  /** Remove every band grip, unwire listeners, re-enable dragPan if a drag was
   * mid-flight — no leaked DOM/handlers on deselect/teardown. */
  private removeBandGrips(): void {
    if (this.bandMoveHook) {
      this.map.off("move", this.bandMoveHook);
      this.map.off("render", this.bandMoveHook);
      this.bandMoveHook = null;
    }
    if (this.bandDrag) {
      this.map.dragPan.enable();
      this.bandDrag = null;
    }
    for (let i = 0; i < this.bandGrips.length; i++) {
      const grip = this.bandGrips[i];
      if (!grip) continue;
      const down = this.bandDownHandlers[i];
      if (down) grip.removeEventListener("pointerdown", down);
      grip.removeEventListener("mousedown", this.onGripMouseDown);
      grip.removeEventListener("pointermove", this.onBandPointerMove);
      grip.removeEventListener("pointerup", this.onBandPointerUp);
      grip.removeEventListener("pointercancel", this.onBandPointerUp);
      grip.remove();
    }
    this.bandGrips = [];
    this.bandDownHandlers = [];
  }

  /** The band-grip DOM elements — headless-test seam (relief: 2, landform: 1). */
  get bandGripElements(): HTMLElement[] {
    return this.bandGrips;
  }

  /** Current live band param values (or null) — test/readout seam. */
  get bandParamValues(): Record<string, number> | null {
    return this.edit?.band?.values ?? null;
  }
}

/** Open vertex list (no closing duplicate) of a fabric geometry. Mirrors
 * `fabric.editableVertices` but stays local so the controller has no model
 * import cycle beyond the types it already uses. */
/** Arithmetic mean of a vertex list — the height grip's anchor. Empty ⇒ origin
 * (never reached: an edit always has ≥ min vertices). */
function centroid(pts: Pt[]): Pt {
  if (pts.length === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  return [sx / pts.length, sy / pts.length];
}

function openVertices(geom: FabricGeometry): Pt[] {
  if (geom.type === "Polygon") {
    const ring = geom.coordinates[0];
    if (ring.length >= 2) {
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1) as Pt[];
    }
    return [...ring] as Pt[];
  }
  return [...geom.coordinates] as Pt[];
}

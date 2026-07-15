import type { Map as MapLibreMap, MapMouseEvent, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import { isPolygonKind, minVerticesFor, type FabricGeometry, type FabricKind } from "../model/fabric";
import {
  HEIGHT_MPP_COARSE,
  HEIGHT_MPP_FINE,
  HEIGHT_DRAG_DEADZONE_M,
  valueFromDrag,
  clampHeight,
} from "./heightHandle";

const DRAFT_SOURCE = "fabric-draft";
const DRAFT_LAYERS = [
  "fabric-draft-fill",
  "fabric-draft-line",
  "fabric-draft-midpoint",
  "fabric-draft-vertex",
  "fabric-draft-center",
] as const;
/** Handle layers hit-tested during a vertex/midpoint/center grab. The extrude
 * grip is NOT here — it is a screen-space DOM overlay (see the grip section
 * below), never a draped GeoJSON feature. */
const HANDLE_LAYERS = ["fabric-draft-center", "fabric-draft-vertex", "fabric-draft-midpoint"];
/** Idle grip offset (px) from the anchor caps here so a tall stamp's grip
 * stays on screen; during a drag the grip follows the cursor 1:1. */
const HEIGHT_REST_CAP_PX = 100;
/** Extrude-grip core diameter (px) + its white ring — the r11-scale prominence
 * of the old circle-radius:11 grip, now the largest deliberate DOM target
 * (core ≥ 22 px per the plan-040 bar). */
const HEIGHT_GRIP_CORE_PX = 22;
const HEIGHT_GRIP_RING_PX = 4;
const HEIGHT_GRIP_OUTER_PX = HEIGHT_GRIP_CORE_PX + HEIGHT_GRIP_RING_PX * 2;

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
    const hit = this.handleAt(e.point.x, e.point.y);
    this.hoverVertexIndex = hit && hit.handle === "vertex" ? hit.index : null;
    // The extrude grip owns its own ns-resize cursor (it is a DOM element); the
    // map-canvas hit-test only cues the move handles now.
    this.map.getCanvas().style.cursor = hit ? "move" : "";
  };

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
  }): void {
    this.vertices = [];
    this.cursor = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.draggingCenter = false;
    this.heightDrag = null;
    this.edit = {
      featureId: feature.id,
      type: feature.geometry.type,
      kind: feature.kind,
      vertices: openVertices(feature.geometry),
      center: feature.center ?? null,
      height: feature.height ?? null,
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
        filter: ["!=", ["geometry-type"], "Point"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": this.accent,
          "line-width": 2,
          "line-dasharray": [2, 2],
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

  /** Lazily build the grip + dashed stem as absolutely-positioned children of
   * the map's canvas container (project() space), and start tracking camera
   * moves. Inline-styled so it needs no stylesheet — the accent core + white
   * ring reproduce the old circle-radius:11 grip's visual language in 2D. */
  private ensureHeightGrip(): void {
    if (this.gripEl) return;
    const container = this.map.getCanvasContainer();
    const doc = container.ownerDocument;

    const stem = doc.createElement("div");
    stem.className = "campaign-map-height-stem";
    stem.style.position = "absolute";
    stem.style.width = "0px";
    stem.style.borderLeft = `2px dashed ${this.accent}`;
    stem.style.pointerEvents = "none";
    stem.style.zIndex = "5";

    const grip = doc.createElement("div");
    grip.className = "campaign-map-height-grip";
    grip.style.position = "absolute";
    grip.style.width = `${HEIGHT_GRIP_CORE_PX}px`;
    grip.style.height = `${HEIGHT_GRIP_CORE_PX}px`;
    grip.style.borderRadius = "50%";
    grip.style.background = this.accent;
    grip.style.border = `${HEIGHT_GRIP_RING_PX}px solid #ffffff`;
    grip.style.boxSizing = "content-box"; // core stays 22px; ring adds outside
    grip.style.cursor = "ns-resize"; // the vertical-drag cue, now grip-owned
    grip.style.zIndex = "6";
    grip.style.touchAction = "none"; // pointer capture owns the gesture
    grip.addEventListener("pointerdown", this.onGripPointerDown);
    grip.addEventListener("mousedown", this.onGripMouseDown);

    container.appendChild(stem);
    container.appendChild(grip);
    this.stemEl = stem;
    this.gripEl = grip;

    // Reproject the anchor on every camera move (pan/zoom/pitch/rotate) and on
    // render (terrain elevation settling) so the grip stays glued to the stamp
    // — project() is terrain-aware when terrain is on.
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

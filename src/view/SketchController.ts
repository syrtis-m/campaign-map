import type { Map as MapLibreMap, MapMouseEvent, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import { isPolygonKind, minVerticesFor, type FabricGeometry, type FabricKind } from "../model/fabric";

const DRAFT_SOURCE = "fabric-draft";
const DRAFT_LAYERS = [
  "fabric-draft-fill",
  "fabric-draft-line",
  "fabric-draft-midpoint",
  "fabric-draft-vertex",
  "fabric-draft-center",
] as const;
/** Handle layers hit-tested during a vertex/midpoint/center grab. */
const HANDLE_LAYERS = ["fabric-draft-center", "fabric-draft-vertex", "fabric-draft-midpoint"];

type Pt = [number, number];

/** What the controller reports back to the host on a committed edit — a
 * whole-feature geometry replacement (MapView turns it into a `sketch-edit`
 * mutation-log entry + persist + regen). */
export interface SketchControllerHandlers {
  onGeometryEdit(featureId: string, geometry: FabricGeometry): void;
  /** Drag-commit of a procgen region's generation center, display units. Only
   * regions pass a center to `select`. */
  onCenterEdit?(featureId: string, center: Pt): void;
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
    const cvs = this.map.getCanvas();
    cvs.style.cursor = hit ? "move" : "";
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

  /** Switching kind mid-draw discards the in-progress draft (a road half-
   * drawn as a river has no coherent meaning); an active selection is kept. */
  setKind(kind: FabricKind): void {
    if (this.kind !== kind && this.isDrawing) this.cancel();
    this.kind = kind;
  }

  /** Switch between the draw palette and the Select arrow. Leaving Select
   * clears the edit selection; entering it cancels any in-progress draft. */
  setTool(tool: "draw" | "select"): void {
    if (this.tool === tool) return;
    if (tool === "select") this.cancel();
    else this.clearSelection();
    this.tool = tool;
    this.applyToolCursor();
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
  select(feature: { id: string; geometry: FabricGeometry; kind: FabricKind; center?: Pt | null }): void {
    this.vertices = [];
    this.cursor = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.draggingCenter = false;
    this.edit = {
      featureId: feature.id,
      type: feature.geometry.type,
      kind: feature.kind,
      vertices: openVertices(feature.geometry),
      center: feature.center ?? null,
    };
    this.renderDraft();
  }

  clearSelection(): void {
    this.edit = null;
    this.dragVertexIndex = null;
    this.hoverVertexIndex = null;
    this.draggingCenter = false;
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
  private handleAt(x: number, y: number): { handle: "vertex" | "midpoint" | "center"; index: number } | null {
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
      // midpoint on a near-tie (center is the big deliberate target).
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
  }
}

/** Open vertex list (no closing duplicate) of a fabric geometry. Mirrors
 * `fabric.editableVertices` but stays local so the controller has no model
 * import cycle beyond the types it already uses. */
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

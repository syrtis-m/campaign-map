import type { Map as MapLibreMap, MapMouseEvent, GeoJSONSource, LayerSpecification } from "maplibre-gl";
import { isPolygonKind, type FabricKind } from "../model/fabric";

const DRAFT_SOURCE = "fabric-draft";
const DRAFT_LAYERS = ["fabric-draft-fill", "fabric-draft-line", "fabric-draft-vertex"] as const;

/**
 * Hand-rolled draw controller (plan 013 v1: straight-segment line + polygon —
 * click to add a vertex, double-click/Enter to finish, Esc to cancel; NO
 * vertex re-edit, NO snapping, both explicitly deferred). Renders a live
 * preview (plus a rubber-band segment to the cursor) through a temp
 * `fabric-draft` geojson source it owns — added lazily so a theme switch's
 * setStyle wiping it is self-healing on the next render.
 *
 * It doesn't listen for map clicks itself: MapView's `handleClick` routes to
 * `addVertex()` while sketch mode is on, so there's exactly one click
 * pipeline and the normal pin/popup handlers are cleanly suspended rather
 * than racing this controller (the plan's STOP-condition concern).
 */
export class SketchController {
  private vertices: [number, number][] = [];
  private cursor: [number, number] | null = null;
  private kind: FabricKind = "road";
  private selectedGeometry: GeoJSON.Geometry | null = null;
  private active = false;

  private readonly moveHandler = (e: MapMouseEvent): void => {
    if (!this.isDrawing) return;
    this.cursor = [e.lngLat.lng, e.lngLat.lat];
    this.renderDraft();
  };

  constructor(
    private map: MapLibreMap,
    private accent: string
  ) {}

  get isDrawing(): boolean {
    return this.vertices.length > 0;
  }

  get currentKind(): FabricKind {
    return this.kind;
  }

  activate(kind: FabricKind): void {
    this.kind = kind;
    this.active = true;
    this.ensureDraftInfra();
    this.map.on("mousemove", this.moveHandler);
    this.map.getCanvas().style.cursor = "crosshair";
  }

  /** Switching kind mid-draw discards the in-progress draft (a road half-
   * drawn as a river has no coherent meaning); selection is kept. */
  setKind(kind: FabricKind): void {
    if (this.kind !== kind && this.isDrawing) this.cancel();
    this.kind = kind;
  }

  deactivate(): void {
    this.active = false;
    this.vertices = [];
    this.cursor = null;
    this.selectedGeometry = null;
    this.map.off("mousemove", this.moveHandler);
    this.map.getCanvas().style.cursor = "";
    for (const id of DRAFT_LAYERS) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource(DRAFT_SOURCE)) this.map.removeSource(DRAFT_SOURCE);
  }

  addVertex(lngLat: [number, number]): void {
    if (!this.active) return;
    this.selectedGeometry = null;
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
  finish(): GeoJSON.LineString | GeoJSON.Polygon | null {
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

  /** Highlights an existing fabric feature (select-to-delete). Draft and
   * selection share the preview source — starting a new draft clears the
   * selection (see addVertex), so the two states never overlap. */
  showSelection(geometry: GeoJSON.Geometry): void {
    this.selectedGeometry = geometry;
    this.renderDraft();
  }

  clearSelection(): void {
    this.selectedGeometry = null;
    this.renderDraft();
  }

  /** Lazily (re)creates the draft source + preview layers — also self-heals
   * after a theme switch's setStyle wipes user-added sources/layers. */
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
        id: "fabric-draft-vertex",
        type: "circle",
        source: DRAFT_SOURCE,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": this.accent,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
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

    if (this.selectedGeometry) {
      features.push({ type: "Feature", geometry: this.selectedGeometry, properties: {} });
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

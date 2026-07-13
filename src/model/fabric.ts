import { z } from "zod";

/**
 * Sketched fabric (plans 013/019) — "things on the map": background geometry
 * the GM draws directly (roads, walls, rivers, water, districts, parks),
 * stored in ONE per-campaign `Fabric.geojson` (no note-per-feature clutter).
 * Fabric is a separate layer from Locations (note-backed places) and never
 * promotes to one — the two-layer model of plan 019. This file is pure (zod
 * only — no DOM/map/Obsidian imports) so generators can read fabric features
 * as constraints headlessly.
 */
export const FABRIC_KINDS = ["road", "wall", "river", "water", "district", "park"] as const;
export type FabricKind = (typeof FABRIC_KINDS)[number];

/** line kinds: road, wall, river ; polygon kinds: water, district, park */
export function isPolygonKind(kind: FabricKind): boolean {
  return kind === "water" || kind === "district" || kind === "park";
}

const Position = z.tuple([z.number(), z.number()]);
const LineStringGeom = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(Position).min(2),
});
// GeoJSON ring: ≥4 positions, first === last (closure is enforced by the draw
// controller / generators, not re-validated positionally here).
const PolygonGeom = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(Position).min(4)).min(1),
});

/**
 * Procgen block (plan 020 §3.1): a fabric feature WITH this block is a
 * procgen region — its polygon is the container a registry algorithm
 * generates inside (district → city). Without one it is an inert overlay
 * shape. `seed` is computed once at creation and persisted — vertex edits
 * never change it (the city keeps its identity while its boundary adapts);
 * only an explicit re-roll replaces it. `params` is validated by the
 * algorithm's own zod schema (src/gen/procgen/registry.ts), not here.
 * The whole block is optional so pre-020 Fabric.geojson files parse
 * unchanged.
 */
export const ProcgenBlockSchema = z.object({
  algorithm: z.string().min(1), // registry id, e.g. "city"
  seed: z.number().int(),
  version: z.number().int().default(1), // schema version of `params`
  params: z.record(z.string(), z.unknown()),
  /** Plan 022 §1: the "template" the params were seeded from — DISPLAY ONLY.
   * Optional so legacy blocks (and city blocks, whose params always match a
   * preset) parse and persist unchanged; a generator NEVER reads it (params
   * are the whole truth for determinism). Written solely on an explicit GM
   * template-pick, never back-filled on load/render/regen. */
  presetId: z.string().optional(),
});
export type ProcgenBlock = z.infer<typeof ProcgenBlockSchema>;

export const FabricFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string().min(1), // stable id for select/delete/undo
  geometry: z.union([LineStringGeom, PolygonGeom]),
  properties: z.object({
    kind: z.enum(FABRIC_KINDS),
    name: z.string().optional(),
    minZoom: z.number().optional(), // per-feature override; else per-kind default
    /** DEPRECATED (plan 019): every sketched feature now feeds the
     * generators as a constraint, so the plan-014 literal/generate split is
     * gone. Kept in the schema only so pre-019 Fabric.geojson files still
     * parse; nothing reads it. */
    mode: z.enum(["literal", "generate"]).optional(),
    /** Plan 020 §3.1: present ⇔ this shape drives a procgen algorithm. */
    procgen: ProcgenBlockSchema.optional(),
  }),
});
export type FabricFeature = z.infer<typeof FabricFeatureSchema>;
/** Tuple-position geometry (narrower than GeoJSON.Geometry's `Position[]`) —
 * the draw controller and generators produce this shape directly. */
export type FabricGeometry = FabricFeature["geometry"];

export const FabricCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(FabricFeatureSchema),
});
export type FabricCollection = z.infer<typeof FabricCollectionSchema>;
// NOTE: fabric has NO zoom-based LOD — every kind renders at every zoom
// (Jonah's decision after the Kanto test: "LOD should only impact visibility of
// location names"). The former per-kind `DEFAULT_FABRIC_MINZOOM` /
// `FABRIC_REVEAL_OFFSET` machinery is gone; the fabric layers carry no `minzoom`.

export function emptyFabric(): FabricCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Unique id for a hand-drawn feature. Hand-drawn ≠ generated: determinism
 * (CLAUDE.md) governs *generators*; a GM's sketch is canon input, so a
 * time+random id is correct here (and never feeds a seeded hash). */
export function makeFabricId(): string {
  return `fabric-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pure append (replaces an existing feature with the same id, so undo-restore
 * after a re-add can't duplicate). */
export function withFeature(fabric: FabricCollection, feature: FabricFeature): FabricCollection {
  return {
    type: "FeatureCollection",
    features: [...fabric.features.filter((f) => f.id !== feature.id), feature],
  };
}

/** Pure remove-by-id; a no-op collection copy if the id isn't present. */
export function withoutFeature(fabric: FabricCollection, id: string): FabricCollection {
  return { type: "FeatureCollection", features: fabric.features.filter((f) => f.id !== id) };
}

/** Pure copy of `feature` with the procgen block attached (plan 020 §3.1 —
 * the host's `sketch-procgen-set` path). Never mutates its input. */
export function withProcgen(feature: FabricFeature, block: ProcgenBlock): FabricFeature {
  return { ...feature, properties: { ...feature.properties, procgen: block } };
}

/** Pure copy of `feature` with the procgen block removed (the
 * `sketch-procgen-clear` path) — the shape stays, inert. */
export function withoutProcgen(feature: FabricFeature): FabricFeature {
  const { procgen: _procgen, ...rest } = feature.properties;
  return { ...feature, properties: rest };
}

/** A feature with a procgen block IS a procgen region (plan 020 §3.1). */
export function isProcgenRegion(feature: FabricFeature): boolean {
  return feature.properties.procgen !== undefined;
}

// ─── Pure vertex-edit geometry ops (plan 020 §9) ──────────────────────────
// The single source of truth for how the PowerPoint-style edit tool and the
// gate's programmatic test API move/insert/delete vertices — so an interactive
// drag and `moveVertex(id, i, pt)` produce byte-identical geometry. All pure:
// polygon closure (first === last) is preserved; line geometry is edited in
// place. `editableVertices` returns the OPEN list (no closing duplicate) that
// both the handles and these ops index into.

type Pt = [number, number];

/** Minimum vertices a kind's geometry may hold (line 2 / polygon 3), counting
 * the OPEN ring (the closing duplicate is not a distinct vertex). */
export function minVerticesFor(geom: FabricGeometry): number {
  return geom.type === "Polygon" ? 3 : 2;
}

/** The editable (open) vertex list: a polygon's ring minus its closing
 * duplicate, or a line's coordinates as-is. Indices returned here are the
 * `vertexIndex` the edit ops and handles use. */
export function editableVertices(geom: FabricGeometry): Pt[] {
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

/** Rebuild a FabricGeometry of the same type from an open vertex list
 * (re-closing a polygon ring). */
function geometryFromVertices(type: FabricGeometry["type"], open: Pt[]): FabricGeometry {
  if (type === "Polygon") {
    return { type: "Polygon", coordinates: [[...open, open[0]]] };
  }
  return { type: "LineString", coordinates: [...open] };
}

/** Move vertex `index` (open-list index) to `pt`. Out-of-range index → geom
 * returned unchanged (defensive; the caller validated the handle). */
export function withVertexMoved(geom: FabricGeometry, index: number, pt: Pt): FabricGeometry {
  const open = editableVertices(geom);
  if (index < 0 || index >= open.length) return geom;
  open[index] = [pt[0], pt[1]];
  return geometryFromVertices(geom.type, open);
}

/** Insert `pt` after open-list index `edgeIndex` (i.e. on the edge from
 * `edgeIndex` to its successor — the closing edge for a polygon when
 * `edgeIndex === n-1`). The new vertex's open-list index is `edgeIndex + 1`. */
export function withVertexInserted(geom: FabricGeometry, edgeIndex: number, pt: Pt): FabricGeometry {
  const open = editableVertices(geom);
  const at = Math.max(0, Math.min(open.length, edgeIndex + 1));
  open.splice(at, 0, [pt[0], pt[1]]);
  return geometryFromVertices(geom.type, open);
}

/** True iff deleting one vertex keeps the geometry at/above its min-vertex
 * floor (line ≥2, polygon ≥3). */
export function canDeleteVertex(geom: FabricGeometry): boolean {
  return editableVertices(geom).length > minVerticesFor(geom);
}

/** Delete vertex `index` (open-list index). Returns the geometry unchanged if
 * that would drop below the min-vertex floor or the index is out of range. */
export function withVertexDeleted(geom: FabricGeometry, index: number): FabricGeometry {
  const open = editableVertices(geom);
  if (index < 0 || index >= open.length || open.length <= minVerticesFor(geom)) return geom;
  open.splice(index, 1);
  return geometryFromVertices(geom.type, open);
}

/** Midpoints of every editable edge, for rendering insert handles. Edge `i`
 * runs from open vertex `i` to its successor (the closing edge for a polygon
 * is edge `n-1`, from the last open vertex back to the first). A line has
 * `n-1` edges; a polygon has `n`. */
export function edgeMidpoints(geom: FabricGeometry): { edgeIndex: number; point: Pt }[] {
  const open = editableVertices(geom);
  const out: { edgeIndex: number; point: Pt }[] = [];
  const edgeCount = geom.type === "Polygon" ? open.length : open.length - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = open[i];
    const b = open[(i + 1) % open.length];
    out.push({ edgeIndex: i, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return out;
}

/**
 * IO-boundary parse (CLAUDE.md: validate at every IO boundary; bad data →
 * warning, never silent drop). Salvages per-feature: a single malformed
 * feature doesn't discard the rest of the GM's sketches — it's skipped and
 * counted so the caller can surface a warning.
 */
export function parseFabric(raw: string): { fabric: FabricCollection; invalidCount: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fabric: emptyFabric(), invalidCount: 1 };
  }
  const whole = FabricCollectionSchema.safeParse(parsed);
  if (whole.success) return { fabric: whole.data, invalidCount: 0 };

  const maybe = parsed as { type?: unknown; features?: unknown };
  if (maybe?.type !== "FeatureCollection" || !Array.isArray(maybe.features)) {
    return { fabric: emptyFabric(), invalidCount: 1 };
  }
  const features: FabricFeature[] = [];
  let invalidCount = 0;
  for (const f of maybe.features) {
    const one = FabricFeatureSchema.safeParse(f);
    if (one.success) features.push(one.data);
    else invalidCount++;
  }
  return { fabric: { type: "FeatureCollection", features }, invalidCount };
}

/** Minimal shape of a mutation-log entry this module needs (kept structural so
 * fabric.ts stays a pure leaf — no import from mutationLog / Obsidian). */
export interface SketchLogEntryLike {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Undo target for sketch mode (plan 016): the most-recently-added sketch
 * feature that is still "live" — i.e. netting each `sketch-add` against any
 * later `sketch-remove` of the same id. The mutation log is the source of
 * truth (CLAUDE.md), so undo is derived from it rather than in-memory state,
 * and it survives a view reopen. Returns null when nothing is left to undo.
 */
export function sketchUndoTarget(entries: SketchLogEntryLike[]): FabricFeature | null {
  const live = new Map<string, FabricFeature>();
  const order: string[] = [];
  for (const e of entries) {
    const parsed = FabricFeatureSchema.safeParse(e.data);
    if (!parsed.success) continue;
    const id = parsed.data.id;
    if (e.type === "sketch-add") {
      if (!live.has(id)) order.push(id);
      live.set(id, parsed.data);
    } else if (e.type === "sketch-remove") {
      live.delete(id);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const f = live.get(order[i]);
    if (f) return f;
  }
  return null;
}

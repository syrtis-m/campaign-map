import { z } from "zod";

/**
 * Sketched city fabric (plan 013, Phase 6) — non-location map geometry the GM
 * draws directly (roads, walls, rivers, water, districts, parks). ONE
 * promotable per-campaign `Fabric.geojson` (no note-per-feature clutter);
 * individual features can be promoted to a location note when they deserve
 * lore. This file is pure (zod only — no DOM/map/Obsidian imports) so plan
 * 014's generators can read fabric features as constraints headlessly.
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

export const FabricFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string().min(1), // stable id for select/delete/undo
  geometry: z.union([LineStringGeom, PolygonGeom]),
  properties: z.object({
    kind: z.enum(FABRIC_KINDS),
    name: z.string().optional(),
    minZoom: z.number().optional(), // per-feature override; else per-kind default
    /** Plan 014: "literal" (default) renders the sketch as-is; "generate"
     * additionally feeds it to the procedural generators as a constraint
     * (e.g. a road corridor elaborated into a street network). The sketch
     * stays canon either way — generated output is regenerable cache. */
    mode: z.enum(["literal", "generate"]).optional(),
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

/**
 * Per-kind default min-zoom (LOD discipline — the load-bearing constraint of
 * plan 013): a road network drawn at z14 must not become an unreadable tangle
 * at z7. Major rivers/water/districts read earlier (lower z); walls/parks are
 * detail that only appears close-in.
 */
export const DEFAULT_FABRIC_MINZOOM: Record<FabricKind, number> = {
  river: 4,
  water: 4,
  district: 6,
  road: 8,
  park: 10,
  wall: 11,
};

export function defaultMinZoomFor(kind: FabricKind): number {
  return DEFAULT_FABRIC_MINZOOM[kind];
}

/**
 * Per-kind fabric reveal offset RELATIVE to the campaign's overview zoom — the
 * fix for "I can't see my parks/walls." The baked `DEFAULT_FABRIC_MINZOOM` above
 * is absolute and calibrated for a real city (overview ~z11), so on a fictional
 * world (overview ~z5) the finest kinds (park 10, wall 11) sit far beyond any
 * zoom the GM actually uses and never render. Instead, MapView applies
 * `overview + offset` per kind at runtime via `setLayerZoomRange` (same trick as
 * the depth-of-field label reveal), so every campaign — fictional or real — gets
 * the same coarse→fine LOD: water/river at the overview, walls/parks a couple
 * levels in. Compressed spread (≤2) so all six appear within a gentle zoom-in
 * rather than requiring extreme close-up. Absolute values remain the fallback
 * for offscreen export (no live overview).
 */
export const FABRIC_REVEAL_OFFSET: Record<FabricKind, number> = {
  water: 0,
  river: 0,
  district: 0.5,
  road: 1,
  park: 1.5,
  wall: 2,
};

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

import { z } from "zod";

/**
 * Type taxonomy defaults (docs/06 §3, pinned — not to be reinvented per campaign).
 * importance: 1 = highest (rendered/labeled first, wins collisions).
 * zoom: [min, max] visible range; max=Infinity means "and up".
 */
export interface TypeDefaults {
  importance: number;
  zoomMin: number;
  zoomMax: number;
}

export const TYPE_TAXONOMY: Record<string, TypeDefaults> = {
  "nation/region": { importance: 1, zoomMin: 2, zoomMax: 8 },
  city: { importance: 2, zoomMin: 5, zoomMax: 12 },
  town: { importance: 3, zoomMin: 7, zoomMax: 13 },
  village: { importance: 4, zoomMin: 9, zoomMax: 14 },
  route: { importance: 3, zoomMin: 5, zoomMax: 13 },
  "water-feature": { importance: 2, zoomMin: 3, zoomMax: 12 },
  district: { importance: 4, zoomMin: 11, zoomMax: 16 },
  "street(named)": { importance: 5, zoomMin: 13, zoomMax: 24 },
  landmark: { importance: 4, zoomMin: 10, zoomMax: 24 },
  "shop/tavern/venue": { importance: 6, zoomMin: 14, zoomMax: 24 },
  "residence/minor": { importance: 7, zoomMin: 16, zoomMax: 24 },
  custom: { importance: 5, zoomMin: 12, zoomMax: 24 },
};

export const LOCATION_TYPES = Object.keys(TYPE_TAXONOMY) as [string, ...string[]];

export function typeDefaults(type: string): TypeDefaults {
  return TYPE_TAXONOMY[type] ?? TYPE_TAXONOMY.custom;
}

/**
 * Depth-of-field label buckets (the whole zoom-legibility model — replaces the
 * former per-type continuous zoomMin/zoomMax label gating, which was too fiddly
 * to reason about; see docs/06 §3 + DECISIONS). The map has three fixed "focus
 * levels" (Wide / Mid / Close, computed per-campaign from its overview zoom);
 * a location's DOT is always drawn at every zoom (the always-present "bokeh"),
 * and this bucket decides at how many focus levels its NAME is legible:
 *   deep    — named at all three focus levels (the big anchors; deep field)
 *   medium  — named from the Mid level inward
 *   shallow — named only at the Close level (fine grain; shallow field)
 * Reveal is nested (zoom in → more names light up). Genre-neutral by design:
 * the same three words describe a fantasy world, a real city, and a neon sprawl.
 */
export const FOCUS_DEPTHS = ["deep", "medium", "shallow"] as const;
export type FocusDepth = (typeof FOCUS_DEPTHS)[number];

const TYPE_FOCUS: Record<string, FocusDepth> = {
  "nation/region": "deep",
  city: "deep",
  "water-feature": "deep", // rivers/seas are region-scale anchors — named from the Wide view
  town: "medium",
  village: "medium",
  route: "medium",
  district: "medium",
  landmark: "medium",
  custom: "medium",
  "street(named)": "shallow",
  "shop/tavern/venue": "shallow",
  "residence/minor": "shallow",
};

export function focusForType(type: string): FocusDepth {
  return TYPE_FOCUS[type] ?? "medium";
}

const PointGeometry = z.tuple([z.number(), z.number()]);

const ConnectionSchema = z.union([
  z.string().min(1),
  z.object({ to: z.string().min(1), type: z.string().optional(), label: z.string().optional() }),
]);

export const LocationFrontmatterSchema = z.object({
  map: z.string().min(1),
  geometry: z.union([PointGeometry, z.string().min(1)]), // point, or path to sidecar .geojson
  type: z.string().min(1).default("custom"),
  aliases: z.array(z.string()).optional(),
  importance: z.number().int().min(1).max(9).optional(),
  "zoom-range": z.tuple([z.number(), z.number()]).optional(), // legacy; no longer gates labels
  focus: z.enum(FOCUS_DEPTHS).optional(), // per-note override of the type's depth-of-field bucket
  icon: z.string().optional(),
  connections: z.array(ConnectionSchema).optional(),
});

export type LocationFrontmatter = z.infer<typeof LocationFrontmatterSchema>;

export interface ParsedLocation {
  id: string; // vault path, stable per-note identity
  name: string; // note basename
  path: string;
  campaignId: string;
  point: [number, number] | null; // resolved point geometry; null if sidecar-only (not yet loaded)
  geometryRef: string | null; // sidecar path, if geometry is a string
  type: string;
  importance: number;
  focus: FocusDepth;
  zoomMin: number;
  zoomMax: number;
  aliases: string[];
  icon: string | null;
  connections: { to: string; type: string | null; label: string | null }[];
}

export interface LocationParseError {
  path: string;
  name: string;
  issues: string[];
}

export function parseLocationNote(
  path: string,
  name: string,
  frontmatter: unknown
):
  | { ok: true; location: ParsedLocation }
  | { ok: false; error: LocationParseError } {
  const result = LocationFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    return {
      ok: false,
      error: {
        path,
        name,
        issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      },
    };
  }

  const fm = result.data;
  const defaults = typeDefaults(fm.type);
  const point = Array.isArray(fm.geometry) ? (fm.geometry as [number, number]) : null;
  const geometryRef = typeof fm.geometry === "string" ? fm.geometry : null;

  return {
    ok: true,
    location: {
      id: path,
      name,
      path,
      campaignId: fm.map,
      point,
      geometryRef,
      type: fm.type,
      importance: fm.importance ?? defaults.importance,
      focus: fm.focus ?? focusForType(fm.type),
      zoomMin: fm["zoom-range"]?.[0] ?? defaults.zoomMin,
      zoomMax: fm["zoom-range"]?.[1] ?? defaults.zoomMax,
      aliases: fm.aliases ?? [],
      icon: fm.icon ?? null,
      connections: (fm.connections ?? []).map((c) =>
        typeof c === "string"
          ? { to: c, type: null, label: null }
          : { to: c.to, type: c.type ?? null, label: c.label ?? null }
      ),
    },
  };
}

export function locationToFeature(loc: ParsedLocation): GeoJSON.Feature | null {
  if (!loc.point) return null;
  return {
    type: "Feature",
    id: hashStringToId(loc.id),
    geometry: { type: "Point", coordinates: loc.point },
    properties: {
      id: loc.id,
      name: loc.name,
      type: loc.type,
      importance: loc.importance,
      focus: loc.focus,
      minZoom: loc.zoomMin,
      maxZoom: loc.zoomMax,
      icon: loc.icon,
    },
  };
}

/** Stable numeric feature id (MapLibre feature-state needs a number/string id). */
export function hashStringToId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

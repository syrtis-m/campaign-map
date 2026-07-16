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
 * Depth-of-field label buckets — the zoom-legibility model. The map has three
 * fixed "focus levels" (Wide / Mid / Close, computed per-campaign from its
 * overview zoom);
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

/**
 * GM-facing visibility vocabulary. Label visibility is an EXPLICIT,
 * first-class note field — `visibility:` in frontmatter — fully decoupled from
 * `type`. The three values name the focus level at which a location's NAME first
 * appears (matching the +/- focus stepper's Wide/Mid/Close readout), so the GM
 * never has to remember a type→visibility mapping:
 *   wide  — name shown at every focus level (the big anchors)   → deep bucket
 *   mid   — name shown from the Mid level inward                → medium bucket
 *   close — name shown only at the Close level (fine grain)     → shallow bucket
 * The internal runtime gate stays the `focus`/FocusDepth bucket (the label
 * layers filter on the `focus` feature property by `minzoom`); `visibility` is
 * mapped to it 1:1 at the parse boundary. Legacy `focus:` frontmatter is still
 * accepted for back-compat.
 */
export const VISIBILITY_VALUES = ["wide", "mid", "close"] as const;
export type Visibility = (typeof VISIBILITY_VALUES)[number];

/** The single global fallback for a note with no explicit visibility — NOT
 * type-derived. */
export const DEFAULT_VISIBILITY: Visibility = "mid";

const VISIBILITY_TO_FOCUS: Record<Visibility, FocusDepth> = {
  wide: "deep",
  mid: "medium",
  close: "shallow",
};
const FOCUS_TO_VISIBILITY: Record<FocusDepth, Visibility> = {
  deep: "wide",
  medium: "mid",
  shallow: "close",
};
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

/**
 * Type → depth bucket. ONLY a convenience: it pre-selects a sensible default in
 * the QuickAdd picker and seeds an explicit value for generated/imported
 * features. It is NEVER read as the runtime visibility gate — the stored
 * `visibility`/`focus` field is the sole source of truth.
 */
export function focusForType(type: string): FocusDepth {
  return TYPE_FOCUS[type] ?? "medium";
}

/** Type-hinted pre-selection for the QuickAdd/place-card visibility picker.
 * A hint only — the chosen value is always written explicitly. */
export function defaultVisibilityForType(type: string): Visibility {
  return FOCUS_TO_VISIBILITY[focusForType(type)];
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
  visibility: z.enum(VISIBILITY_VALUES).optional(), // explicit label-visibility field (wide/mid/close)
  focus: z.enum(FOCUS_DEPTHS).optional(), // back-compat: legacy raw depth bucket (deep/medium/shallow)
  icon: z.string().optional(),
  connections: z.array(ConnectionSchema).optional(),
});

export interface ParsedLocation {
  id: string; // vault path, stable per-note identity
  name: string; // note basename
  path: string;
  campaignId: string;
  point: [number, number] | null; // resolved point geometry; null if sidecar-only (not yet loaded)
  geometryRef: string | null; // sidecar path, if geometry is a string
  type: string;
  importance: number;
  focus: FocusDepth; // runtime label-visibility gate (feature `focus` prop; label layers filter on it)
  visibility: Visibility; // GM-facing name for `focus` (wide/mid/close), for UI display + editing
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

  // Label visibility is decoupled from `type`. Explicit `visibility` wins; else
  // legacy `focus:`; else the single global default (medium/mid) — NEVER
  // type-derived. `type` does not gate what's visible.
  const focus: FocusDepth = fm.visibility
    ? VISIBILITY_TO_FOCUS[fm.visibility]
    : fm.focus ?? VISIBILITY_TO_FOCUS[DEFAULT_VISIBILITY];

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
      focus,
      visibility: FOCUS_TO_VISIBILITY[focus],
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

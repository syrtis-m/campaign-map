import type { Map as MapLibreMap, ExpressionSpecification } from "maplibre-gl";

/**
 * Per-type icon prototype (plan 006, spike). Every canon/generated location
 * currently renders as the same bare circle (src/map/themes/canonLayers.ts) —
 * this groups the 12-entry type taxonomy (src/model/locationNote.ts
 * TYPE_TAXONOMY) into a small set of icon *categories* (docs/06 §3: "12
 * types -> ~6 icons", not one glyph per type) so a new custom type never
 * needs a new icon and the icon set stays a fixed, reviewable size.
 *
 * Determinism/offline: category lookup is a pure string->string map; icons
 * are rasterized at runtime from canvas primitives (no network fetch, no
 * external sprite sheet) — same category + tokens always produces the same
 * pixels, and there's nothing to ship or go stale (CLAUDE.md: "full function
 * offline").
 */
export const TYPE_ICON_CATEGORY: Record<string, string> = {
  "nation/region": "region",
  district: "region",
  city: "settlement",
  town: "settlement",
  village: "settlement",
  route: "route",
  "street(named)": "route",
  "water-feature": "water",
  landmark: "landmark",
  "shop/tavern/venue": "venue",
  "residence/minor": "venue",
  custom: "generic",
};

export const ICON_CATEGORIES = ["settlement", "water", "region", "landmark", "venue", "route", "generic"] as const;
export type IconCategory = (typeof ICON_CATEGORIES)[number];

const FALLBACK_CATEGORY: IconCategory = "generic";

/** Pure type->category lookup; unknown/uncategorized types fall back to "generic"
 * (mirrors `typeDefaults()`'s fallback to the `custom` entry in locationNote.ts). */
export function iconCategoryFor(type: string): IconCategory {
  const category = TYPE_ICON_CATEGORY[type];
  return (ICON_CATEGORIES as readonly string[]).includes(category) ? (category as IconCategory) : FALLBACK_CATEGORY;
}

/**
 * The same lookup as `iconCategoryFor`, expressed as a MapLibre `match`
 * expression over `["get", "type"]` — lets `canonLayers.ts` compute
 * `icon-image` directly in the style JSON without a precomputed
 * `iconCategory` feature property (see plans/006-NOTES.md for why this was
 * chosen over adding a model-layer property).
 */
export function iconCategoryExpression(): ExpressionSpecification {
  const entries = Object.entries(TYPE_ICON_CATEGORY).flatMap(([type, category]) => [type, category]);
  return ["match", ["get", "type"], ...entries, FALLBACK_CATEGORY] as unknown as ExpressionSpecification;
}

export interface IconTokens {
  fill: string;
  stroke: string;
}

/** Intrinsic icon size in CSS px before `pixelRatio`/`icon-size` scaling —
 * matches the ≥24px hover-target bar (docs/02 §3b, plan 001). */
const ICON_BASE_SIZE = 24;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function regularPolygon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rotation: number
): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, innerR: number, points: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Draws one category's glyph into a `size`x`size` canvas context, centered,
 * filled with `tokens.fill` and outlined with `tokens.stroke` (same
 * fill/halo pairing `canon-point`'s circle uses, so icons read as "the same
 * pin family" rather than a mismatched overlay). Pure given (category, size,
 * tokens) — no randomness, no time-of-day/theme-poll side effects. */
function drawIcon(ctx: CanvasRenderingContext2D, category: IconCategory, size: number, tokens: IconTokens): void {
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = tokens.fill;
  ctx.strokeStyle = tokens.stroke;
  ctx.lineWidth = Math.max(1, size * 0.08);
  switch (category) {
    case "settlement": {
      const inset = size * 0.18;
      roundRect(ctx, inset, inset, size - inset * 2, size - inset * 2, size * 0.15);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "water": {
      ctx.beginPath();
      ctx.moveTo(c, size * 0.12);
      ctx.quadraticCurveTo(size * 0.85, size * 0.58, c, size * 0.9);
      ctx.quadraticCurveTo(size * 0.15, size * 0.58, c, size * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "region": {
      regularPolygon(ctx, c, c, size * 0.42, 6, -Math.PI / 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "landmark": {
      star(ctx, c, c, size * 0.42, size * 0.18, 5);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "venue": {
      ctx.beginPath();
      ctx.arc(c, c, size * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = tokens.stroke;
      ctx.arc(c, c, size * 0.11, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "route": {
      regularPolygon(ctx, c, c, size * 0.4, 4, -Math.PI / 4);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "generic": {
      ctx.beginPath();
      ctx.arc(c, c, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
  }
}

/**
 * Registers one `map.addImage`d raster per icon category, keyed `type-${category}`
 * to match `canonLayers.ts`'s `icon-image` expression. Idempotent via
 * `map.hasImage` (MapLibre throws if you `addImage` a name that already
 * exists) — safe to call from every `styledata` handler, which is required
 * because `map.setStyle(...)` wipes all runtime-registered images (see
 * plans/006-NOTES.md for the lifecycle writeup this exists to validate).
 */
export function registerTypeIcons(map: MapLibreMap, tokens: IconTokens): void {
  const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const px = Math.round(ICON_BASE_SIZE * ratio);
  for (const category of ICON_CATEGORIES) {
    const name = `type-${category}`;
    if (map.hasImage(name)) continue;
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    drawIcon(ctx, category, px, tokens);
    const imageData = ctx.getImageData(0, 0, px, px);
    map.addImage(name, imageData, { pixelRatio: ratio });
  }
}

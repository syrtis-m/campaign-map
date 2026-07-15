/**
 * Pure math + descriptor for the drag-to-extrude height handle (plan 040
 * Phase 1). No DOM / map / Obsidian imports — unit-tested headlessly; the
 * SketchController + MapView consume it for the on-map drag and the readout.
 *
 * The handle SETS an existing zod param through the normal `setRegionParams`
 * path — it never writes geometry or a new mechanism, so determinism (D1–D6) is
 * untouched. A vertical screen drag maps to a SIGNED elevation value in metres;
 * `heightParamsFromValue` turns that signed value back into the algorithm's own
 * params (relief: magnitude→`height`, sign→`polarity`; landform: →`target`).
 */
import type { FabricKind } from "../model/fabric";

/** UI bound for a handle drag, in metres. relief.height caps at 4000; landform
 * target is unbounded-finite, so we bound the HANDLE (not the param) to a sane
 * range — the panel number input remains the escape hatch for extremes. */
export const HEIGHT_HANDLE_LIMIT = 4000;

/** Default metres-per-pixel of vertical drag. Coarse by design (a big landform
 * spans thousands of metres); Shift halves it for fine control (C:S low-strength
 * convention). */
export const HEIGHT_MPP_COARSE = 12;
export const HEIGHT_MPP_FINE = 3;

/** Below this many metres of change a release is treated as a click, not an
 * extrude — no commit (avoids a no-op param write + cascade on a stray grab). */
export const HEIGHT_DRAG_DEADZONE_M = 2;

/** Which kinds grow a height handle, and how their signed drag value reads. */
export interface HeightHandleDescriptor {
  kind: FabricKind;
  /** The signed elevation the handle currently represents (m). */
  value: number;
  min: number;
  max: number;
}

/** View-layer starting value for a landform whose `target` is unset (the
 * generator's mode default applies until the GM drags; this is only where the
 * handle first sits). */
function landformStartValue(params: Record<string, unknown>): number {
  if (typeof params.target === "number") return params.target;
  const mode = typeof params.mode === "string" ? params.mode : "plateau";
  if (mode === "basin") return -300;
  if (mode === "sea") return 0;
  return 300; // plateau
}

/**
 * Build the descriptor for a stamp kind's current params, or null when the kind
 * has no height handle. relief's signed value folds polarity in (valley ⇒
 * negative) so one vertical drag raises OR lowers, the single-tool convention.
 */
export function heightHandleDescriptor(
  kind: FabricKind,
  params: Record<string, unknown>
): HeightHandleDescriptor | null {
  if (kind === "relief") {
    const h = typeof params.height === "number" ? params.height : 300;
    const valley = params.polarity === "valley";
    return { kind, value: valley ? -h : h, min: -HEIGHT_HANDLE_LIMIT, max: HEIGHT_HANDLE_LIMIT };
  }
  if (kind === "landform") {
    return {
      kind,
      value: landformStartValue(params),
      min: -HEIGHT_HANDLE_LIMIT,
      max: HEIGHT_HANDLE_LIMIT,
    };
  }
  return null;
}

/** Clamp a value into a descriptor's [min, max]. */
export function clampHeight(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Map a vertical screen drag to a new signed value. `dyUp` is the upward pixel
 * delta (start screen-Y minus current screen-Y — up is positive so dragging up
 * raises). Rounded to whole metres (elevation is metres; sub-metre precision is
 * the panel's job).
 */
export function valueFromDrag(
  startValue: number,
  dyUp: number,
  metresPerPixel: number,
  min: number,
  max: number
): number {
  return clampHeight(Math.round(startValue + dyUp * metresPerPixel), min, max);
}

/** Turn a signed handle value back into the algorithm's params (merged into the
 * live params by the caller before `setRegionParams`). */
export function heightParamsFromValue(kind: FabricKind, value: number): Record<string, unknown> {
  if (kind === "relief") {
    return { height: Math.max(1, Math.abs(value)), polarity: value < 0 ? "valley" : "ridge" };
  }
  if (kind === "landform") {
    return { target: value };
  }
  return {};
}

/** Live readout string for the drag HUD / handle label ("+300 m" / "−120 m"). */
export function formatHeightReadout(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(Math.round(value))} m`;
}

/**
 * Parse a type-to-refine entry (Phase 3) into a clamped value, or null when the
 * text is not a finite number. A leading sign is honoured; for relief the caller
 * has already chosen the signed convention, so a bare number is signed as typed.
 */
export function parseHeightInput(text: string, min: number, max: number): number | null {
  const t = text.trim().replace(/−/g, "-").replace(/\s*m$/i, "");
  if (t === "" || t === "-" || t === "+") return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return clampHeight(Math.round(n), min, max);
}

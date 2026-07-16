/**
 * Schema-driven procgen param controls.
 *
 * The registry gives every algorithm a zod `paramsSchema` (river windiness,
 * forest density, wall towerSpacing, relief height, …). Historically the GUI
 * (RegionProcgenModal + the selection panel) exposed only the *preset* dropdown,
 * so every knob beyond the preset discriminator was engine-reachable but had NO
 * GUI control. This module derives the controls straight from the zod schema so
 * a new param can never silently go uncontrolled: `paramFieldSpecs` walks the
 * schema shape into an ordered list of typed control specs, and the contract
 * test (`paramControls.test.ts`) asserts every registry algorithm's schema keys
 * map to a supported spec — a param whose type this introspector can't render
 * becomes a `kind: "unsupported"` spec that fails the test loudly.
 *
 * Pure w.r.t. zod (no DOM at import time) so it is unit-testable headlessly; the
 * `renderParamControls` DOM helper uses only standard `document` APIs (works in
 * the Obsidian/Electron renderer) and is never exercised by the contract test.
 */
import { z } from "zod";

/** A single rendered control derived from one zod schema field. The optional
 * `description` (the field's zod `.describe()` text, GM-facing) renders as a
 * hover tooltip on the control row — every edit menu gets help text straight
 * from the schema, so a new param can't ship without a place for its docs. */
export type ParamFieldSpec = ParamFieldSpecBase & { description?: string };

type ParamFieldSpecBase =
  | {
      key: string;
      label: string;
      kind: "number";
      min?: number;
      max?: number;
      step: number | "any";
      integer: boolean;
      default?: number;
    }
  | { key: string; label: string; kind: "enum"; options: string[]; default?: string }
  | { key: string; label: string; kind: "boolean"; default?: boolean }
  | {
      key: string;
      label: string;
      kind: "choice";
      options: number[];
      default?: number;
    }
  /** A tuple point (city `center`) — driven by the on-map ◆ drag handle, not an
   * inline control. Emitted so the contract test counts the key as covered. */
  | { key: string; label: string; kind: "point" }
  /** An array param driven by ON-MAP handles, not an inline control (river
   * `depths` — one depth grip per spine vertex). Like `point`: emitted so the
   * contract test counts the key as covered, but renders nothing in the panel. */
  | { key: string; label: string; kind: "handle" }
  /** A field whose zod type this introspector does not know how to render.
   * Never produced today; the contract test fails if one ever appears, which is
   * the whole point (a new param type must extend this module, not slip by). */
  | { key: string; label: string; kind: "unsupported"; typeName: string };

/** camelCase → "Sentence case" (`slopeSensitivity` → "Slope sensitivity"). */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

interface ZodDefLike {
  typeName?: string;
  description?: string;
  innerType?: { _def: ZodDefLike };
  defaultValue?: () => unknown;
  checks?: { kind: string; value?: number; inclusive?: boolean }[];
  values?: string[];
  options?: { _def: { typeName?: string; value?: unknown } }[];
  shape?: () => Record<string, { _def: ZodDefLike }>;
}

type ZodFieldLike = { _def: ZodDefLike };

/** Strip ZodOptional/ZodDefault/ZodNullable wrappers to the core type, tracking
 * the default value the outermost ZodDefault (if any) supplies. */
function unwrap(field: ZodFieldLike): { core: ZodFieldLike; def: unknown; description?: string } {
  let node = field;
  let def: unknown = undefined;
  let description: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const d = node._def;
    if (description === undefined && typeof d.description === "string") description = d.description;
    if (d.typeName === "ZodDefault") {
      if (def === undefined && typeof d.defaultValue === "function") def = d.defaultValue();
      node = d.innerType as ZodFieldLike;
    } else if (d.typeName === "ZodOptional" || d.typeName === "ZodNullable") {
      node = d.innerType as ZodFieldLike;
    } else {
      break;
    }
  }
  if (description === undefined && typeof node._def.description === "string") description = node._def.description;
  return { core: node, def, description };
}

function numberStep(min: number | undefined, max: number | undefined, integer: boolean): number | "any" {
  if (integer) return 1;
  const span = max !== undefined ? Math.abs(max) : undefined;
  if (span !== undefined && span <= 1) return 0.05;
  if (span !== undefined && span <= 5) return 0.1;
  return "any";
}

function specForField(key: string, field: ZodFieldLike): ParamFieldSpec {
  const label = humanizeKey(key);
  const { core, def, description } = unwrap(field);
  const spec = specForCore(key, label, core, def);
  return description !== undefined ? { ...spec, description } : spec;
}

function specForCore(key: string, label: string, core: ZodFieldLike, def: unknown): ParamFieldSpec {
  const d = core._def;
  switch (d.typeName) {
    case "ZodNumber": {
      const checks = d.checks ?? [];
      const integer = checks.some((c) => c.kind === "int");
      let min: number | undefined;
      let max: number | undefined;
      for (const c of checks) {
        if (c.kind === "min" && typeof c.value === "number") min = c.inclusive ? c.value : c.value; // treat exclusive≈inclusive for the input floor
        if (c.kind === "max" && typeof c.value === "number") max = c.value;
      }
      return {
        key,
        label,
        kind: "number",
        min,
        max,
        step: numberStep(min, max, integer),
        integer,
        default: typeof def === "number" ? def : undefined,
      };
    }
    case "ZodBoolean":
      return { key, label, kind: "boolean", default: typeof def === "boolean" ? def : undefined };
    case "ZodEnum":
      return {
        key,
        label,
        kind: "enum",
        options: [...(d.values ?? [])],
        default: typeof def === "string" ? def : undefined,
      };
    case "ZodNativeEnum":
      return {
        key,
        label,
        kind: "enum",
        options: Object.values(d as unknown as Record<string, string>).filter((v) => typeof v === "string"),
        default: typeof def === "string" ? def : undefined,
      };
    case "ZodUnion": {
      const opts = d.options ?? [];
      const allNumericLiterals =
        opts.length > 0 && opts.every((o) => o._def.typeName === "ZodLiteral" && typeof o._def.value === "number");
      if (allNumericLiterals) {
        return {
          key,
          label,
          kind: "choice",
          options: opts.map((o) => o._def.value as number),
          default: typeof def === "number" ? def : undefined,
        };
      }
      return { key, label, kind: "unsupported", typeName: "ZodUnion" };
    }
    case "ZodTuple":
      return { key, label, kind: "point" };
    case "ZodArray":
      // On-map-handle-driven (river `depths`): edited via the per-vertex depth
      // grips, never an inline panel control.
      return { key, label, kind: "handle" };
    default:
      return { key, label, kind: "unsupported", typeName: d.typeName ?? "unknown" };
  }
}

/** Ordered keys of a schema's object shape (registry order). Empty when the
 * schema is not a ZodObject (defensive — the contract test then reports the
 * mismatch). */
export function schemaParamKeys(schema: unknown): string[] {
  const d = (schema as ZodFieldLike)?._def;
  if (!d || d.typeName !== "ZodObject" || typeof d.shape !== "function") return [];
  return Object.keys(d.shape());
}

/** The ordered control specs for an algorithm's params schema. One spec per
 * schema field, in declaration order. */
export function paramFieldSpecs(schema: unknown): ParamFieldSpec[] {
  const d = (schema as ZodFieldLike)?._def;
  if (!d || d.typeName !== "ZodObject" || typeof d.shape !== "function") return [];
  const shape = d.shape();
  return Object.keys(shape).map((key) => specForField(key, shape[key] as ZodFieldLike));
}

/**
 * Render editable controls for `specs` into `parent`, seeded from `params`.
 * `onChange(key, value)` fires on commit (number: change/blur; enum/bool/choice:
 * change). `point`/`unsupported` specs render nothing here — a `point` (city
 * center) is placed via the on-map ◆ handle, and an `unsupported` spec is a
 * contract-test failure, never shipped. Standard DOM only (no obsidian import),
 * so the module stays headlessly importable.
 */
export function renderParamControls(
  parent: HTMLElement,
  specs: ParamFieldSpec[],
  params: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
  rowClass = "campaign-map-sketch-selection-row"
): void {
  for (const spec of specs) {
    if (spec.kind === "point" || spec.kind === "handle" || spec.kind === "unsupported") continue;
    const row = document.createElement("div");
    row.className = rowClass;
    // Schema-derived tooltip (the field's zod .describe() text): hovering any
    // part of the row explains what the knob does — GMs shouldn't need to know
    // the generator internals to read an edit menu.
    if (spec.description) {
      row.title = spec.description;
      row.setAttribute("aria-label", spec.description);
    }
    const label = document.createElement("span");
    label.className = "campaign-map-sketch-selection-label";
    label.textContent = spec.label;
    row.appendChild(label);

    if (spec.kind === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "campaign-map-param-number";
      if (spec.min !== undefined) input.min = String(spec.min);
      if (spec.max !== undefined) input.max = String(spec.max);
      input.step = String(spec.step);
      const current = params[spec.key];
      input.value = String(typeof current === "number" ? current : spec.default ?? "");
      const commit = (): void => {
        const n = Number.parseFloat(input.value);
        if (!Number.isFinite(n)) return;
        let v = n;
        if (spec.integer) v = Math.round(v);
        if (spec.min !== undefined) v = Math.max(spec.min, v);
        if (spec.max !== undefined) v = Math.min(spec.max, v);
        if (v !== n) input.value = String(v);
        onChange(spec.key, v);
      };
      input.addEventListener("change", commit);
      row.appendChild(input);
    } else if (spec.kind === "boolean") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "campaign-map-param-toggle";
      const current = params[spec.key];
      input.checked = typeof current === "boolean" ? current : spec.default ?? false;
      input.addEventListener("change", () => onChange(spec.key, input.checked));
      row.appendChild(input);
    } else if (spec.kind === "enum") {
      const select = document.createElement("select");
      select.className = "campaign-map-param-select";
      const current = params[spec.key];
      for (const opt of spec.options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = humanizeKey(opt);
        if (opt === (typeof current === "string" ? current : spec.default)) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener("change", () => onChange(spec.key, select.value));
      row.appendChild(select);
    } else {
      // choice: numeric literal union (e.g. growthRings 1|2)
      const select = document.createElement("select");
      select.className = "campaign-map-param-select";
      const current = params[spec.key];
      for (const opt of spec.options) {
        const o = document.createElement("option");
        o.value = String(opt);
        o.textContent = String(opt);
        if (opt === (typeof current === "number" ? current : spec.default)) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener("change", () => onChange(spec.key, Number(select.value)));
      row.appendChild(select);
    }
    parent.appendChild(row);
  }
}

// ─── Presented params (relief width unification, 2026-07-16) ─────────────────
// Relief's persisted schema keeps BOTH `halfWidth` and `apron` (byte-compat for
// existing fabrics — an untouched stamp re-parses identically, no version bump),
// but the FIELD's cross-profile is one smoothstep over their SUM
// (`reliefField`: reach = halfWidth + apron), so two controls were one knob in
// disguise (Jonah 2026-07-16: "very confusing"). Every GUI surface (selection
// panel, creation modal, band grip) therefore presents ONE `width` — the total
// distance from the ridge line to where the relief fades to nothing — and a
// commit translates it back to `{ halfWidth: width, apron: 0 }`, which is
// byte-identical terrain for equal sums (the profile depends only on the sum;
// the segment hash's nearest() is exact under any cellSize).

/** The GM-facing control specs for an algorithm's schema, per sketch kind:
 * relief collapses halfWidth+apron into one `width` spec (same numeric
 * constraints as halfWidth); everything else passes through unchanged. */
export function presentedParamSpecs(kind: string, schema: unknown): ParamFieldSpec[] {
  const specs = paramFieldSpecs(schema);
  if (kind !== "relief") return specs;
  const out: ParamFieldSpec[] = [];
  for (const s of specs) {
    if (s.key === "apron") continue;
    if (s.key === "halfWidth" && s.kind === "number") {
      out.push({
        ...s,
        key: "width",
        label: "width (ridge line → fade-out, m)",
        description:
          "Total distance in meters from the ridge line to where the relief fades to nothing — drag the on-map band grip or edit it here.",
      });
      continue;
    }
    out.push(s);
  }
  return out;
}

/** The presented VALUES for the specs above: relief mirrors the live sum into
 * `width` so the control shows the stamp's true reach. */
export function presentedParams(kind: string, params: Record<string, unknown>): Record<string, unknown> {
  if (kind !== "relief") return params;
  const hw = typeof params.halfWidth === "number" && Number.isFinite(params.halfWidth) ? params.halfWidth : 180;
  const apron = typeof params.apron === "number" && Number.isFinite(params.apron) ? params.apron : 0;
  return { ...params, width: Math.max(1, hw) + Math.max(0, apron) };
}

/** Translate ONE presented-control edit into the schema-param patch to merge
 * into the live params: relief `width` → `{ halfWidth: width, apron: 0 }`
 * (byte-identical field for equal sums); everything else is a passthrough. */
export function presentedParamPatch(kind: string, key: string, value: unknown): Record<string, unknown> {
  if (kind === "relief" && key === "width" && typeof value === "number") {
    return { halfWidth: Math.max(1, Math.round(value)), apron: 0 };
  }
  return { [key]: value };
}

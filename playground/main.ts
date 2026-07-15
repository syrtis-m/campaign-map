/**
 * Standalone procgen playground (rearchitecture wave 1, DECISIONS 2026-07-14).
 * Dev tooling only: never bundled into the plugin, never a determinism
 * surface. Paint is a flat interpreter of the style contract (a dev role→color
 * palette, not theme truth): a new bucket renders from its contract entry alone.
 */
import { z } from "zod";
import { FABRIC_KINDS, isPolygonKind, type FabricKind } from "../src/model/fabric";
import {
  algorithmForKind,
  matchingPresetId,
  presetById,
  type ProcgenAlgorithm,
} from "../src/gen/procgen/registry";
import { ALL_STYLE_CONTRACTS, type SemanticRole } from "../src/gen/procgen/styleContract";
import {
  makeRegion,
  makeSpine,
  makeCorridorRegion,
  type ProcgenRegion,
} from "../src/gen/region";
import type { GenerationConstraints } from "../src/gen/types";

type Pt = [number, number];

// ─── Registry access ─────────────────────────────────────────────────────────
// The registry exports lookups, not the list; derive it from the fabric kinds
// so this file never needs a registry edit to see a new algorithm.

const ALGORITHMS: ProcgenAlgorithm[] = [];
for (const kind of FABRIC_KINDS) {
  const a = algorithmForKind(kind as FabricKind);
  if (a && !ALGORITHMS.some((x) => x.id === a.id)) ALGORITHMS.push(a);
}

const WORLD_BOUNDS = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };

// ─── State ───────────────────────────────────────────────────────────────────

interface State {
  algorithm: ProcgenAlgorithm;
  params: Record<string, unknown>;
  seed: number;
  polyShape: "circle" | "square" | "blob" | "l-shape";
  sizeM: number; // effective radius for polygons
  spineShape: "straight" | "gentle-s" | "zigzag";
  lengthM: number;
}

const DEFAULT_ALGORITHM = ALGORITHMS.find((a) => a.id === "city") ?? ALGORITHMS[0];

const state: State = {
  algorithm: DEFAULT_ALGORITHM,
  params: { ...DEFAULT_ALGORITHM.defaultParams("parchment") },
  seed: 4181,
  polyShape: "circle",
  sizeM: 420,
  spineShape: "gentle-s",
  lengthM: 1400,
};

function isLineAlgorithm(a: ProcgenAlgorithm): boolean {
  return !isPolygonKind(a.appliesTo[0]);
}

// ─── Region / spine construction ─────────────────────────────────────────────

function polygonRing(shape: State["polyShape"], r: number): Pt[] {
  const ring: Pt[] = [];
  if (shape === "circle") {
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      ring.push([r * Math.cos(t), r * Math.sin(t)]);
    }
  } else if (shape === "square") {
    const s = r * 0.9;
    ring.push([-s, -s], [s, -s], [s, s], [-s, s]);
  } else if (shape === "l-shape") {
    const s = r * 1.1;
    ring.push([-s, -s], [s, -s], [s, 0], [0, 0], [0, s], [-s, s]);
  } else {
    // blob: fixed-seed radial noise so the shape is stable while scrubbing
    // the generation seed.
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      const wobble = 1 + 0.3 * Math.sin(t * 3 + 1.7) + 0.12 * Math.sin(t * 7 + 0.4);
      ring.push([r * wobble * Math.cos(t), r * wobble * Math.sin(t)]);
    }
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function spineLine(shape: State["spineShape"], len: number): Pt[] {
  const pts: Pt[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + (i / n) * len;
    let y = 0;
    if (shape === "gentle-s") y = (len / 8) * Math.sin((i / n) * Math.PI * 2);
    if (shape === "zigzag") y = (len / 12) * (Math.abs(((i / n) * 4) % 2 - 1) * 2 - 1);
    pts.push([x, y]);
  }
  return pts;
}

function buildRegion(): ProcgenRegion {
  if (isLineAlgorithm(state.algorithm)) {
    const spine = makeSpine("playground-spine", spineLine(state.spineShape, state.lengthM));
    const maxOffset = state.algorithm.corridorMaxOffset?.(state.params) ?? 80;
    return makeCorridorRegion("playground-region", spine, maxOffset);
  }
  return makeRegion("playground-region", polygonRing(state.polyShape, state.sizeM));
}

// ─── zod introspection → knobs ───────────────────────────────────────────────

interface Knob {
  key: string;
  kind: "number" | "enum" | "boolean" | "literal-union";
  min: number;
  max: number;
  step: number;
  int: boolean;
  options: (string | number)[];
  optional: boolean;
}

function def(t: z.ZodTypeAny): { typeName: string; [k: string]: unknown } {
  return (t as unknown as { _def: { typeName: string } })._def as never;
}

function knobsFor(schema: z.ZodTypeAny): Knob[] {
  if (def(schema).typeName !== "ZodObject") return [];
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const knobs: Knob[] = [];
  for (const [key, raw] of Object.entries(shape)) {
    let t = raw as z.ZodTypeAny;
    let optional = false;
    for (;;) {
      const d = def(t);
      if (d.typeName === "ZodDefault") t = d.innerType as z.ZodTypeAny;
      else if (d.typeName === "ZodOptional") { optional = true; t = d.innerType as z.ZodTypeAny; }
      else break;
    }
    const d = def(t);
    if (d.typeName === "ZodNumber") {
      let min = 0, max = 1, int = false;
      for (const c of (d.checks as { kind: string; value?: number }[]) ?? []) {
        if (c.kind === "min" && c.value !== undefined) min = c.value;
        if (c.kind === "max" && c.value !== undefined) max = c.value;
        if (c.kind === "int") int = true;
      }
      knobs.push({ key, kind: "number", min, max, step: int ? 1 : 0, int, options: [], optional });
    } else if (d.typeName === "ZodEnum") {
      knobs.push({ key, kind: "enum", min: 0, max: 0, step: 0, int: false, options: [...(d.values as string[])], optional });
    } else if (d.typeName === "ZodBoolean") {
      knobs.push({ key, kind: "boolean", min: 0, max: 0, step: 0, int: false, options: [], optional });
    } else if (d.typeName === "ZodUnion") {
      const opts: (string | number)[] = [];
      let allLiterals = true;
      for (const o of d.options as z.ZodTypeAny[]) {
        const od = def(o);
        if (od.typeName === "ZodLiteral") opts.push(od.value as string | number);
        else allLiterals = false;
      }
      if (allLiterals && opts.length > 0) {
        knobs.push({ key, kind: "literal-union", min: 0, max: 0, step: 0, int: false, options: opts, optional });
      }
    }
    // ZodTuple (the city `center`) and anything else: not knob-representable — skip.
  }
  return knobs;
}

// ─── Paint interpreter (contract-driven) ─────────────────────────────────────
// The style contract (src/gen/procgen/styleContract.ts) binds every gid to a
// role + mark + z; here a flat role→color palette turns that into a 2D canvas
// paint. This is a DEV palette, not theme truth (themes own the real color, via
// map/themes/roleColors.ts) — the point is that a new bucket paints here from
// its contract entry alone, no per-gid edit. Unknown/unpainted gids fall to a
// stable hash hue below.

interface Paint {
  z: number;
  fill?: string;
  stroke?: string;
  width?: number; // px at scale 1; streets use properties.width (meters) instead
  widthFromProp?: boolean;
  dash?: number[];
  point?: { r: number; color: string };
}

/** Flat, legible dev colors — one per contract role. Not theme truth. */
const ROLE_COLORS: Record<SemanticRole, string> = {
  water: "#8fb8d8",
  "water-body": "#a3c6df",
  "water-edge": "#7ba3c2",
  ground: "#e6dcc0",
  vegetation: "#b7d0a0",
  "vegetation-deep": "#7d9c6e",
  cultivated: "#e6dcb4",
  built: "#6f6558",
  "built-accent": "rgba(160,148,120,0.35)",
  route: "#8a7a55",
  boundary: "#7a7265",
  "path-casing": "#b0a184",
  relief: "#c9bfad",
  "terrain-contour": "#a89a7f",
  accent: "#8a4a3d",
};

/** Build the per-gid paint table by interpreting every painted contract bucket
 * through the role palette + its mark. */
const PAINT: Record<string, Paint> = (() => {
  const table: Record<string, Paint> = {};
  for (const bucket of ALL_STYLE_CONTRACTS.flat()) {
    if (bucket.unpainted) continue;
    const color = ROLE_COLORS[bucket.role];
    const base: Paint = { z: bucket.z };
    switch (bucket.mark) {
      case "fill":
        table[bucket.gid] = { ...base, fill: color };
        break;
      case "line":
        table[bucket.gid] = {
          ...base,
          stroke: color,
          width: 1,
          widthFromProp: bucket.widthFromProp ? true : undefined,
          dash: bucket.dashed ? [4, 3] : undefined,
        };
        break;
      case "point":
        table[bucket.gid] = { ...base, point: { r: 1.6, color } };
        break;
      case "fill+outline":
        table[bucket.gid] = { ...base, fill: color, stroke: color, width: 1 };
        break;
    }
  }
  return table;
})();

function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}

function paintFor(gid: string): Paint {
  return PAINT[gid] ?? { z: 25, fill: `hsla(${hashHue(gid)},45%,55%,0.4)`, stroke: `hsl(${hashHue(gid)},45%,35%)`, width: 1 };
}

// ─── Canvas renderer with pan/zoom ───────────────────────────────────────────

const canvas = document.getElementById("view") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const view = { scale: 1, tx: 0, ty: 0 }; // world→screen: sx = x*scale+tx, sy = -y*scale+ty

let lastFeatures: GeoJSON.Feature[] = [];
let lastRegion: ProcgenRegion | null = null;

function fitView(region: ProcgenRegion): void {
  const rect = canvas.getBoundingClientRect();
  const pad = 40;
  const dx = region.bbox.maxX - region.bbox.minX;
  const dy = region.bbox.maxY - region.bbox.minY;
  view.scale = Math.min((rect.width - pad * 2) / dx, (rect.height - pad * 2) / dy);
  view.tx = rect.width / 2 - ((region.bbox.minX + region.bbox.maxX) / 2) * view.scale;
  view.ty = rect.height / 2 + ((region.bbox.minY + region.bbox.maxY) / 2) * view.scale;
}

function drawRing(ring: Pt[]): void {
  ring.forEach(([x, y], i) => {
    const sx = x * view.scale + view.tx;
    const sy = -y * view.scale + view.ty;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
}

function render(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#f4efe4";
  ctx.fillRect(0, 0, rect.width, rect.height);

  // region outline / spine
  if (lastRegion) {
    ctx.beginPath();
    drawRing(lastRegion.spine ? lastRegion.spine.points : lastRegion.ring);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = lastRegion.spine ? "rgba(90,80,60,0.5)" : "rgba(90,80,60,0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const sorted = [...lastFeatures].sort(
    (a, b) => paintFor(String(a.properties?.generatorId)).z - paintFor(String(b.properties?.generatorId)).z
  );

  for (const f of sorted) {
    const p = paintFor(String(f.properties?.generatorId));
    const g = f.geometry;
    if (g.type === "Point") {
      const pt = p.point ?? { r: 1.5, color: p.stroke ?? "#444" };
      const [x, y] = g.coordinates as Pt;
      ctx.beginPath();
      ctx.arc(x * view.scale + view.tx, -y * view.scale + view.ty, pt.r, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      continue;
    }
    const polys: Pt[][][] =
      g.type === "Polygon" ? [g.coordinates as Pt[][]] :
      g.type === "MultiPolygon" ? (g.coordinates as Pt[][][]) :
      g.type === "LineString" ? [[g.coordinates as Pt[]]] : [];
    for (const rings of polys) {
      ctx.beginPath();
      for (const ring of rings) drawRing(ring);
      if (g.type !== "LineString" && p.fill) {
        ctx.fillStyle = p.fill;
        ctx.fill("evenodd");
      }
      if (p.stroke || p.widthFromProp) {
        const meters = p.widthFromProp ? Number(f.properties?.width) || 8 : 0;
        ctx.strokeStyle = p.stroke ?? "#4a4438";
        ctx.lineWidth = p.widthFromProp ? Math.max(meters * view.scale * 0.5, 0.5) : (p.width ?? 1);
        if (p.dash) ctx.setLineDash(p.dash);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  view.tx = mx - (mx - view.tx) * factor;
  view.ty = my - (my - view.ty) * factor;
  view.scale *= factor;
  render();
}, { passive: false });

let panning: { mx: number; my: number } | null = null;
canvas.addEventListener("mousedown", (e) => { panning = { mx: e.clientX, my: e.clientY }; canvas.classList.add("panning"); });
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  view.tx += e.clientX - panning.mx;
  view.ty += e.clientY - panning.my;
  panning = { mx: e.clientX, my: e.clientY };
  render();
});
window.addEventListener("mouseup", () => { panning = null; canvas.classList.remove("panning"); });
window.addEventListener("resize", render);

// ─── Generation ──────────────────────────────────────────────────────────────

const statTime = document.getElementById("statTime")!;
const statCount = document.getElementById("statCount")!;
const statErr = document.getElementById("statErr")!;

let runCounter = 0;

function generate(opts: { refit?: boolean } = {}): void {
  const run = ++runCounter;
  statTime.textContent = "generating…";
  statErr.textContent = "";
  // let the status paint before the (possibly seconds-long) synchronous run
  setTimeout(() => {
    if (run !== runCounter) return;
    try {
      const region = buildRegion();
      const constraints: GenerationConstraints = { worldBounds: WORLD_BOUNDS };
      const t0 = performance.now();
      const features = state.algorithm.generate(state.seed, region, state.params, constraints);
      const ms = performance.now() - t0;
      if (run !== runCounter) return;
      lastFeatures = features;
      lastRegion = region;
      if (opts.refit || view.scale === 1) fitView(region);
      render();
      statTime.textContent = `${ms.toFixed(0)} ms`;
      statCount.textContent = `${features.length} features · seed ${state.seed}`;
    } catch (err) {
      lastFeatures = [];
      render();
      statTime.textContent = "";
      statErr.textContent = err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
  }, 15);
}

// ─── Preset grid ─────────────────────────────────────────────────────────────

const gridEl = document.getElementById("grid")!;

function renderMini(cv: HTMLCanvasElement, features: GeoJSON.Feature[], region: ProcgenRegion): void {
  const c = cv.getContext("2d")!;
  const pad = 6;
  const dx = region.bbox.maxX - region.bbox.minX;
  const dy = region.bbox.maxY - region.bbox.minY;
  const s = Math.min((cv.width - pad * 2) / dx, (cv.height - pad * 2) / dy);
  const tx = cv.width / 2 - ((region.bbox.minX + region.bbox.maxX) / 2) * s;
  const ty = cv.height / 2 + ((region.bbox.minY + region.bbox.maxY) / 2) * s;
  c.fillStyle = "#f4efe4";
  c.fillRect(0, 0, cv.width, cv.height);
  const sorted = [...features].sort(
    (a, b) => paintFor(String(a.properties?.generatorId)).z - paintFor(String(b.properties?.generatorId)).z
  );
  for (const f of sorted) {
    const p = paintFor(String(f.properties?.generatorId));
    const g = f.geometry;
    const trace = (ring: Pt[]) => ring.forEach(([x, y], i) => (i === 0 ? c.moveTo(x * s + tx, -y * s + ty) : c.lineTo(x * s + tx, -y * s + ty)));
    if (g.type === "Point") {
      const [x, y] = g.coordinates as Pt;
      c.beginPath(); c.arc(x * s + tx, -y * s + ty, 0.8, 0, Math.PI * 2);
      c.fillStyle = p.point?.color ?? "#444"; c.fill();
      continue;
    }
    const polys: Pt[][][] =
      g.type === "Polygon" ? [g.coordinates as Pt[][]] :
      g.type === "MultiPolygon" ? (g.coordinates as Pt[][][]) :
      g.type === "LineString" ? [[g.coordinates as Pt[]]] : [];
    for (const rings of polys) {
      c.beginPath();
      for (const ring of rings) trace(ring);
      if (g.type !== "LineString" && p.fill) { c.fillStyle = p.fill; c.fill("evenodd"); }
      if (p.stroke || p.widthFromProp) {
        c.strokeStyle = p.stroke ?? "#4a4438";
        c.lineWidth = 0.5;
        c.stroke();
      }
    }
  }
}

async function renderPresetGrid(): Promise<void> {
  gridEl.replaceChildren();
  const activeId = matchingPresetId(state.algorithm, state.params);
  for (const preset of state.algorithm.presets) {
    const cell = document.createElement("div");
    cell.className = "cell" + (preset.id === activeId ? " active" : "");
    const cv = document.createElement("canvas");
    cv.width = 150; cv.height = 120;
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = preset.id;
    cell.append(cv, name);
    cell.addEventListener("click", () => {
      state.params = { ...preset.params };
      syncPresetDropdown();
      buildParamControls();
      generate();
      for (const el of Array.from(gridEl.children)) el.classList.toggle("active", el === cell);
    });
    gridEl.append(cell);
    // yield so the strip appears cell by cell instead of freezing the tab
    await new Promise((r) => setTimeout(r, 10));
    try {
      const params = { ...state.params, ...preset.params };
      const region = buildRegion();
      const features = state.algorithm.generate(state.seed, region, params, { worldBounds: WORLD_BOUNDS });
      renderMini(cv, features, region);
    } catch {
      const c = cv.getContext("2d")!;
      c.fillStyle = "#a03325";
      c.fillText("error", 8, 16);
    }
  }
}

// ─── Controls ────────────────────────────────────────────────────────────────

const algorithmEl = document.getElementById("algorithm") as HTMLSelectElement;
const presetEl = document.getElementById("preset") as HTMLSelectElement;
const paramsEl = document.getElementById("params")!;
const regionEl = document.getElementById("regionControls")!;
const seedEl = document.getElementById("seed") as HTMLInputElement;

for (const a of ALGORITHMS) {
  const opt = document.createElement("option");
  opt.value = a.id;
  opt.textContent = `${a.label} (${a.appliesTo.join(", ")})`;
  algorithmEl.append(opt);
}

function syncPresetDropdown(): void {
  presetEl.replaceChildren();
  for (const p of state.algorithm.presets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    presetEl.append(opt);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "Custom";
  presetEl.append(custom);
  presetEl.value = matchingPresetId(state.algorithm, state.params) ?? "__custom__";
}

function sliderRow(label: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min); input.max = String(max);
  input.step = step > 0 ? String(step) : "any"; // "any": no lattice-snap on defaults like 60 in [15,400]
  input.value = String(value);
  const val = document.createElement("span");
  val.className = "val";
  val.textContent = String(value);
  input.addEventListener("input", () => { val.textContent = input.value; });
  input.addEventListener("change", () => onChange(Number(input.value)));
  row.append(lab, input, val);
  return row;
}

function buildParamControls(): void {
  paramsEl.replaceChildren();
  const knobs = knobsFor(state.algorithm.paramsSchema as z.ZodTypeAny);
  for (const knob of knobs) {
    const current = state.params[knob.key];
    if (knob.kind === "number") {
      paramsEl.append(
        sliderRow(knob.key, knob.min, knob.max, knob.step, Number(current ?? knob.min), (v) => {
          state.params = { ...state.params, [knob.key]: knob.int ? Math.round(v) : v };
          syncPresetDropdown();
          generate();
        })
      );
    } else if (knob.kind === "enum" || knob.kind === "literal-union") {
      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("label");
      lab.textContent = knob.key;
      const sel = document.createElement("select");
      sel.style.flex = "2";
      if (knob.optional) {
        const opt = document.createElement("option");
        opt.value = "__unset__";
        opt.textContent = "(default)";
        sel.append(opt);
      }
      for (const o of knob.options) {
        const opt = document.createElement("option");
        opt.value = String(o);
        opt.textContent = String(o);
        sel.append(opt);
      }
      sel.value = current === undefined ? "__unset__" : String(current);
      sel.addEventListener("change", () => {
        const next = { ...state.params };
        if (sel.value === "__unset__") delete next[knob.key];
        else {
          const asNum = Number(sel.value);
          next[knob.key] = knob.options.some((o) => typeof o === "number") && !Number.isNaN(asNum) ? asNum : sel.value;
        }
        state.params = next;
        syncPresetDropdown();
        buildParamControls();
        generate();
      });
      row.append(lab, sel);
      paramsEl.append(row);
    } else if (knob.kind === "boolean") {
      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("label");
      lab.textContent = knob.key;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = current === true;
      input.addEventListener("change", () => {
        const next = { ...state.params };
        if (knob.optional && !input.checked) delete next[knob.key];
        else next[knob.key] = input.checked;
        state.params = next;
        syncPresetDropdown();
        generate();
      });
      row.append(lab, input);
      paramsEl.append(row);
    }
  }
}

function buildRegionControls(): void {
  regionEl.replaceChildren();
  if (isLineAlgorithm(state.algorithm)) {
    const row = document.createElement("div");
    row.className = "row";
    const sel = document.createElement("select");
    for (const s of ["straight", "gentle-s", "zigzag"] as const) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = `spine: ${s}`;
      sel.append(opt);
    }
    sel.value = state.spineShape;
    sel.addEventListener("change", () => { state.spineShape = sel.value as State["spineShape"]; generate({ refit: true }); });
    row.append(sel);
    regionEl.append(row);
    regionEl.append(
      sliderRow("length (m)", 400, 4000, 50, state.lengthM, (v) => { state.lengthM = v; generate({ refit: true }); })
    );
  } else {
    const row = document.createElement("div");
    row.className = "row";
    const sel = document.createElement("select");
    for (const s of ["circle", "square", "blob", "l-shape"] as const) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = `shape: ${s}`;
      sel.append(opt);
    }
    sel.value = state.polyShape;
    sel.addEventListener("change", () => { state.polyShape = sel.value as State["polyShape"]; generate({ refit: true }); });
    row.append(sel);
    regionEl.append(row);
    regionEl.append(
      sliderRow("radius (m)", 160, 1500, 20, state.sizeM, (v) => { state.sizeM = v; generate({ refit: true }); })
    );
  }
}

algorithmEl.addEventListener("change", () => {
  const a = ALGORITHMS.find((x) => x.id === algorithmEl.value);
  if (!a) return;
  state.algorithm = a;
  state.params = { ...a.defaultParams("parchment") };
  gridEl.replaceChildren();
  syncPresetDropdown();
  buildParamControls();
  buildRegionControls();
  generate({ refit: true });
});

presetEl.addEventListener("change", () => {
  if (presetEl.value === "__custom__") return;
  const preset = presetById(state.algorithm, presetEl.value);
  if (!preset) return;
  state.params = { ...preset.params };
  buildParamControls();
  generate();
});

seedEl.addEventListener("change", () => { state.seed = Number(seedEl.value) | 0; generate(); });
document.getElementById("seedPrev")!.addEventListener("click", () => { state.seed -= 1; seedEl.value = String(state.seed); generate(); });
document.getElementById("seedNext")!.addEventListener("click", () => { state.seed += 1; seedEl.value = String(state.seed); generate(); });
document.getElementById("seedRandom")!.addEventListener("click", () => {
  state.seed = (Math.random() * 0xffffffff) >>> 0;
  seedEl.value = String(state.seed);
  generate();
});
document.getElementById("regen")!.addEventListener("click", () => generate());
document.getElementById("renderGrid")!.addEventListener("click", () => void renderPresetGrid());

// ─── Boot ────────────────────────────────────────────────────────────────────

algorithmEl.value = state.algorithm.id;
syncPresetDropdown();
buildParamControls();
buildRegionControls();
generate({ refit: true });

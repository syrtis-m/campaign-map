/**
 * The pinned perceptual-golden tuple set: one approved image per
 * (algorithm, preset, seed, region). Pure — builds each tuple's region and
 * generates its features on demand, so both the CLI runner and the unit tests
 * draw from the same source of truth. Adding a registered algorithm adds its
 * default-fantasy tuple automatically.
 *
 * Fixed regions: polygon algorithms fill a 32-gon circle of radius 700 m at the
 * origin; line algorithms (river, wall) elaborate a gentle-S spine inside a
 * corridor sized from the algorithm's own `corridorMaxOffset`. Seed is pinned so
 * the geometry is a fixed function of the code under test.
 */
import { isPolygonKind } from "../../src/model/fabric";
import {
  allAlgorithms,
  presetById,
  type ProcgenAlgorithm,
} from "../../src/gen/procgen/registry";
import {
  makeRegion,
  makeSpine,
  makeCorridorRegion,
  type ProcgenRegion,
} from "../../src/gen/region";
import type { GenerationConstraints } from "../../src/gen/types";

type Pt = [number, number];

export const SEED = 42;
export const CIRCLE_RADIUS_M = 700;
export const SPINE_LENGTH_M = 1400;
export const DEFAULT_CORRIDOR_OFFSET = 80;
/** The fantasy theme whose per-algorithm default preset each tuple uses. */
export const FANTASY_THEME = "parchment";

const WORLD_BOUNDS = { minX: -4000, minY: -4000, maxX: 4000, maxY: 4000 };
const CONSTRAINTS: GenerationConstraints = { worldBounds: WORLD_BOUNDS };

export interface Tuple {
  name: string; // `<algorithm>-<preset>-s<seed>`
  algorithm: ProcgenAlgorithm;
  presetId: string;
  params: Record<string, unknown>;
  seed: number;
}

function isLineAlgorithm(a: ProcgenAlgorithm): boolean {
  return !isPolygonKind(a.appliesTo[0]);
}

/** 32-gon approximation of a circle, centered at the origin (playground shape). */
function circleRing(r: number): Pt[] {
  const ring: Pt[] = [];
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2;
    ring.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** The playground's gentle-S spine polyline. */
function gentleSSpine(len: number): Pt[] {
  const pts: Pt[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + (i / n) * len;
    const y = (len / 8) * Math.sin((i / n) * Math.PI * 2);
    pts.push([x, y]);
  }
  return pts;
}

export function regionFor(t: Tuple): ProcgenRegion {
  if (isLineAlgorithm(t.algorithm)) {
    const spine = makeSpine("perceptual-spine", gentleSSpine(SPINE_LENGTH_M));
    const maxOffset = t.algorithm.corridorMaxOffset?.(t.params) ?? DEFAULT_CORRIDOR_OFFSET;
    return makeCorridorRegion("perceptual-region", spine, maxOffset);
  }
  return makeRegion("perceptual-region", circleRing(CIRCLE_RADIUS_M));
}

export function featuresFor(t: Tuple): GeoJSON.Feature[] {
  return t.algorithm.generate(t.seed, regionFor(t), t.params, CONSTRAINTS);
}

function tuple(a: ProcgenAlgorithm, presetId: string): Tuple {
  const preset = presetById(a, presetId);
  if (!preset) throw new Error(`unknown preset ${a.id}/${presetId}`);
  return { name: `${a.id}-${presetId}-s${SEED}`, algorithm: a, presetId, params: { ...preset.params }, seed: SEED };
}

/**
 * The pinned tuple set: each registered algorithm's default fantasy preset, plus
 * an extra city Haussmann tuple so the two most distinct city patterns
 * (organic euro-medieval, boulevard-cut Haussmann) both have a golden.
 */
export function tuples(): Tuple[] {
  const out: Tuple[] = [];
  for (const a of allAlgorithms()) out.push(tuple(a, a.defaultPresetId(FANTASY_THEME)));
  const city = allAlgorithms().find((a) => a.id === "city");
  if (city) out.push(tuple(city, "haussmann"));
  return out;
}

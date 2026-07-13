/**
 * Forest generator (plan 022 §3.2) — the first masked-noise POLYGON algorithm.
 * Pure/headless (no DOM/map/Obsidian imports; reads only its arguments, D6):
 * a sketched `forest` polygon is the region; this fills it with a woodland
 * canopy (cells of a masked density field), punches clearings, and stipples
 * individual trees — all strictly inside the sketched ring.
 *
 * Canopy approach (pre-023 fallback, per plan 022 §3.2 + the 2026-07-13
 * decision): the plan's literal "marching squares on the masked density field"
 * is the machinery plan 023 §4.1 actually builds; until then the canopy is a
 * GLOBAL-lattice cell fill — each cell is emitted iff its (position-hashed,
 * shared-vertex-jittered) quad passes the density mask AND all four corners sit
 * inside the ring with a jitter margin. That gives containment WITHOUT clipping
 * (advisor 2026-07-13), the `density`/`clearings`/`edgeRaggedness` knobs for
 * free, and a seam-free result (every sample is a pure function of its absolute
 * world position, never of generation order or tile). Upgrades to real marching
 * squares in plan 023.
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic + seeded value noise on an absolute-world
 *    lattice, seeded only by `hashSeed(seed, salt, integer lattice indices)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property: the canopy is keyed on ABSOLUTE world position, so a
 *    ring vertex edit only changes which boundary cells pass containment — every
 *    interior cell is byte-identical (measured in the gate: edit overlap ≫
 *    re-roll overlap).
 *  - Watertight edges: corner jitter is hashed on the shared lattice VERTEX
 *    (not the cell), so the four cells meeting at a vertex displace it
 *    identically — no gaps, no overlaps.
 *  - Containment: a cell is emitted only when all corners are ≥ (jitter + margin)
 *    inside the ring, so every jittered vertex stays strictly inside.
 *  - Feature ids hash the cell's lattice indices (position, never emission
 *    order), integers so `clipNetworkToTile`'s `Number(id)` sort stays stable.
 */
import { hashSeed, mulberry32 } from "./rng";
import { fractalNoise2D } from "./world/noise";
import { distanceToBoundary, interiorT, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const FOREST_VARIETIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;
export type ForestVariety = (typeof FOREST_VARIETIES)[number];

/** Forest params (plan 022 §3.2). `density`/`clearings`/`edgeRaggedness` are
 * 0–1; `variety` is the canopy type carried onto features for theme tinting. */
export interface ForestParams {
  variety: ForestVariety;
  density: number;
  clearings: number;
  edgeRaggedness: number;
}

const FOREST_CELL_M = 26; // canopy cell size (world meters)
const TREE_CELL_M = 34; // tree stipple grid
const CANOPY_NOISE_CELL_M = 190; // fractal base cell — patch scale of the canopy
const CLEARING_NOISE_CELL_M = 150;
const JITTER_FRAC = 0.16; // corner jitter as a fraction of a cell
const TREE_JITTER_FRAC = 0.34;
const CANOPY_MARGIN_M = 1; // mm-scale slack inside the containment bound

function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Signed position-hashed offset in [-amp, amp], keyed on integer indices. */
function jitter(seed: number, salt: string, ix: number, iy: number, amp: number): Pt {
  const rng = mulberry32(hashSeed(seed, salt, ix, iy));
  return [(rng() * 2 - 1) * amp, (rng() * 2 - 1) * amp];
}

/** Jittered lattice vertex — shared by every cell meeting at (ix, iy), so the
 * canopy tessellation is watertight. */
function vertexAt(seed: number, ix: number, iy: number, amp: number): Pt {
  const [dx, dy] = jitter(seed, "forest-vtx", ix, iy, amp);
  return [ix * FOREST_CELL_M + dx, iy * FOREST_CELL_M + dy];
}

function cellPolygon(seed: number, gid: string, ix: number, iy: number, amp: number): GeoJSON.Feature {
  const a = vertexAt(seed, ix, iy, amp);
  const b = vertexAt(seed, ix + 1, iy, amp);
  const c = vertexAt(seed, ix + 1, iy + 1, amp);
  const d = vertexAt(seed, ix, iy + 1, amp);
  const ring: Pt[] = [
    [q(a[0]), q(a[1])],
    [q(b[0]), q(b[1])],
    [q(c[0]), q(c[1])],
    [q(d[0]), q(d[1])],
    [q(a[0]), q(a[1])],
  ];
  return {
    type: "Feature",
    id: hashSeed(seed, gid, ix, iy),
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { generatorId: gid, type: gid },
  };
}

/**
 * Generate a forest inside a sketched polygon region (plan 022 §3.2). Emits
 * `forest-canopy` + `forest-clearing` polygons and `forest-tree` points, all
 * strictly inside `region.ring`. `constraints` are accepted for signature
 * parity but not consumed in v1 (the city→forest interaction is plan 024's
 * cascade; forest never sees the city — one-direction rule, plan 022 §3.2).
 */
export function generateForest(
  seed: number,
  region: ProcgenRegion,
  params: ForestParams,
  _constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { variety, density, clearings, edgeRaggedness } = params;
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;

  // ── Canopy + clearing cells on the absolute-world lattice ────────────────
  const jitAmp = FOREST_CELL_M * JITTER_FRAC;
  const ix0 = Math.floor(bbox.minX / FOREST_CELL_M) - 1;
  const ix1 = Math.ceil(bbox.maxX / FOREST_CELL_M) + 1;
  const iy0 = Math.floor(bbox.minY / FOREST_CELL_M) - 1;
  const iy1 = Math.ceil(bbox.maxY / FOREST_CELL_M) + 1;
  // density 1 → threshold 0 (fill everything that passes containment);
  // density 0 → threshold 1 (almost nothing). edgeRaggedness thins the canopy
  // near the boundary (interiorT → 1 at the rim), giving a torn edge.
  const canopyThreshold = 1 - density;
  // Clearing noise (fractal) concentrates near 0.5, so the threshold must live
  // inside its active band [~0.3, ~0.72] to actually cut glades: clearings 0 →
  // 0.72 (essentially none, and the >0 guard below skips it entirely), clearings
  // 1 → 0.27 (mostly clearings).
  const clearingThreshold = 0.72 - clearings * 0.45;
  for (let ix = ix0; ix <= ix1; ix++) {
    for (let iy = iy0; iy <= iy1; iy++) {
      // Cell corners on the UN-jittered lattice; require all inside the ring
      // with margin so the jittered quad stays contained.
      const corners: Pt[] = [
        [ix * FOREST_CELL_M, iy * FOREST_CELL_M],
        [(ix + 1) * FOREST_CELL_M, iy * FOREST_CELL_M],
        [(ix + 1) * FOREST_CELL_M, (iy + 1) * FOREST_CELL_M],
        [ix * FOREST_CELL_M, (iy + 1) * FOREST_CELL_M],
      ];
      let contained = true;
      for (const [cx, cy] of corners) {
        if (distanceToBoundary(region, cx, cy) < jitAmp + CANOPY_MARGIN_M) {
          contained = false;
          break;
        }
      }
      if (!contained) continue;
      const mx = (ix + 0.5) * FOREST_CELL_M;
      const my = (iy + 0.5) * FOREST_CELL_M;
      const edgeT = Math.min(1, Math.max(0, interiorT(region, mx, my)));
      const canopy = fractalNoise2D(seed, mx, my, "forest-canopy", {
        octaves: 3,
        baseCellSize: CANOPY_NOISE_CELL_M,
        persistence: 0.55,
      });
      // Thin the canopy near the rim (edgeT → 1) in proportion to raggedness.
      if (canopy - edgeRaggedness * edgeT * 0.6 <= canopyThreshold) continue;
      const clearing = fractalNoise2D(seed, mx, my, "forest-clearing", {
        octaves: 2,
        baseCellSize: CLEARING_NOISE_CELL_M,
        persistence: 0.5,
      });
      if (clearings > 0 && clearing > clearingThreshold) {
        const f = cellPolygon(seed, "forest-clearing", ix, iy, jitAmp);
        (f.properties as Record<string, unknown>).forestType = variety;
        out.push(f);
      } else {
        const f = cellPolygon(seed, "forest-canopy", ix, iy, jitAmp);
        (f.properties as Record<string, unknown>).forestType = variety;
        out.push(f);
      }
    }
  }

  // ── Tree stipple — position-hashed jitter grid, weighted toward the edge ──
  const treeJit = TREE_CELL_M * TREE_JITTER_FRAC;
  const tx0 = Math.floor(bbox.minX / TREE_CELL_M) - 1;
  const tx1 = Math.ceil(bbox.maxX / TREE_CELL_M) + 1;
  const ty0 = Math.floor(bbox.minY / TREE_CELL_M) - 1;
  const ty1 = Math.ceil(bbox.maxY / TREE_CELL_M) + 1;
  for (let ix = tx0; ix <= tx1; ix++) {
    for (let iy = ty0; iy <= ty1; iy++) {
      const [dx, dy] = jitter(seed, "forest-tree-jit", ix, iy, treeJit);
      const px = (ix + 0.5) * TREE_CELL_M + dx;
      const py = (iy + 0.5) * TREE_CELL_M + dy;
      if (distanceToBoundary(region, px, py) < CANOPY_MARGIN_M) continue;
      const edgeT = Math.min(1, Math.max(0, interiorT(region, px, py)));
      // Trees cluster toward the ragged edge (the stipple that sells "forest")
      // and scale with density; deterministic per-cell roll.
      const chance = Math.min(0.9, (0.25 + 0.55 * edgeT) * (0.5 + 0.5 * density));
      const roll = mulberry32(hashSeed(seed, "forest-tree-place", ix, iy))();
      if (roll >= chance) continue;
      out.push({
        type: "Feature",
        id: hashSeed(seed, "forest-tree", ix, iy),
        geometry: { type: "Point", coordinates: [q(px), q(py)] },
        properties: { generatorId: "forest-tree", type: "forest-tree", forestType: variety },
      });
    }
  }

  return out;
}

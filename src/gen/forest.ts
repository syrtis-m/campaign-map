/**
 * Forest generator (plan 022 §3.2, tree placement overhauled in plan 026-A) —
 * the first masked-noise POLYGON algorithm. Pure/headless (no DOM/map/Obsidian
 * imports; reads only its arguments, D6): a sketched `forest` polygon is the
 * region; this fills it with a woodland canopy (cells of a masked density
 * field), punches clearings, and scatters individual trees as hashed
 * Thomas clusters — all strictly inside the sketched ring.
 *
 * Tree placement (plan 026-A §1.1 — replaces the plan-022 stipple grid, whose
 * low-jitter lattice always read as a grid per Red Blob Games' point-set
 * research):  a two-scale hashed Neyman–Scott / Thomas cluster process.
 *  - CLUMP PARENTS on a coarse absolute-world lattice, existence gated by a
 *    low-frequency fBm mask (dense patches, thin gaps), jittered off-grid.
 *  - OFFSPRING per parent: a hashed count, polar offsets with radial falloff.
 *  - LONERS on a sparse high-jitter lattice between clumps, rejected against
 *    the RAW (containment-independent) clump-tree positions in the 3×3
 *    neighbouring parent cells — bounded, order-free, edit-local.
 *  - Per-variety knobs (broadleaf strongly clumped, conifer near-regular,
 *    swamp rim-biased, dead-wood loners only, mixed medium) — §1.1.
 *  - Emits `forestType`, `sizeN` (0–1, low-freq correlated size field biased
 *    up at clump cores), `rank` (0 core / 1 fringe / 2 loner — paint fades
 *    loners), `variant` (0–3 hashed glyph pick, consumed by phase C).
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
const CANOPY_NOISE_CELL_M = 190; // fractal base cell — patch scale of the canopy
const CLEARING_NOISE_CELL_M = 150;
const JITTER_FRAC = 0.16; // corner jitter as a fraction of a cell
const CANOPY_MARGIN_M = 1; // mm-scale slack inside the containment bound

// ── Tree placement (plan 026-A §1.1) — all lattices absolute-world ───────────
const CLUMP_CELL_M = 110; // coarse clump-parent lattice (§1.1 "start 110 m")
const CLUMP_JITTER_FRAC = 0.4; // parent offset within its cell (off-grid)
const CLUMP_MASK_CELL_M = 320; // low-freq fBm cell gating parent existence
const LONER_CELL_M = 60; // sparse between-clump loner lattice
const LONER_JITTER_FRAC = 0.65; // §1.1 "high jitter (~0.65 of spacing)"
const LONER_REJECT_M = 15; // loner min distance to any raw clump tree
const SIZE_NOISE_CELL_M = 230; // low-freq size field (neighbours correlated)
const TREE_MARGIN_M = 1; // containment slack for a tree point

/** Per-variety Thomas-cluster shape (plan 026-A §1.1). `clumpThreshold` is the
 * fBm mask cutoff for a parent to exist (higher ⇒ fewer clumps); `clumpsEnabled`
 * false ⇒ loners only (dead-wood). `edgeBias` pulls trees toward the rim
 * (swamp). Counts/probabilities are scaled by `density` at run time. */
interface VarietyPlacement {
  clumpsEnabled: boolean;
  clumpThreshold: number;
  offMin: number;
  offMax: number;
  clumpRadius: number; // offspring spread (m)
  lonerProb: number; // base loner emission probability per cell
  edgeBias: number; // 0 uniform … 1 strongly rim-biased
}

const PLACEMENT: Record<ForestVariety, VarietyPlacement> = {
  // Strongly clumped: fewer, fuller clumps + few loners.
  broadleaf: { clumpsEnabled: true, clumpThreshold: 0.44, offMin: 5, offMax: 12, clumpRadius: 34, lonerProb: 0.1, edgeBias: 0.2 },
  // Near-regular: almost every cell seeds a small tight clump ⇒ low dispersion.
  conifer: { clumpsEnabled: true, clumpThreshold: 0.2, offMin: 2, offMax: 4, clumpRadius: 17, lonerProb: 0.28, edgeBias: 0.1 },
  // Medium clustering (the interleaved default).
  mixed: { clumpsEnabled: true, clumpThreshold: 0.46, offMin: 3, offMax: 8, clumpRadius: 27, lonerProb: 0.18, edgeBias: 0.2 },
  // Sparse + biased to the boundary rim.
  swamp: { clumpsEnabled: true, clumpThreshold: 0.56, offMin: 2, offMax: 5, clumpRadius: 24, lonerProb: 0.14, edgeBias: 0.78 },
  // Bare stand: scattered loners only, no clumps (canopy still emits in 026-A;
  // its removal is 026-B).
  "dead-wood": { clumpsEnabled: false, clumpThreshold: 1, offMin: 0, offMax: 0, clumpRadius: 20, lonerProb: 0.3, edgeBias: 0.3 },
};

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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clump parent for lattice cell `(cix,ciy)` (plan 026-A §1.1). Exists iff a
 * low-frequency fBm mask clears `threshold` (dense patches, thin gaps); its
 * position is the cell centre pushed off-grid by a hashed offset. Pure
 * f(seed, variety, indices) — never emission order, never floats-as-seed. */
function clumpParent(
  seed: number,
  variety: ForestVariety,
  threshold: number,
  cix: number,
  ciy: number
): Pt | null {
  const mcx = (cix + 0.5) * CLUMP_CELL_M;
  const mcy = (ciy + 0.5) * CLUMP_CELL_M;
  const mask = fractalNoise2D(seed, mcx, mcy, `forest-clump-${variety}`, {
    octaves: 2,
    baseCellSize: CLUMP_MASK_CELL_M,
    persistence: 0.5,
  });
  if (mask < threshold) return null;
  const [dx, dy] = jitter(seed, `forest-clump-off-${variety}`, cix, ciy, CLUMP_CELL_M * CLUMP_JITTER_FRAC);
  return [mcx + dx, mcy + dy];
}

interface Offspring {
  px: number;
  py: number;
  rNorm: number; // 0 at the core, 1 at the clump rim
}

/** RAW offspring of a clump — computed WITHOUT the containment cull, so a loner
 * reject and an emitted-tree loop agree and so loner acceptance is a pure
 * function of seed+position (edit-local; a ring edit only changes the final
 * containment test, never the candidate set). One independent rng stream per
 * clump cell drives the count then each polar offset (sqrt radial falloff packs
 * offspring toward the core). */
function clumpOffspring(
  seed: number,
  variety: ForestVariety,
  cfg: VarietyPlacement,
  countScale: number,
  parent: Pt,
  cix: number,
  ciy: number
): Offspring[] {
  const rng = mulberry32(hashSeed(seed, `forest-off-${variety}`, cix, ciy));
  const base = cfg.offMin + Math.floor(rng() * (cfg.offMax - cfg.offMin + 1));
  const count = Math.max(0, Math.round(base * countScale));
  const out: Offspring[] = [];
  for (let k = 0; k < count; k++) {
    const a = rng() * Math.PI * 2;
    const rNorm = Math.sqrt(rng());
    const r = rNorm * cfg.clumpRadius;
    out.push({ px: parent[0] + Math.cos(a) * r, py: parent[1] + Math.sin(a) * r, rNorm });
  }
  return out;
}

/** Is `(px,py)` within `LONER_REJECT_M` of any raw clump tree in the 3×3
 * neighbouring clump cells? Bounded (a clump tree reaches at most ~78 m past
 * its 110 m cell, so a 15 m rejection is always inside the 3×3 window) and
 * order-free. */
function nearClumpTree(
  seed: number,
  variety: ForestVariety,
  cfg: VarietyPlacement,
  countScale: number,
  threshold: number,
  px: number,
  py: number
): boolean {
  const ccx = Math.floor(px / CLUMP_CELL_M);
  const ccy = Math.floor(py / CLUMP_CELL_M);
  const r2 = LONER_REJECT_M * LONER_REJECT_M;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const parent = clumpParent(seed, variety, threshold, ccx + dx, ccy + dy);
      if (!parent) continue;
      for (const kd of clumpOffspring(seed, variety, cfg, countScale, parent, ccx + dx, ccy + dy)) {
        const ex = kd.px - px;
        const ey = kd.py - py;
        if (ex * ex + ey * ey < r2) return true;
      }
    }
  }
  return false;
}

/** `sizeN` in [0,1] from a LOW-FREQ noise field (so neighbours are correlated —
 * same-age stands, never iid per tree), biased up by `coreBias` near clump
 * cores (plan 026-A §1.1). */
function sizeAt(seed: number, variety: ForestVariety, px: number, py: number, coreBias: number): number {
  const n = fractalNoise2D(seed, px, py, `forest-size-${variety}`, {
    octaves: 2,
    baseCellSize: SIZE_NOISE_CELL_M,
    persistence: 0.5,
  });
  return clamp01(0.12 + 0.72 * n + coreBias);
}

/** A tree point feature. `id` hashes the salt + integer lattice indices
 * (position, never emission order — D-invariant). Carries the paint hooks
 * `forestType`/`sizeN`/`rank`/`variant` (plan 026-A §1.1). */
function treeFeature(
  seed: number,
  idSalt: string,
  ids: number[],
  px: number,
  py: number,
  variety: ForestVariety,
  sizeN: number,
  rank: number,
  variant: number
): GeoJSON.Feature {
  return {
    type: "Feature",
    id: hashSeed(seed, idSalt, ...ids),
    geometry: { type: "Point", coordinates: [q(px), q(py)] },
    properties: {
      generatorId: "forest-tree",
      type: "forest-tree",
      forestType: variety,
      sizeN: q(sizeN),
      rank,
      variant,
    },
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

  // ── Trees — hashed Thomas clusters (plan 026-A §1.1) ─────────────────────
  const cfg = PLACEMENT[variety];
  const countScale = 0.55 + 0.6 * density; // more offspring in denser forests
  // Denser forests seed more clumps too (the fBm mask cutoff drops with density).
  const clumpThreshold = clamp01(cfg.clumpThreshold + (0.5 - density) * 0.3);

  if (cfg.clumpsEnabled) {
    const cix0 = Math.floor(bbox.minX / CLUMP_CELL_M) - 1;
    const cix1 = Math.ceil(bbox.maxX / CLUMP_CELL_M) + 1;
    const ciy0 = Math.floor(bbox.minY / CLUMP_CELL_M) - 1;
    const ciy1 = Math.ceil(bbox.maxY / CLUMP_CELL_M) + 1;
    for (let cix = cix0; cix <= cix1; cix++) {
      for (let ciy = ciy0; ciy <= ciy1; ciy++) {
        const parent = clumpParent(seed, variety, clumpThreshold, cix, ciy);
        if (!parent) continue;
        const kids = clumpOffspring(seed, variety, cfg, countScale, parent, cix, ciy);
        for (let k = 0; k < kids.length; k++) {
          const { px, py, rNorm } = kids[k];
          if (distanceToBoundary(region, px, py) < TREE_MARGIN_M) continue;
          // Rim bias (swamp): keep interior trees with rising probability toward
          // the boundary. Per-tree hashed roll — independent of emission order.
          if (cfg.edgeBias > 0) {
            const edgeT = clamp01(interiorT(region, px, py));
            const keep = 1 - cfg.edgeBias + cfg.edgeBias * edgeT;
            if (mulberry32(hashSeed(seed, `forest-edge-${variety}`, cix, ciy, k))() >= keep) continue;
          }
          const rank = rNorm < 0.55 ? 0 : 1; // 0 core, 1 fringe
          const sizeN = sizeAt(seed, variety, px, py, 0.28 * (1 - rNorm));
          const variant = Math.floor(mulberry32(hashSeed(seed, `forest-var-${variety}`, cix, ciy, k))() * 4);
          out.push(treeFeature(seed, "forest-tree", [cix, ciy, k], px, py, variety, sizeN, rank, variant));
        }
      }
    }
  }

  // Loners between clumps: sparse, high-jitter lattice, rejected against the raw
  // clump trees in the 3×3 neighbouring parent cells (rank 2).
  const lonerJit = LONER_CELL_M * LONER_JITTER_FRAC;
  const lonerProb = clamp01(cfg.lonerProb * (0.5 + 0.5 * density));
  const lx0 = Math.floor(bbox.minX / LONER_CELL_M) - 1;
  const lx1 = Math.ceil(bbox.maxX / LONER_CELL_M) + 1;
  const ly0 = Math.floor(bbox.minY / LONER_CELL_M) - 1;
  const ly1 = Math.ceil(bbox.maxY / LONER_CELL_M) + 1;
  for (let lix = lx0; lix <= lx1; lix++) {
    for (let liy = ly0; liy <= ly1; liy++) {
      if (mulberry32(hashSeed(seed, `forest-loner-${variety}`, lix, liy))() >= lonerProb) continue;
      const [jx, jy] = jitter(seed, `forest-loner-jit-${variety}`, lix, liy, lonerJit);
      const px = (lix + 0.5) * LONER_CELL_M + jx;
      const py = (liy + 0.5) * LONER_CELL_M + jy;
      if (distanceToBoundary(region, px, py) < TREE_MARGIN_M) continue;
      if (cfg.clumpsEnabled && nearClumpTree(seed, variety, cfg, countScale, clumpThreshold, px, py)) continue;
      if (cfg.edgeBias > 0) {
        const edgeT = clamp01(interiorT(region, px, py));
        const keep = 1 - cfg.edgeBias + cfg.edgeBias * edgeT;
        if (mulberry32(hashSeed(seed, `forest-loner-edge-${variety}`, lix, liy))() >= keep) continue;
      }
      const sizeN = sizeAt(seed, variety, px, py, 0);
      const variant = Math.floor(mulberry32(hashSeed(seed, `forest-loner-var-${variety}`, lix, liy))() * 4);
      out.push(treeFeature(seed, "forest-loner", [lix, liy], px, py, variety, sizeN, 2, variant));
    }
  }

  return out;
}

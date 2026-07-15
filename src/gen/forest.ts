/**
 * Forest generator — the first masked-noise POLYGON algorithm. Pure/headless
 * (no DOM/map/Obsidian imports; reads only its arguments): a sketched `forest`
 * polygon is the region; this fills it with a woodland canopy (a masked density
 * field), punches clearings, and scatters individual trees as hashed Thomas
 * clusters — all strictly inside the sketched ring.
 *
 * Tree placement: a two-scale hashed Neyman–Scott / Thomas cluster process (a
 * low-jitter stipple lattice always reads as a grid, per Red Blob Games'
 * point-set research).
 *  - CLUMP PARENTS on a coarse absolute-world lattice, existence gated by a
 *    low-frequency fBm mask (dense patches, thin gaps), jittered off-grid.
 *  - OFFSPRING per parent: a hashed count, polar offsets with radial falloff.
 *  - LONERS on a sparse high-jitter lattice between clumps, rejected against
 *    the RAW (containment-independent) clump-tree positions in the 3×3
 *    neighbouring parent cells — bounded, order-free, edit-local.
 *  - Per-variety knobs (broadleaf strongly clumped, conifer near-regular,
 *    swamp rim-biased, dead-wood loners only, mixed medium).
 *  - Emits `forestType`, `sizeN` (0–1, low-freq correlated size field biased
 *    up at clump cores), `rank` (0 core / 1 fringe / 2 loner — paint fades
 *    loners), `variant` (0–3 hashed glyph pick, consumed by phase C).
 *
 * Canopy approach: the canopy is ONE `forest-canopy` MultiPolygon traced from a
 * masked density field with the marching-squares module. The field is
 *   F(p) = min( warp(fbm)(p) + Σ metaball(clump parentᵢ) − edgeFade − clearing
 *               − threshold ,  sdf(p) − CONTAIN )
 * traced at level 0, Chaikin-smoothed, and nested into exteriors + clearing
 * holes (fields/polygons.ts). Domain-warping the noise (Iñigo Quílez) frays the
 * outline into a hand-drawn edge; the metaball bumps around the tree-clump
 * parents scallop it toward the clumps (the classic fantasy cloud edge); the
 * `sdf − CONTAIN` term is a hard containment floor so the canopy sits ≥ CONTAIN
 * metres inside the ring WITHOUT a polygon clip (a Chaikin pass only ever pulls
 * the boundary further in). The three params keep their meanings: `density`
 * moves the threshold, `clearings` scales the interior subtraction (holes),
 * `edgeRaggedness` scales the warp amplitude + rim fade. `dead-wood` emits NO
 * canopy (bare stand — instant variety differentiation). Everything is a local
 * function of absolute world position + the persisted seed (the containment
 * floor and rim fade read the LOCAL signed distance, never the global
 * `interiorT`/`maxInteriorDistance`), so a rim vertex edit only re-extracts the
 * boundary-adjacent cells — interior canopy is unchanged (edit-locality), and
 * abutting/whole-artifact clips are seam-free (world-aligned lattice).
 *
 * Determinism:
 *  - Closed-form arithmetic + seeded value noise on an absolute-world lattice,
 *    seeded only by `hashSeed(seed, salt, integer lattice indices)`; every
 *    emitted coordinate is mm-quantized before it leaves.
 *  - Identity property: the canopy is keyed on ABSOLUTE world position, so a
 *    ring vertex edit only changes which boundary cells pass containment — every
 *    interior cell is unchanged (edit overlap ≫ re-roll overlap).
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
import {
  signedDistancePolygon,
  fDomainWarp,
  metaballField,
  chaikinClosed,
  contoursToMultiPolygon,
  marchingSquares,
  type Field,
} from "./fields";
import { buildUpstreamWaterField, insideUpstreamChannel } from "./upstream";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const FOREST_VARIETIES = ["broadleaf", "conifer", "mixed", "swamp", "dead-wood"] as const;
export type ForestVariety = (typeof FOREST_VARIETIES)[number];

/** Forest params. `density`/`clearings`/`edgeRaggedness` are 0–1; `variety` is
 * the canopy type carried onto features for theme tinting. */
export interface ForestParams {
  variety: ForestVariety;
  density: number;
  clearings: number;
  edgeRaggedness: number;
}

// ── Organic canopy — marching-squares density field ──────────────────────────
const CANOPY_NOISE_CELL_M = 190; // fractal base cell — patch scale of the canopy
const CLEARING_NOISE_CELL_M = 150; // clearing (hole) noise scale
const CANOPY_LATTICE_M = 12; // marching-squares sampling step (world-aligned)
const CANOPY_CONTAIN_M = 3; // hard containment floor: canopy stays ≥ this inside
const CANOPY_WARP_CELL_M = 120; // domain-warp noise scale
const CANOPY_WARP_BASE_M = 26; // base warp amplitude (× edgeRaggedness)
const CANOPY_EDGE_BAND_M = 55; // rim-fade band (torn inset edge)
const CANOPY_METABALL_RADIUS_M = 130; // clump-parent bump radius (~1.2 × clump cell)
const CANOPY_METABALL_STRENGTH = 0.14; // density bump per clump parent
const CANOPY_CLEARING_AMP = 0.6; // how deep a clearing subtracts (punches holes)
const CANOPY_CLEARING_W = 0.12; // clearing-edge softness band
const CANOPY_CHAIKIN_PASSES = 2; // corner-cutting rounds (staircase → organic)

// ── Tree placement — all lattices absolute-world ─────────────────────────────
const CLUMP_CELL_M = 110; // coarse clump-parent lattice
const CLUMP_JITTER_FRAC = 0.4; // parent offset within its cell (off-grid)
const CLUMP_MASK_CELL_M = 320; // low-freq fBm cell gating parent existence
const LONER_CELL_M = 60; // sparse between-clump loner lattice
const LONER_JITTER_FRAC = 0.65; // high jitter (~0.65 of spacing)
const LONER_REJECT_M = 15; // loner min distance to any raw clump tree
const SIZE_NOISE_CELL_M = 230; // low-freq size field (neighbours correlated)
const TREE_MARGIN_M = 1; // containment slack for a tree point

// ── River channel exclusion + riparian ramp (plan 037, river → forest) ───────
// The GENERATED meandered channel (`constraints.upstream.water`) is read as an
// SDF (positive inside). No canopy/tree geometry sits inside it, and within a
// fixed band of the bank the canopy density ramps UP toward the water (a
// riparian buffer: lush growth hugging the river). ~4–6 channel widths for a
// typical ~20 m river ⇒ a fixed 100 m band. All keyed on absolute world
// position (seam-safe); with NO upstream water the field is null and every path
// below is skipped ⇒ byte-identical to the uncoupled forest.
const RIPARIAN_BAND_M = 100; // riparian ramp reach from the bank (≈4–6 widths)
const RIPARIAN_STRENGTH = 0.22; // canopy-density bump at the bank (fades to 0 at band edge)

/** Per-variety Thomas-cluster shape. `clumpThreshold` is the
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
  // Bare stand: scattered loners only, no clumps, no canopy.
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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Clump parent for lattice cell `(cix,ciy)`. Exists iff a
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
 * cores. */
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
 * `forestType`/`sizeN`/`rank`/`variant`. */
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

/** Every clump parent whose cell overlaps the region bbox (grown by the
 * metaball radius so an off-bbox clump still bumps the rim). These are the
 * metaball anchors — the canopy scallops around the SAME clump parents that
 * seed the trees, aligning the cloud edge with the visible clumps. Pure
 * f(seed, variety, threshold, indices). */
function collectClumpParents(
  seed: number,
  variety: ForestVariety,
  threshold: number,
  bbox: ProcgenRegion["bbox"]
): Pt[] {
  const m = CANOPY_METABALL_RADIUS_M;
  const cx0 = Math.floor((bbox.minX - m) / CLUMP_CELL_M);
  const cx1 = Math.ceil((bbox.maxX + m) / CLUMP_CELL_M);
  const cy0 = Math.floor((bbox.minY - m) / CLUMP_CELL_M);
  const cy1 = Math.ceil((bbox.maxY + m) / CLUMP_CELL_M);
  const out: Pt[] = [];
  for (let cix = cx0; cix <= cx1; cix++) {
    for (let ciy = cy0; ciy <= cy1; ciy++) {
      const p = clumpParent(seed, variety, threshold, cix, ciy);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * The organic canopy MultiPolygon coordinates — see the module JSDoc for the
 * field. Returns [] when nothing crosses the threshold (a very
 * sparse forest). `dead-wood` never reaches here (bare stand, no canopy).
 */
function buildCanopy(
  seed: number,
  region: ProcgenRegion,
  params: ForestParams,
  clumpThreshold: number,
  channel: Field | null
): Pt[][][] {
  const { variety, density, clearings, edgeRaggedness } = params;
  const ring = region.ring;
  const bbox = region.bbox;

  // Domain-warp offsets (edgeRaggedness scales the amplitude → frayed edge).
  const warpAmp = CANOPY_WARP_BASE_M * (0.4 + 0.9 * clamp01(edgeRaggedness));
  const warpOpts = { octaves: 2, baseCellSize: CANOPY_WARP_CELL_M, persistence: 0.5 };
  const wx: Field = (x, y) => (fractalNoise2D(seed, x, y, "forest-warp-x", warpOpts) - 0.5) * 2 * warpAmp;
  const wy: Field = (x, y) => (fractalNoise2D(seed, x, y, "forest-warp-y", warpOpts) - 0.5) * 2 * warpAmp;
  const baseNoise: Field = (x, y) =>
    fractalNoise2D(seed, x, y, "forest-canopy", { octaves: 3, baseCellSize: CANOPY_NOISE_CELL_M, persistence: 0.55 });
  const warped = fDomainWarp(baseNoise, wx, wy);

  // Metaball anchors (tree-clump parents) + potential field.
  const anchors = collectClumpParents(seed, variety, clumpThreshold, bbox);
  const meta = metaballField(anchors, CANOPY_METABALL_RADIUS_M, CANOPY_METABALL_STRENGTH);

  const canopyThreshold = 0.5 - 0.42 * clamp01(density);
  const clearingThreshold = 0.72 - clamp01(clearings) * 0.4;

  // F(p): density value − threshold, capped by the signed-distance containment
  // floor. Near/outside the inset the containment term governs (a clean arc at
  // sdf = CONTAIN) so nothing spills; deeper in, the warped noise + metaballs +
  // clearing holes shape the outline. sdf is LOCAL (never interiorT), so a rim
  // edit stays local.
  const field: Field = (x, y) => {
    const sd = signedDistancePolygon(ring, x, y);
    const contain = sd - CANOPY_CONTAIN_M;
    if (contain <= 0) return contain; // rim band / outside — containment governs
    // River channel exclusion (plan 037): no canopy inside the generated
    // channel — force the field strictly negative there (< the −CONTAIN rim
    // band so the traced boundary hugs the bank). `channel === null` (no
    // upstream water) skips this entirely ⇒ byte-identical uncoupled canopy.
    let cd = -Infinity;
    if (channel) {
      cd = channel(x, y);
      if (cd >= 0) return -CANOPY_CONTAIN_M - 1;
    }
    let v = warped(x, y) + meta(x, y);
    // Riparian ramp: within RIPARIAN_BAND of the bank (cd is the NEGATIVE
    // signed distance outside the channel; nearer the bank ⇒ nearer 0), add
    // density ∝ proximity — a lush buffer that fades to 0 at the band edge.
    if (channel && cd > -RIPARIAN_BAND_M) {
      v += RIPARIAN_STRENGTH * (cd + RIPARIAN_BAND_M) / RIPARIAN_BAND_M;
    }
    // Torn inset edge: fade the canopy toward the rim ∝ edgeRaggedness (local sd).
    if (sd < CANOPY_EDGE_BAND_M) {
      const e = (CANOPY_EDGE_BAND_M - sd) / CANOPY_EDGE_BAND_M; // 0 at band → 1 at rim
      v -= edgeRaggedness * 0.5 * e * e;
    }
    // Clearings: subtract a smooth bump where the clearing noise is high → holes.
    if (clearings > 0) {
      const c = fractalNoise2D(seed, x, y, "forest-clearing", {
        octaves: 2,
        baseCellSize: CLEARING_NOISE_CELL_M,
        persistence: 0.5,
      });
      if (c > clearingThreshold) {
        const t = Math.min(1, (c - clearingThreshold) / CANOPY_CLEARING_W);
        v -= CANOPY_CLEARING_AMP * t * t * (3 - 2 * t);
      }
    }
    return Math.min(v - canopyThreshold, contain);
  };

  // World-aligned lattice, bbox grown one cell so the F<0 border fully encloses
  // every canopy loop (all rings close → no open lines running off the lattice).
  const grown = {
    minX: bbox.minX - CANOPY_LATTICE_M,
    minY: bbox.minY - CANOPY_LATTICE_M,
    maxX: bbox.maxX + CANOPY_LATTICE_M,
    maxY: bbox.maxY + CANOPY_LATTICE_M,
  };
  const contours = marchingSquares(field, { bbox: grown, step: CANOPY_LATTICE_M, levels: [0] });
  const rings: Pt[][] = [];
  for (const c of contours) {
    if (!c.closed) continue; // an open line can't bound a filled region
    rings.push(chaikinClosed(c.points, CANOPY_CHAIKIN_PASSES));
  }
  return contoursToMultiPolygon(rings);
}

/**
 * Generate a forest inside a sketched polygon region. Emits ONE `forest-canopy`
 * MultiPolygon (organic mass with clearing holes; `dead-wood` emits none) and
 * `forest-tree` points, all strictly inside `region.ring`. `constraints` are
 * accepted for signature parity but not consumed — forest never sees the city
 * (one-direction rule).
 */
export function generateForest(
  seed: number,
  region: ProcgenRegion,
  params: ForestParams,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { variety, density } = params;
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  // River channel (plan 037): the generated meandered channel as an SDF
  // (positive inside). null when there is no upstream water ⇒ every coupled
  // path below is a no-op and the forest is byte-identical to the uncoupled
  // generator. The one upstream read forest makes — a stage-0 OUTPUT edge, not
  // a raw sketch (`consumesSketch` stays []).
  const channel = buildUpstreamWaterField(constraints.upstream);

  const cfg = PLACEMENT[variety];
  const countScale = 0.55 + 0.6 * density; // more offspring in denser forests
  // Denser forests seed more clumps too (the fBm mask cutoff drops with density).
  const clumpThreshold = clamp01(cfg.clumpThreshold + (0.5 - density) * 0.3);

  // ── Canopy: ONE organic MultiPolygon. dead-wood = bare stand, no leaf mass →
  //    no canopy (instant variety differentiation). ──────────────────────────
  if (variety !== "dead-wood") {
    const coords = buildCanopy(seed, region, params, clumpThreshold, channel);
    if (coords.length > 0) {
      out.push({
        type: "Feature",
        id: hashSeed(seed, "forest-canopy", region.id),
        geometry: { type: "MultiPolygon", coordinates: coords },
        properties: { generatorId: "forest-canopy", type: "forest-canopy", forestType: variety },
      });
      // Rim: every canopy ring (exterior + clearing holes) as its OWN
      // LineString, so the tile clip runs it through `clipPolylineToBBox` — which
      // cuts the boundary at a tile edge WITHOUT synthesizing a segment along the
      // seam. A `line` layer on the MultiPolygon itself would instead stroke the
      // clip-induced tile edges (visible grid lines); a separate line feature is
      // the seam-free rim. id hashes the ring's first vertex (position, never
      // emission order).
      let ringIx = 0;
      for (const poly of coords) {
        for (const ring of poly) {
          const [fx, fy] = ring[0];
          out.push({
            type: "Feature",
            id: hashSeed(seed, "forest-canopy-rim", region.id, ringIx++, Math.round(fx * 10), Math.round(fy * 10)),
            geometry: { type: "LineString", coordinates: ring.map(([x, y]) => [q(x), q(y)] as Pt) },
            properties: { generatorId: "forest-canopy-rim", type: "forest-canopy-rim", forestType: variety },
          });
        }
      }
    }
  }

  // ── Trees — hashed Thomas clusters ───────────────────────────────────────
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
          if (insideUpstreamChannel(channel, px, py)) continue; // no trees in the channel
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
      if (insideUpstreamChannel(channel, px, py)) continue; // no loners in the channel
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

/**
 * Adjacent-district shared-edge agreement (plan 038.6, city ↔ city same-stage).
 *
 * Where two district sketch rings share an edge within ε, BOTH sides derive
 * 1–3 matching arterial-grade stubs + gates by HASHING the shared-edge geometry
 * alone — the tile-seam pattern. Neither region ever reads the other's OUTPUT
 * (only the neighbour's sketch RING, already in `constraints.fabricFeatures`),
 * so the two independent runs place their on-edge gate points at BIT-IDENTICAL
 * coordinates and the stubs meet exactly on the shared boundary.
 *
 * Determinism / seam argument:
 *  - The shared edge is canonicalized SYMMETRICALLY: each shared corner is the
 *    mm-quantized midpoint of the two matched endpoints (my ring edge + the
 *    neighbour's edge), and the two corners are sorted lexicographically. Both
 *    regions see the same two endpoints (mine ↔ theirs is symmetric) ⇒ identical
 *    canonical edge, robust to sub-ε sketch jitter.
 *  - Count and parametric positions hash the canonical edge under a FIXED salt
 *    (never `citySeed`, which differs per region), so both sides agree on how
 *    many stubs and where.
 *  - The gate point P(u) = lerp(cA, cB, u) is mm-quantized identically on both
 *    sides. Only the INWARD stub direction differs (each aims into its own
 *    interior) — the on-edge endpoint the seam test checks is bit-equal.
 *
 * Pure / headless: reads only its arguments (region ring + sketch districts) and
 * `regionContains`. Empty when no neighbouring district shares an edge ⇒ the
 * whole pass is byte-inert (an isolated city is unchanged).
 */
import { hashSeed, mulberry32 } from "../rng";
import type { GenerationConstraints } from "../types";
import { regionContains, type ProcgenRegion } from "../region";
import type { FabricFeature } from "../../model/fabric";

type Pt = [number, number];

/** Endpoint match tolerance (m) for "these two ring edges are the shared edge".
 * Tight — an exact fixture shares endpoints at ε = 0; real sketches within a
 * metre still agree (the canonicalization averages the two). */
export const SHARED_EDGE_EPS_M = 1.5;
/** A shared edge shorter than this hosts no stubs (a degenerate contact). */
export const MIN_SHARED_EDGE_M = 24;
/** Arterial stub length inward from the shared edge (m), shortened on demand to
 * stay inside the region. */
export const STUB_LEN_M = 45;
/** Fixed salt so BOTH regions hash the shared edge into the same stream — never
 * `citySeed` (per-region). */
const SHARED_EDGE_SALT = 0x5ba7;

/** mm quantization (matches index.ts's emission `q`). */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface SharedEdgeOutput {
  /** On-edge gate points (mm-quantized) — bit-identical between the two regions. */
  gates: Pt[];
  /** Arterial stubs, each a 2-point polyline from a gate inward; `key` is
   * position-derived for a stable feature id. */
  stubs: { coords: Pt[]; key: string }[];
}

const EMPTY: SharedEdgeOutput = { gates: [], stubs: [] };

/** Other-district sketch rings (Polygon `district` features that are NOT this
 * region), open (closing vertex stripped), mm-quantized. */
function otherDistrictRings(features: FabricFeature[] | undefined, selfId: string): Pt[][] {
  if (!features || features.length === 0) return [];
  const rings: Pt[][] = [];
  for (const f of features) {
    if (f.id === selfId) continue;
    if (f.properties.kind !== "district") continue;
    const g = f.geometry;
    if (g.type !== "Polygon") continue;
    const ring = (g.coordinates[0] as Pt[]).map((p): Pt => [q(p[0]), q(p[1])]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function near(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) <= SHARED_EDGE_EPS_M && Math.abs(a[1] - b[1]) <= SHARED_EDGE_EPS_M;
}

/** Canonical shared corner = mm-quantized midpoint of the two matched endpoints
 * (symmetric: mine↔theirs gives the same value from either region). */
function corner(a: Pt, b: Pt): Pt {
  return [q((a[0] + b[0]) / 2), q((a[1] + b[1]) / 2)];
}

/** Lexicographic order so the canonical edge is orientation-free. */
function lexLess(a: Pt, b: Pt): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/**
 * Compute the shared-edge stubs + gates for `region` against every OTHER
 * district sketch ring in `constraints`. See the module header for the seam
 * argument. Returns EMPTY when nothing is adjacent.
 */
export function sharedEdgeStubs(
  citySeed: number,
  region: ProcgenRegion,
  constraints: GenerationConstraints
): SharedEdgeOutput {
  const others = otherDistrictRings(constraints.fabricFeatures, region.id);
  if (others.length === 0) return EMPTY;
  const ring = region.ring; // closed, CCW, mm-quantized
  const gates: Pt[] = [];
  const stubs: { coords: Pt[]; key: string }[] = [];
  const seenEdges = new Set<string>();

  for (let i = 0; i < ring.length - 1; i++) {
    const ma: Pt = ring[i];
    const mb: Pt = ring[i + 1];
    // Find a neighbour edge matching this ring edge (either direction).
    let match: { oa: Pt; ob: Pt } | null = null;
    for (const other of others) {
      for (let j = 0; j < other.length - 1; j++) {
        const oa = other[j];
        const ob = other[j + 1];
        if (near(ma, oa) && near(mb, ob)) {
          match = { oa, ob };
          break;
        }
        if (near(ma, ob) && near(mb, oa)) {
          match = { oa: ob, ob: oa };
          break;
        }
      }
      if (match) break;
    }
    if (!match) continue;

    // Symmetric canonical edge from the two matched endpoint pairs.
    let cA = corner(ma, match.oa);
    let cB = corner(mb, match.ob);
    if (!lexLess(cA, cB)) {
      const t = cA;
      cA = cB;
      cB = t;
    }
    const edgeKey = `${cA[0]},${cA[1]}>${cB[0]},${cB[1]}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    const ex = cB[0] - cA[0];
    const ey = cB[1] - cA[1];
    const len = Math.hypot(ex, ey);
    if (len < MIN_SHARED_EDGE_M) continue;

    // Count (1–3) + parametric positions hash the canonical edge under the fixed
    // salt — both regions derive the identical stream.
    const rng = mulberry32(hashSeed(SHARED_EDGE_SALT, cA[0], cA[1], cB[0], cB[1]));
    const count = 1 + Math.floor(rng() * 3); // 1..3
    // Inward unit normal: the perpendicular that points into THIS region.
    const nx = -ey / len;
    const ny = ex / len;
    const mx = (cA[0] + cB[0]) / 2;
    const my = (cA[1] + cB[1]) / 2;
    const inwardSign = regionContains(region, mx + nx * 5, my + ny * 5) ? 1 : -1;
    const ux = nx * inwardSign;
    const uy = ny * inwardSign;

    for (let s = 0; s < count; s++) {
      const u = (s + 1) / (count + 1) + (rng() - 0.5) * 0.12; // spread + hashed jitter
      const uc = Math.max(0.05, Math.min(0.95, u));
      const gx = q(cA[0] + uc * ex);
      const gy = q(cA[1] + uc * ey);
      gates.push([gx, gy]);
      // Inward stub, shortened until its far end is contained (never spills).
      let end: Pt | null = null;
      for (let L = STUB_LEN_M; L >= 8; L /= 2) {
        const px = gx + ux * L;
        const py = gy + uy * L;
        if (regionContains(region, px, py)) {
          end = [q(px), q(py)];
          break;
        }
      }
      if (end) {
        stubs.push({ coords: [[gx, gy], end], key: `${gx},${gy}` });
      }
    }
  }

  return { gates, stubs };
}

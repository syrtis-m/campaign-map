/**
 * Shared-boundary hedgerow operator (plan 038 item 7) — the SYMMETRIC, hashed-
 * agreement seam between two adjacent SKETCH regions (forest ↔ farmland ↔ park).
 * Pure/headless (geometry + `q` only).
 *
 * Where two sketched polygons abut (their rings within `HEDGE_ADJ_EPS`), a
 * hedgerow / woodland-bank line runs along the shared edge. The two regions are
 * generated INDEPENDENTLY (different generators, possibly different worker
 * passes), so the line must be BIT-IDENTICAL from either side or the seam
 * z-fights. That is guaranteed by an id-canonical rule: the lower-id ring is the
 * canonical SOURCE, the hedge is its maximal runs of vertices within `eps` of the
 * higher-id ring, and every coordinate is mm-quantized. Both neighbours pass the
 * SAME two raw sketch rings, pick the SAME canonical/probe by id, and run the
 * SAME distance test ⇒ identical output (the 2×2-style seam contract).
 *
 * SKETCH-ONLY: the rings come from the raw `Fabric.geojson` sketch layer
 * (`constraints.fabricFeatures`), never a generator's OUTPUT — so this is a legal
 * same-stage read (like the river's confluence snap), and the 033 harness proves
 * byte-inertness beyond `eps` (a region whose bbox is farther than `eps` cannot
 * put a vertex within `eps` of ours). No adjacency in reach ⇒ [] ⇒ the caller is
 * byte-identical to the uncoupled generator.
 */
import { distanceToPolyline } from "./fields/sdf";
import { q } from "./waterEmit";

type Pt = [number, number];

/** Adjacency detection tolerance (meters, bbox- AND ring-to-ring). Doubles as the
 * `influenceMargin` every consumer of this operator declares. */
export const HEDGE_ADJ_EPS = 8;

export interface SketchRing {
  id: string;
  ring: Pt[];
}

/**
 * The shared-boundary hedgerow polylines between `selfRing` (id `selfId`) and
 * each ring in `others`, mm-quantized. Symmetric + bit-exact: computed purely
 * from the two rings + id order, so the neighbour computes the identical line.
 * Empty when nothing shares a boundary within `eps`.
 */
export function sharedBoundaryHedges(
  selfRing: Pt[] | null,
  selfId: string,
  others: readonly SketchRing[],
  eps: number = HEDGE_ADJ_EPS
): Pt[][] {
  if (!selfRing || selfRing.length < 2 || others.length === 0) return [];
  const out: Pt[][] = [];
  for (const other of others) {
    if (other.ring.length < 2 || other.id === selfId) continue;
    // Id-canonical: the lower id is the SOURCE ring, so both neighbours trace the
    // SAME ring's vertices against the SAME probe ⇒ identical geometry.
    const selfFirst = selfId < other.id;
    const canonical = selfFirst ? selfRing : other.ring;
    const probe = selfFirst ? other.ring : selfRing;
    let run: Pt[] = [];
    const flush = (): void => {
      if (run.length >= 2) out.push(run.map(([x, y]) => [q(x), q(y)] as Pt));
      run = [];
    };
    for (const v of canonical) {
      if (distanceToPolyline(probe, v[0], v[1]) <= eps) run.push(v);
      else flush();
    }
    flush();
  }
  return out;
}

/** The outer ring of a Polygon sketch feature, else null (defensive). */
export function polygonRingOf(f: GeoJSON.Feature | undefined): Pt[] | null {
  const g = f?.geometry;
  if (!g || g.type !== "Polygon") return null;
  const ring = g.coordinates[0] as Pt[] | undefined;
  return ring && ring.length >= 2 ? ring : null;
}

/**
 * Collect the self raw ring (by id) + the adjacent-kind sketch rings from the raw
 * fabric layer — the exact inputs `sharedBoundaryHedges` needs so both neighbours
 * read identical geometry. `kinds` is the set of OTHER sketch kinds this generator
 * hedges against (forest ↔ farmland/park, etc.).
 */
export function collectAdjacentRings(
  feats: readonly GeoJSON.Feature[] | undefined,
  selfId: string,
  kinds: readonly string[]
): { selfRing: Pt[] | null; others: SketchRing[] } {
  if (!feats || feats.length === 0) return { selfRing: null, others: [] };
  let selfRing: Pt[] | null = null;
  const others: SketchRing[] = [];
  for (const f of feats) {
    const id = String(f.id);
    const kind = (f.properties as { kind?: string } | null)?.kind;
    if (id === selfId) {
      selfRing = selfRing ?? polygonRingOf(f);
      continue;
    }
    if (kind && kinds.includes(kind)) {
      const ring = polygonRingOf(f);
      if (ring) others.push({ id, ring });
    }
  }
  // Deterministic order (feature order is host-stable, but sort by id so the
  // emitted hedge order never depends on enumeration).
  others.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { selfRing, others };
}

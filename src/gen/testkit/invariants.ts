/**
 * Shared structural invariants for region generators — the assertions that
 * survive ANY generator version bump: output stays inside the region ring or
 * spine corridor, polygon rings are closed, every coordinate lives on the
 * millimetre lattice, and a generator is a deterministic function of its
 * inputs. Each generator's suite calls these instead of hand-rolling the same
 * scans, so the invariant SET is defined once and a new invariant reaches every
 * generator by editing this file.
 *
 * TEST-SUPPORT ONLY: this module pulls in vitest's `expect` and is imported
 * exclusively from `*.test.ts` files — never from generator code (which stays a
 * pure headless function with no test-framework dependency).
 */
import { expect } from "vitest";
import { distanceToBoundary, type ProcgenRegion } from "../region";

type Pt = [number, number];

/** Depth-agnostic flatten: every [x, y] leaf of every feature's geometry. */
export function flattenCoords(features: GeoJSON.Feature[]): Pt[] {
  const out: Pt[] = [];
  const scan = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) scan(x);
  };
  for (const f of features) scan((f.geometry as { coordinates?: unknown }).coordinates);
  return out;
}

export interface InvariantOptions {
  /** Metres a coordinate may sit OUTSIDE the region/corridor boundary before it
   * counts as spilled (`distanceToBoundary >= -tolerance`). Default 1 m — the
   * containment gate every generator suite already used. Loosen only for a
   * generator whose emit path deliberately grazes the boundary. */
  containmentTolerance?: number;
  /** Allow a generator that legitimately emits nothing for these inputs. When
   * false (default) the helper asserts at least one coordinate was produced. */
  allowEmpty?: boolean;
  /** Assert every coordinate is on the mm lattice (default true). Set false ONLY
   * at a call site with a KNOWN, flagged quantization gap in the generator — a
   * deliberate, documented exception, never a blanket convenience. */
  checkMmQuantization?: boolean;
}

/** Absolute error a coordinate may carry off the millimetre lattice. The emit
 * lattice quantizes to 1e-3 m, so a genuine coordinate rounds to well under
 * this; a non-quantized float misses by orders of magnitude more. */
const MM_TOLERANCE = 1e-3;

function offLattice(v: number): number {
  return Math.abs(v * 1000 - Math.round(v * 1000));
}

/** Assert a single feature's polygon rings are all closed (first === last).
 * mm-quantized coordinates make the closure exact, so this is strict equality;
 * non-polygon geometries have no rings to check. */
function expectClosedRings(f: GeoJSON.Feature): void {
  const g = f.geometry;
  const check = (ring: Pt[]): void => {
    const a = ring[0];
    const b = ring[ring.length - 1];
    expect(ring.length, "polygon ring has < 4 positions").toBeGreaterThanOrEqual(4);
    expect(a[0] === b[0] && a[1] === b[1], `unclosed ring on feature ${String(f.id)}`).toBe(true);
  };
  if (g.type === "Polygon") for (const ring of g.coordinates as Pt[][]) check(ring);
  else if (g.type === "MultiPolygon") for (const poly of g.coordinates as Pt[][][]) for (const ring of poly) check(ring);
}

/**
 * The version-invariant structural contract for a whole (unclipped) generator
 * output. Pass the SAME features the generator returned and the region they
 * were generated for. Asserts:
 *  - containment: every coordinate within `containmentTolerance` of the region
 *    ring / spine corridor (`distanceToBoundary`, which handles both);
 *  - mm quantization: every coordinate on the 1e-3 m lattice;
 *  - closed rings: every polygon ring's first position equals its last.
 */
export function expectGeneratorInvariants(
  features: GeoJSON.Feature[],
  region: ProcgenRegion,
  opts: InvariantOptions = {}
): void {
  const tol = opts.containmentTolerance ?? 1;
  const checkMm = opts.checkMmQuantization ?? true;
  const coords = flattenCoords(features);
  if (!opts.allowEmpty) expect(coords.length, "generator emitted no coordinates").toBeGreaterThan(0);

  for (const [x, y] of coords) {
    expect(
      distanceToBoundary(region, x, y),
      `(${x}, ${y}) sits more than ${tol} m outside the region`
    ).toBeGreaterThanOrEqual(-tol);
    if (checkMm) {
      expect(offLattice(x), `x=${x} is not mm-quantized`).toBeLessThan(MM_TOLERANCE);
      expect(offLattice(y), `y=${y} is not mm-quantized`).toBeLessThan(MM_TOLERANCE);
    }
  }

  for (const f of features) expectClosedRings(f);
}

/**
 * Run a generator twice and assert byte-identical output (JSON.stringify
 * equality) — the determinism half of the invariant net. The caller passes a
 * thunk so both runs use identical inputs. Returns the first run for reuse.
 */
export function expectDeterministic(generate: () => GeoJSON.Feature[]): GeoJSON.Feature[] {
  const a = generate();
  const b = generate();
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  expect(a.length, "generator emitted nothing to compare").toBeGreaterThan(0);
  return a;
}

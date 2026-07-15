/**
 * Chaikin corner-cutting for CLOSED rings — the smoothing pass that
 * turns a marching-squares staircase into a hand-drawn-looking organic outline.
 *
 * Pure/headless: a deterministic closed-form subdivision of the
 * ring, mm-quantized on the way out (D5). The Chaikin limit curve of a closed
 * polygon lies INSIDE the source polygon (each corner is cut toward the interior
 * of the edge fan), so smoothing a marching-squares canopy ring only pulls its
 * boundary INWARD — a containment margin established before smoothing survives
 * it. That property is load-bearing for the forest canopy: the density field
 * already guarantees a metres-inside inset, and Chaikin never spends it.
 */
import type { Pt } from "./sdf";

/** mm quantization (D5), matched to region.ts `q`. */
function q(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Strip a ring's closing duplicate vertex if present (first === last). */
function open(ring: Pt[]): Pt[] {
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

/**
 * `passes` rounds of Chaikin corner-cutting on a closed ring, returning a closed
 * ring (first === last), mm-quantized. Each pass replaces every edge (a→b) with
 * the two points ¾a+¼b and ¼a+¾b, roughly doubling the vertex count and rounding
 * every corner. `passes ≤ 0` (or a ring too small to smooth) returns the input
 * re-closed + quantized unchanged. Deterministic: identical input → identical
 * bytes.
 */
export function chaikinClosed(ring: Pt[], passes: number): Pt[] {
  let pts = open(ring);
  if (pts.length < 3) {
    // Degenerate: nothing to smooth. Return closed + quantized.
    const out = pts.map(([x, y]) => [q(x), q(y)] as Pt);
    if (out.length >= 1) out.push([out[0][0], out[0][1]]);
    return out;
  }
  for (let p = 0; p < passes; p++) {
    const next: Pt[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      next.push([ax + 0.25 * (bx - ax), ay + 0.25 * (by - ay)]);
      next.push([ax + 0.75 * (bx - ax), ay + 0.75 * (by - ay)]);
    }
    pts = next;
  }
  const out = pts.map(([x, y]) => [q(x), q(y)] as Pt);
  out.push([out[0][0], out[0][1]]); // re-close
  return out;
}

/**
 * RK4 streamline tracing along a tensor field's major eigenvector — the
 * "street" direction. Each streamline is a pure function of its own seed
 * point + the field: fixed step count, no adaptive termination on proximity
 * to other streamlines (the classic Wonka/Chen dsep-collision termination is
 * order-dependent and would break seams). This trades some density control
 * for the determinism/seam guarantee the Tier A gate requires; density is
 * controlled instead via seed-grid spacing (spatialHash.ts).
 */
import type { TensorFieldParams } from "./tensorField";
import { sampleFieldAngle } from "./tensorField";
import type { BBox } from "../spatialHash";

export interface Vec2 {
  x: number;
  y: number;
}

export interface StreamlineOptions {
  stepSize: number;
  maxSteps: number;
  bounds: BBox; // halo-padded generation bounds; tracing stops if it exits
}

function directionAt(field: TensorFieldParams, x: number, y: number, prevDir: Vec2 | null): Vec2 {
  const angle = sampleFieldAngle(field, x, y);
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  // Line fields have no inherent sign (angle is mod pi); pick whichever
  // candidate continues smoothly from the previous step so the streamline
  // doesn't zigzag. Purely a function of (field, position, prevDir) — no
  // dependency on other streamlines.
  if (prevDir && dx * prevDir.x + dy * prevDir.y < 0) {
    dx = -dx;
    dy = -dy;
  }
  return { x: dx, y: dy };
}

function rk4Step(
  field: TensorFieldParams,
  p: Vec2,
  prevDir: Vec2,
  stepSize: number
): { point: Vec2; dir: Vec2 } {
  const k1 = directionAt(field, p.x, p.y, prevDir);
  const p2 = { x: p.x + (k1.x * stepSize) / 2, y: p.y + (k1.y * stepSize) / 2 };
  const k2 = directionAt(field, p2.x, p2.y, k1);
  const p3 = { x: p.x + (k2.x * stepSize) / 2, y: p.y + (k2.y * stepSize) / 2 };
  const k3 = directionAt(field, p3.x, p3.y, k2);
  const p4 = { x: p.x + k3.x * stepSize, y: p.y + k3.y * stepSize };
  const k4 = directionAt(field, p4.x, p4.y, k3);

  let dx = (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6;
  let dy = (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6;
  const norm = Math.hypot(dx, dy) || 1;
  dx /= norm;
  dy /= norm;
  return { point: { x: p.x + dx * stepSize, y: p.y + dy * stepSize }, dir: { x: dx, y: dy } };
}

function inBounds(p: Vec2, b: BBox): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/**
 * Traces a single streamline through `field` from `seed`, growing in both
 * directions along the major eigenvector for up to `maxSteps` each way, or
 * until it exits `bounds`. Returns an ordered polyline (may be a single
 * point if the seed itself sits outside a usable field region).
 */
export function traceStreamline(field: TensorFieldParams, seed: Vec2, opts: StreamlineOptions): Vec2[] {
  const initialAngle = sampleFieldAngle(field, seed.x, seed.y);
  const forwardDir: Vec2 = { x: Math.cos(initialAngle), y: Math.sin(initialAngle) };
  const backwardDir: Vec2 = { x: -forwardDir.x, y: -forwardDir.y };

  const forward: Vec2[] = [];
  let p = seed;
  let dir = forwardDir;
  for (let i = 0; i < opts.maxSteps; i++) {
    const step = rk4Step(field, p, dir, opts.stepSize);
    if (!inBounds(step.point, opts.bounds)) break;
    forward.push(step.point);
    p = step.point;
    dir = step.dir;
  }

  const backward: Vec2[] = [];
  p = seed;
  dir = backwardDir;
  for (let i = 0; i < opts.maxSteps; i++) {
    const step = rk4Step(field, p, dir, opts.stepSize);
    if (!inBounds(step.point, opts.bounds)) break;
    backward.push(step.point);
    p = step.point;
    dir = step.dir;
  }

  return [...backward.reverse(), seed, ...forward];
}

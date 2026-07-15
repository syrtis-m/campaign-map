/**
 * Paint-time polyline smoothing for sketched fabric (roads today). The GM draws
 * a road as a handful of clicked vertices, so it renders as dead-straight
 * segments with hard corners. This densifies + smooths the line into a gentle
 * curve via a centripetal Catmull-Rom spline, PURELY for rendering: the
 * persisted `Fabric.geojson` geometry is never touched, and the selection /
 * vertex-edit path reads the raw feature (`controller.fabricFeature`), so the
 * handles still land on the TRUE clicked vertices. Pure + host-agnostic (no
 * DOM/map imports) so it is unit-testable headlessly.
 *
 * Catmull-Rom (not Chaikin) because it INTERPOLATES the control points — the
 * smoothed curve still passes through every drawn vertex, so the road visibly
 * connects the places the GM clicked, just without the kinks. Endpoints are
 * preserved exactly (first/last coordinate byte-identical to the input).
 */

type Pt = [number, number];

/** Samples per input segment. 8 is smooth enough to read as a curve at every
 * zoom without exploding the vertex count on a long rural road. */
const SAMPLES_PER_SEGMENT = 8;

/**
 * Centripetal Catmull-Rom smoothing of an open polyline. Fewer than 3 points
 * (a single straight segment) is returned unchanged — nothing to curve. The
 * result starts and ends on the exact input endpoints.
 */
export function smoothPolyline(points: readonly Pt[], samples = SAMPLES_PER_SEGMENT): Pt[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]] as Pt);

  const out: Pt[] = [[points[0][0], points[0][1]]];
  for (let i = 0; i < points.length - 1; i++) {
    // Phantom endpoints (reflect the first/last) so the end segments curve too.
    const p0 = points[i - 1] ?? reflect(points[i], points[i + 1]);
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? reflect(points[i + 1], points[i]);
    for (let s = 1; s <= samples; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / samples));
    }
  }
  return out;
}

/** Reflect `a` across `b` — a phantom control point for an end segment
 * (b + (b − a) = 2b − a). */
function reflect(b: Pt, a: Pt): Pt {
  return [2 * b[0] - a[0], 2 * b[1] - a[1]];
}

/** Centripetal Catmull-Rom position at parameter t∈[0,1] on the p1→p2 span. */
function catmullRom(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    0.5 *
    (2 * p1[0] +
      (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
  const y =
    0.5 *
    (2 * p1[1] +
      (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  return [x, y];
}

/**
 * Shared pure geometry helpers for the per-generator metrics modules
 * (riverMetrics, forestMetrics, …). Measurement-only: these read feature
 * geometry and return scalars, imposing no determinism obligation beyond being
 * pure functions of their inputs. Kept separate from any one generator so a
 * metric formula is written once. (citynet/metrics.ts predates this and keeps
 * its own private copies — deliberately left untouched.)
 */

type Pt = [number, number];

/** A feature's generatorId as a string ("" when absent). */
export function gidOf(f: GeoJSON.Feature): string {
  const gid = (f.properties as Record<string, unknown> | undefined)?.generatorId;
  return gid === undefined ? "" : String(gid);
}

/** Features whose generatorId equals `gid`. */
export function byGid(features: GeoJSON.Feature[], gid: string): GeoJSON.Feature[] {
  return features.filter((f) => gidOf(f) === gid);
}

/** Summed length of a polyline. */
export function polylineLength(coords: Pt[]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return len;
}

/** Total length of every LineString among `features`. */
export function totalLineLength(features: GeoJSON.Feature[]): number {
  let len = 0;
  for (const f of features) {
    if (f.geometry.type === "LineString") len += polylineLength(f.geometry.coordinates as Pt[]);
  }
  return len;
}

/** |shoelace| area of a closed ring (first === last is fine). */
export function ringArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}

/** Net area (exterior minus holes) of a Polygon / MultiPolygon feature; 0 for
 * non-areal geometry. */
export function polygonNetArea(f: GeoJSON.Feature): number {
  const g = f.geometry;
  if (g.type === "Polygon") {
    const rings = g.coordinates as Pt[][];
    let a = ringArea(rings[0]);
    for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
    return a;
  }
  if (g.type === "MultiPolygon") {
    let a = 0;
    for (const poly of g.coordinates as Pt[][][]) {
      a += ringArea(poly[0]);
      for (let i = 1; i < poly.length; i++) a -= ringArea(poly[i]);
    }
    return a;
  }
  return 0;
}

/** Interior-hole count across a Polygon / MultiPolygon feature. */
export function holeCount(f: GeoJSON.Feature): number {
  const g = f.geometry;
  if (g.type === "Polygon") return (g.coordinates as Pt[][]).length - 1;
  if (g.type === "MultiPolygon") return (g.coordinates as Pt[][][]).reduce((n, poly) => n + (poly.length - 1), 0);
  return 0;
}

/** True when `value` lies within the closed band. */
export function inBand(value: number, [lo, hi]: [number, number]): boolean {
  return value >= lo && value <= hi;
}

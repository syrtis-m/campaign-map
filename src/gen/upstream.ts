/**
 * Upstream-as-data rebuild — the WORKER-SIDE half of the cross-layer cascade's
 * constraint interface.
 *
 * `Field` closures do not survive `structuredClone`, so what the host ships to
 * the worker (and what a consumer receives in `constraints.upstream`) is DATA:
 * plain GeoJSON feature lists of strictly-lower-stage GENERATED output. Both
 * the host and the worker rebuild the same SDF closures / ring indices from
 * that data through THIS pure function — the field construction is shared, so a
 * region computed on the main thread and one computed in the worker read an
 * identical upstream field (generators still read only their arguments — the
 * rebuilt field IS an argument).
 *
 * Consumption is one-directional and stage-ascending: the city (stage 3) reads
 * `water` (the meandered channel) exactly where it reads sketched water today;
 * forest/park (stage 2) read `water` (no canopy in the river).
 *
 * Pure/headless (fields + geojson only) — no DOM/map/Obsidian, no registry.
 */
import type { UpstreamArtifacts } from "./types";
import { sdfPolygon, type Field, type Pt } from "./fields/sdf";

/** The rebuilt, consumable form of the upstream artifacts: outer rings of every
 * generated water / vegetation polygon + the generated settlement STREET
 * polylines (plan 035), in gen-space meters. A consumer folds `waterRings` into
 * its existing water index (the `blockedByWater` / `RIVER_HALF_WIDTH` paths) —
 * same currency as `FabricConstraintIndex`; `settlementLines` feed the stage-4
 * peri-urban reads (urban-park entrances, farmland lane orientation). */
export interface UpstreamConstraints {
  waterRings: Pt[][];
  vegetationRings: Pt[][];
  settlementLines: Pt[][];
}

const EMPTY: UpstreamConstraints = { waterRings: [], vegetationRings: [], settlementLines: [] };

/** Every LineString of a feature list, in feature order (a generated street
 * chain is one LineString; non-lines contribute nothing). When `skipCanal` is
 * set, `type: "canal"` lines are dropped — city canals ride in `upstream.settlement`
 * for the wall (plan 038 item 8), but a peri-urban STREET consumer (urban-park
 * entrances, farmland lanes) must never read a canal as a street. */
function lineStrings(features: GeoJSON.Feature[] | undefined, skipCanal = false): Pt[][] {
  if (!features || features.length === 0) return [];
  const lines: Pt[][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (skipCanal && (f.properties as { type?: string } | null)?.type === "canal") continue;
    if (g && g.type === "LineString" && g.coordinates.length >= 2) lines.push(g.coordinates as Pt[]);
  }
  return lines;
}

/** Every outer ring of a Polygon / MultiPolygon feature, in feature order. A
 * channel `river-channel` is emitted as Polygon(s); a canopy may be one
 * MultiPolygon. Non-polygon features contribute nothing. */
function outerRings(features: GeoJSON.Feature[] | undefined): Pt[][] {
  if (!features || features.length === 0) return [];
  const rings: Pt[][] = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") {
      const ring = g.coordinates[0] as Pt[] | undefined;
      if (ring && ring.length >= 4) rings.push(ring);
    } else if (g.type === "MultiPolygon") {
      for (const poly of g.coordinates) {
        const ring = poly[0] as Pt[] | undefined;
        if (ring && ring.length >= 4) rings.push(ring);
      }
    }
  }
  return rings;
}

/**
 * Rebuild the consumable upstream constraints from the serialized artifacts.
 * A pure function of the DATA — identical inputs ⇒ identical output on the host
 * and in the worker. Ring order follows feature order (deterministic; the host
 * collects lower-stage features in `cascadeOrder`).
 */
export function buildUpstreamConstraints(upstream: UpstreamArtifacts | undefined): UpstreamConstraints {
  if (!upstream) return EMPTY;
  return {
    waterRings: outerRings(upstream.water),
    vegetationRings: outerRings(upstream.vegetation),
    settlementLines: lineStrings(upstream.settlement, true),
  };
}

/** The generated street with its form-based class (plan 037, city → wall). */
export interface SettlementStreet {
  line: Pt[];
  roadClass: string;
}

/**
 * The SETTLEMENT payload the wall consumes (plan 037 item 4) — rebuilt purely
 * from `upstream.settlement` GeoJSON (host + worker agree, same discipline as
 * the water/vegetation fields). The city already computed every part of it in
 * `citynet` (streets with class, the ring, canals); this reassembles the
 * consumable structure:
 *  - `streets`: every generated street line + its `roadClass` (gate crossings,
 *    class precedence, gatehouse bearing);
 *  - `ring`: the city ring road (`roadClass === "ring"`), when present;
 *  - `canalLines`: city canal water lines (a moat/masonry gap crosses them);
 *  - `interior`: a town-interior reference point (ring centroid, else the street
 *    vertex mean) — the moat goes on the side AWAY from it, towers face outboard.
 * `null` when there is no settlement upstream ⇒ the wall keeps its uncoupled
 * bytes (sketched-road gates only), the 23-E discipline.
 */
export interface SettlementPayload {
  streets: SettlementStreet[];
  ring: Pt[] | null;
  canalLines: Pt[][];
  interior: Pt | null;
}

export function buildSettlementPayload(upstream: UpstreamArtifacts | undefined): SettlementPayload | null {
  const feats = upstream?.settlement;
  if (!feats || feats.length === 0) return null;
  const streets: SettlementStreet[] = [];
  const canalLines: Pt[][] = [];
  let ring: Pt[] | null = null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const f of feats) {
    const g = f.geometry;
    if (!g || g.type !== "LineString" || g.coordinates.length < 2) continue;
    const line = g.coordinates as Pt[];
    const props = (f.properties ?? {}) as { roadClass?: string; type?: string; generatorId?: string };
    if (props.type === "canal") {
      canalLines.push(line);
      continue;
    }
    const roadClass = props.roadClass ?? "street";
    streets.push({ line, roadClass });
    if (roadClass === "ring" && ring === null) ring = line;
    for (const [x, y] of line) {
      sx += x;
      sy += y;
      n++;
    }
  }
  if (streets.length === 0 && canalLines.length === 0) return null;
  // Interior reference: ring centroid when the city walled itself, else the
  // street vertex mean (a stable, order-free "middle of the town").
  let interior: Pt | null = null;
  if (ring) {
    let rx = 0;
    let ry = 0;
    const m = ring.length - 1; // closed ring: last === first
    for (let i = 0; i < m; i++) {
      rx += ring[i][0];
      ry += ring[i][1];
    }
    interior = m > 0 ? [rx / m, ry / m] : null;
  } else if (n > 0) {
    interior = [sx / n, sy / n];
  }
  return { streets, ring, canalLines, interior };
}

/**
 * The upstream WATER field as an SDF closure rebuilt from the data: POSITIVE
 * inside the meandered channel, negative outside (the `sdfPolygon` convention),
 * unioned by MAX over every channel ring (inside iff inside any channel). `null`
 * when there is no upstream water, so a consumer keeps its uncoupled path. A
 * `Field` is reconstructable from the serialized rings alone — no closure ever
 * crosses the worker boundary.
 */
export function buildUpstreamWaterField(upstream: UpstreamArtifacts | undefined): Field | null {
  const rings = buildUpstreamConstraints(upstream).waterRings;
  if (rings.length === 0) return null;
  const fields = rings.map((r) => sdfPolygon(r));
  return (x, y): number => {
    let max = -Infinity;
    for (const f of fields) {
      const d = f(x, y);
      if (d > max) max = d;
    }
    return max;
  };
}

/**
 * The upstream VEGETATION field (plan 037, forest/park canopy → city): POSITIVE
 * inside the generated canopy, negative outside (`sdfPolygon`), unioned by MAX
 * over every canopy ring. `null` when there is no upstream vegetation, so the
 * city keeps its uncoupled bytes (the growth-cost attenuation + parcel rejection
 * are no-ops). Same rebuild discipline as `buildUpstreamWaterField` — a `Field`
 * reconstructed from the serialized rings alone, host and worker agree.
 */
export function buildUpstreamVegetationField(upstream: UpstreamArtifacts | undefined): Field | null {
  const rings = buildUpstreamConstraints(upstream).vegetationRings;
  if (rings.length === 0) return null;
  const fields = rings.map((r) => sdfPolygon(r));
  return (x, y): number => {
    let max = -Infinity;
    for (const f of fields) {
      const d = f(x, y);
      if (d > max) max = d;
    }
    return max;
  };
}

/**
 * Plan 037 channel-exclusion helper: (x,y) is inside the generated river
 * channel iff the upstream water field is POSITIVE there (the `sdfPolygon`
 * convention, unioned by MAX in `buildUpstreamWaterField`). `field === null`
 * (no upstream channel) ⇒ ALWAYS false, so a consumer with no upstream water
 * stays on its uncoupled path byte-for-byte (the 23-E no-field discipline).
 */
export function insideUpstreamChannel(field: Field | null, x: number, y: number): boolean {
  return field !== null && field(x, y) >= 0;
}

/**
 * Split a polyline into the maximal sub-runs whose vertices sit OUTSIDE the
 * generated channel (river channel exclusion — plan 037). A vertex-granular cut
 * (drop vertices with `field(p) >= 0`, break the run there), so a caller whose
 * line is already finely resampled needs no extra machinery; a caller with long
 * straight segments (farm lanes) resamples first. `field === null` ⇒ the whole
 * line is returned unchanged (byte-identity with no upstream). Runs shorter than
 * two points are dropped.
 */
export function splitLineOutsideChannel(pts: Pt[], field: Field | null): Pt[][] {
  if (field === null) return pts.length >= 2 ? [pts] : [];
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of pts) {
    if (field(p[0], p[1]) >= 0) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

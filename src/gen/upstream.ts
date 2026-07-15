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
 * chain is one LineString; non-lines contribute nothing). */
function lineStrings(features: GeoJSON.Feature[] | undefined): Pt[][] {
  if (!features || features.length === 0) return [];
  const lines: Pt[][] = [];
  for (const f of features) {
    const g = f.geometry;
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
    settlementLines: lineStrings(upstream.settlement),
  };
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

/**
 * Upstream-as-data rebuild (plan 024 §3) — the WORKER-SIDE half of the
 * cross-layer cascade's constraint interface.
 *
 * `Field` closures do not survive `structuredClone`, so what the host ships to
 * the worker (and what a consumer receives in `constraints.upstream`) is DATA:
 * plain GeoJSON feature lists of strictly-lower-stage GENERATED output. Both
 * the host and the worker rebuild the same SDF closures / ring indices from
 * that data through THIS pure function — the field construction is shared, so a
 * region computed on the main thread and one computed in the worker read an
 * identical upstream field (determinism across the boundary, D6: generators
 * still read only their arguments — the rebuilt field IS an argument).
 *
 * Consumption is one-directional and stage-ascending (§3): the city (stage 3)
 * reads `water` (the meandered channel) exactly where it reads sketched water
 * today; forest/park (stage 2) read `water` (no canopy in the river). The
 * actual generator wiring lands with the windiness gate (24-C); this module is
 * the interface + its serialization-safe rebuild, in place and tested at 24-B.
 *
 * Pure/headless (fields + geojson only) — no DOM/map/Obsidian, no registry.
 */
import type { UpstreamArtifacts } from "./types";
import { sdfPolygon, type Field, type Pt } from "./fields/sdf";

/** The rebuilt, consumable form of the upstream artifacts: outer rings of every
 * generated water / vegetation polygon, in gen-space meters. A consumer folds
 * `waterRings` into its existing water index (the `blockedByWater` /
 * `RIVER_HALF_WIDTH` paths) — same currency as `FabricConstraintIndex`. */
export interface UpstreamConstraints {
  waterRings: Pt[][];
  vegetationRings: Pt[][];
}

const EMPTY: UpstreamConstraints = { waterRings: [], vegetationRings: [] };

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
  };
}

/**
 * The upstream WATER field as an SDF closure rebuilt from the data (the "worker
 * rebuilds the SDF closures on its side" contract, §3): POSITIVE inside the
 * meandered channel, negative outside (the `sdfPolygon` convention), unioned by
 * MAX over every channel ring (inside iff inside any channel). `null` when there
 * is no upstream water, so a consumer keeps its uncoupled path byte-identical
 * (the 23-E no-field byte-identity discipline). Demonstrates that a `Field` is
 * reconstructable from the serialized rings alone — no closure ever crosses the
 * worker boundary.
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

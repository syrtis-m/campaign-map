/**
 * Input fingerprints for whole-artifact region caches.
 *
 * A key-match cache hit assumes the cache is FRESH — but `Fabric.geojson` can
 * change WITHOUT any in-app commit path running (vault sync from another device,
 * an external editor, a crash mid-cascade). A blind key-match replay would then
 * paint STALE downstream output and silently violate "the map is a pure function
 * of the durable data".
 *
 * Fix: every region cache record stores an input fingerprint — a canonical hash
 * of the durable inputs that determine the record's bytes. Replay treats a key
 * hit whose fingerprint ≠ the current one as a MISS and recomputes.
 * Deterministic, cheap (hashing durable data we already read), and it hardens
 * single-region replay against external sketch edits as a side effect.
 *
 * Composition:
 *   - seed, procgen version + params (the region's own `procgen` block),
 *   - the quantized ring / spine (the region geometry),
 *   - the raw-sketch constraint geometry the generators actually consume
 *     (`indexFabricConstraints` — water/river/road/wall/farmland), sorted so
 *     the hash is invariant to feature order.
 *   - `upstreamFingerprints`: the sorted fingerprints of every STRICTLY-LOWER-
 *     stage region this one depends on in the stage DAG (`dag.ts`). Each is
 *     itself a `regionFingerprint`, so any change to an upstream's durable
 *     inputs (a mountain's params, a river's windiness) transitively changes
 *     THIS region's fingerprint → its cache goes stale → it recomputes on
 *     replay, in stage order (a stale stage-1 recompute invalidates its
 *     dependents' fingerprints too). This catches an upstream edit no in-app
 *     commit path saw: a mountain is a procgen REGION (not a raw-sketch kind),
 *     so its edit is invisible to the raw-constraint hash below — the upstream
 *     fingerprints see it. Folded in ONLY when non-empty, and the `FP` version
 *     tag is NOT bumped, so a region with no upstream keeps a stable fingerprint
 *     and triggers no recompute; a region that GAINS an upstream changes
 *     fingerprint (correct — that coupling is new).
 *
 * DELIBERATELY EXCLUDED:
 *   - canon Locations: a cache hit does NOT re-check canon ("canon changes don't
 *     auto-invalidate cached fabric"). Fingerprinting canon would silently
 *     change that behavior. Excluding canon preserves today's contract exactly.
 *
 * Pure/headless (no DOM/map/Obsidian imports) so both the host and the worker
 * can compute an identical fingerprint from the same durable data.
 */
import type { FabricFeature, FabricKind } from "../../model/fabric";
import { indexFabricConstraints } from "../fabricConstraints";
import type { ProcgenRegion } from "../region";
import type { BBox } from "../spatialHash";

/** Bumped when the fingerprint composition OR the hash function changes. Old
 * records carry the old tag ⇒ mismatch ⇒ a MISS that recomputes, so the change
 * self-heals (the documented, harmless one-time recompute). fp2 (plan 033-B):
 * the FNV-BigInt hasher was replaced by a two-lane 32-bit hash. fp3 (plan
 * 033-D): the raw-constraint hash is now SCOPED to the algorithm's consumed
 * kinds within its influence bbox — a global-hash record recomputes once. */
const FP_VERSION = "fp3";

export interface RegionFingerprintInput {
  /** Registry algorithm id (`procgen.algorithm`). */
  algorithm: string;
  /** Persisted region seed (`procgen.seed`). */
  seed: number;
  /** Persisted params schema version (`procgen.version`). */
  version: number;
  /** Persisted, un-normalized params (`procgen.params`). */
  params: Record<string, unknown>;
  /** The host-built region (mm-quantized ring + optional spine). */
  region: ProcgenRegion;
  /** The whole sketched-fabric collection — the SAME features every generator
   * run sees as constraints. Only the constraint-bearing kinds contribute, and
   * (plan 033-D) only those within `consumesSketch` ∩ influence bbox. */
  fabricFeatures?: FabricFeature[];
  /** The algorithm's declared raw-sketch consumption (registry `consumesSketch`,
   * plan 033-D). Provided ⇒ the raw-constraint hash is SCOPED: only features of
   * a consumed kind whose bbox comes within `influenceMargin` of the region bbox
   * contribute, so a far-away or non-consumed sketch edit leaves this
   * fingerprint UNCHANGED (the P5 load-storm fix). The 033-A harness proves that
   * scope is byte-safe (everything excluded is byte-inert). Omitted ⇒ the
   * pre-033 GLOBAL hash of every constraint kind (retained only for callers
   * without the registry in hand). */
  consumesSketch?: readonly FabricKind[];
  /** Influence reach (meters) paired with `consumesSketch` for the scoped hash;
   * defaults to 0 when `consumesSketch` is given without it. */
  influenceMargin?: number;
  /** The fingerprints of this region's strictly-lower-stage DAG dependencies
   * (see `dag.ts`). Sorted by the caller for order-invariance; folded in ONLY
   * when non-empty (a no-upstream region keeps a stable fingerprint — see the
   * module header). */
  upstreamFingerprints?: string[];
}

/** Bytes hashed since the last reset — the perf budget counter (plan 033-B).
 * The fingerprint pass hashes mm-quantized rings that can run to 10–15 k
 * vertices; the old FNV hasher did a BigInt multiply PER CHARACTER (~10–30
 * MB/s), so a batch fingerprint pass over a campaign of big rings was a real
 * cost. The replacement below is a pure-TS two-lane 32-bit hash (Math.imul, no
 * BigInt) — same byte budget, a constant cheap op per byte instead of a BigInt
 * multiply. Perf is asserted as this budget (bytes-per-pass), never wall-clock
 * (docs/06: throttled numbers only), so the assertion is machine-stable. */
let hashedBytesTotal = 0;
/** Total bytes fed to the hasher since `resetHashByteBudget` — the 033-B budget
 * counter surface. */
export function hashByteBudget(): number {
  return hashedBytesTotal;
}
export function resetHashByteBudget(): void {
  hashedBytesTotal = 0;
}

/** A two-lane 32-bit string hash (cyrb-style: two independent `Math.imul`
 * accumulators, cross-mixed at the end), emitted as 16 lowercase hex chars —
 * the same width as the old FNV-64 output. Pure TS, no BigInt, so it hashes a
 * 10–15 k-vertex quantized ring at a constant cheap op per byte. Collision
 * resistance (a changed input landing on the same fingerprint ⇒ a stale record
 * wrongly treated fresh) is negligible across the two 32-bit lanes for the
 * durable-data volumes here; hash-equivalence with fp1 is NOT required (the
 * FP_VERSION bump self-heals). */
function hash64Hex(s: string): string {
  hashedBytesTotal += s.length;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2);
}

/** Canonical JSON with recursively SORTED object keys — so a fingerprint is
 * invariant to the key order the params/geometry happen to serialize in (JSON
 * object key order is an insertion detail, never a semantic difference). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** Euclidean bbox-to-bbox separation (0 when overlapping/touching) — the same
 * currency the 033-C invalidation walk uses, so the scoped hash and the walk
 * agree on "within margin". */
function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

/** Feature bbox from its (arbitrarily nested) coordinate arrays. Returns null
 * for a feature with no numeric coordinates. */
function featureBbox(f: FabricFeature): BBox | null {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const scan = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const x = c[0] as number;
      const y = c[1] as number;
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
      return;
    }
    for (const e of c) scan(e);
  };
  scan(f.geometry.coordinates);
  return Number.isFinite(b.minX) ? b : null;
}

/** Plan 033-D scope: the subset of `fabricFeatures` that could influence this
 * region's output — a consumed KIND whose bbox is within `margin` of the region
 * bbox. Undefined `consumesSketch` ⇒ no scoping (pre-033 global hash); an empty
 * `consumesSketch` ⇒ nothing (the generator reads no raw sketch). Everything
 * this drops is byte-inert by the 033-A harness's proof. */
function scopeConstraintFeatures(
  fabricFeatures: FabricFeature[] | undefined,
  consumesSketch: readonly FabricKind[] | undefined,
  margin: number,
  regionBbox: BBox
): FabricFeature[] | undefined {
  if (!fabricFeatures || fabricFeatures.length === 0) return fabricFeatures;
  if (consumesSketch === undefined) return fabricFeatures;
  if (consumesSketch.length === 0) return [];
  return fabricFeatures.filter((f) => {
    if (!consumesSketch.includes(f.properties.kind)) return false;
    const fb = featureBbox(f);
    return fb !== null && bboxGap(fb, regionBbox) <= margin;
  });
}

/** Canonical, order-invariant serialization of the raw-sketch constraints the
 * generators consume. Each bucket's entries are sorted by their canonical JSON
 * so reordering features in `Fabric.geojson` never changes the fingerprint. */
function canonicalConstraints(fabricFeatures: FabricFeature[] | undefined): string {
  const idx = indexFabricConstraints(fabricFeatures);
  const bucket = (rings: number[][][] | number[][][]): string =>
    "[" +
    (rings as unknown as number[][][])
      .map((r) => canonicalJson(r))
      .sort()
      .join(",") +
    "]";
  // Nested-region rings (plan 037 item 5): `park`/`district` polygons the CITY
  // consumes as holes are NOT bucketed by `indexFabricConstraints` (they are
  // procgen regions, not raw constraints), so hash their rings HERE — else a
  // contained region's move would not flip the city's fingerprint (silent stale
  // bytes). Only the city scopes these in (its `consumesSketch`), so this bucket
  // is empty for every other algorithm; APPENDED ONLY WHEN NON-EMPTY so a
  // park/district-free region's fingerprint string is unchanged (no churn).
  const nestedRings: number[][][] = [];
  for (const f of fabricFeatures ?? []) {
    const kind = f.properties.kind;
    if ((kind === "park" || kind === "district") && f.geometry.type === "Polygon") {
      nestedRings.push(f.geometry.coordinates[0] as number[][]);
    }
  }
  const nested = nestedRings.length > 0 ? "N" + bucket(nestedRings) : "";
  return (
    "W" + bucket(idx.waterRings) +
    "R" + bucket(idx.riverLines) +
    "D" + bucket(idx.roadLines) +
    "L" + bucket(idx.wallLines) +
    "F" + bucket(idx.farmlandRings) +
    nested
  );
}

/**
 * The canonical input fingerprint for a region's whole-artifact cache records.
 * A pure function of the durable inputs — identical inputs ⇒ identical string,
 * forever, on every machine that reads the same `Fabric.geojson`.
 */
export function regionFingerprint(input: RegionFingerprintInput): string {
  const { algorithm, seed, version, params, region, fabricFeatures, upstreamFingerprints } = input;
  const geometry = canonicalJson({ ring: region.ring, spine: region.spine?.points ?? null });
  const scoped = scopeConstraintFeatures(
    fabricFeatures,
    input.consumesSketch,
    input.influenceMargin ?? 0,
    region.bbox
  );
  const fields = [
    FP_VERSION,
    algorithm,
    String(seed),
    String(version),
    canonicalJson(params),
    "G:" + geometry,
    "C:" + canonicalConstraints(scoped),
  ];
  // Fold in upstream DAG dependencies ONLY when present, so a no-upstream region
  // keeps a stable fingerprint (no version bump, no needless recompute — module
  // header). Sorted here too, defensively, so the hash is invariant to the order
  // the caller collected upstreams.
  if (upstreamFingerprints && upstreamFingerprints.length > 0) {
    fields.push("U:" + [...upstreamFingerprints].sort().join(","));
  }
  return hash64Hex(fields.join("|"));
}

/**
 * Freshness test for a cached region record against the current expected
 * fingerprint. A record with NO stored fingerprint is grandfathered as fresh so
 * opening an existing campaign never triggers a regen storm (deleting
 * `.mapcache/` stays harmless). Only a record that HAS a fingerprint AND
 * mismatches is stale. A `undefined` expected fingerprint (a caller that can't
 * compute one) also can't invalidate.
 */
export function isCacheRecordFresh(
  storedFingerprint: string | undefined,
  expectedFingerprint: string | undefined
): boolean {
  if (storedFingerprint === undefined || expectedFingerprint === undefined) return true;
  return storedFingerprint === expectedFingerprint;
}

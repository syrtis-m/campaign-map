/**
 * Input fingerprints for whole-artifact region caches (plan 024 §5.1).
 *
 * "A cache hit needs no upstream fields" (§5) assumes the cache is FRESH — but
 * `Fabric.geojson` can change WITHOUT any in-app commit path running (vault
 * sync from another device, an external editor, a crash mid-cascade). A blind
 * key-match replay would then paint STALE downstream output and silently
 * violate "the map is a pure function of the durable data".
 *
 * Fix (the same self-invalidating discipline as the 23-D DEM `digest`): every
 * region cache record stores an input fingerprint — a canonical hash of the
 * durable inputs that determine the record's bytes. Replay treats a key hit
 * whose fingerprint ≠ the current one as a MISS and recomputes. Deterministic,
 * cheap (hashing durable data we already read), and it hardens plan 020's
 * single-region replay against external sketch edits as a side effect.
 *
 * Composition (plan 024 §5.1's list, for the inputs that exist at 24-A):
 *   - seed, procgen version + params (the region's own `procgen` block),
 *   - the quantized ring / spine (the region geometry),
 *   - the raw-sketch constraint geometry the generators actually consume
 *     (`indexFabricConstraints` — water/river/road/wall/farmland), sorted so
 *     the hash is invariant to feature order.
 *
 * DELIBERATELY EXCLUDED at 24-A (documented in DECISIONS):
 *   - upstream GENERATED-artifact fingerprints (§5.1's "sorted upstream
 *     artifact fingerprints"): no stage produces artifacts consumed by another
 *     until the cascade/stages land in 24-B — there is nothing to hash yet.
 *     The composition is forward-compatible: 24-B appends those fingerprints
 *     as another `|`-delimited field and bumps the `FP` version tag.
 *   - canon Locations: `generationService` documents that a cache hit does NOT
 *     re-check canon ("canon changes don't auto-invalidate cached fabric").
 *     Fingerprinting canon would silently change that behavior — it is plan
 *     024 open question #3, unresolved. Excluding canon preserves today's
 *     contract exactly.
 *
 * Pure/headless (no DOM/map/Obsidian imports) so both the host and the worker
 * can compute an identical fingerprint from the same durable data.
 */
import type { FabricFeature } from "../../model/fabric";
import { indexFabricConstraints } from "../fabricConstraints";
import type { ProcgenRegion } from "../region";

/** Bumped when the fingerprint composition changes (e.g. 24-B adds upstream
 * artifact fingerprints). Old records carry the old tag ⇒ mismatch ⇒ a MISS
 * that recomputes byte-identically, so a composition change self-heals. */
const FP_VERSION = "fp1";

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
   * run sees as constraints. Only the constraint-bearing kinds contribute. */
  fabricFeatures?: FabricFeature[];
}

/** FNV-1a, 64-bit, as 16 lowercase hex chars. Wide enough that a changed input
 * colliding onto the same fingerprint (⇒ a stale record wrongly treated fresh)
 * is negligible for the durable-data volumes here. */
function fnv1a64Hex(s: string): string {
  const prime = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
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
  return (
    "W" + bucket(idx.waterRings) +
    "R" + bucket(idx.riverLines) +
    "D" + bucket(idx.roadLines) +
    "L" + bucket(idx.wallLines) +
    "F" + bucket(idx.farmlandRings)
  );
}

/**
 * The canonical input fingerprint for a region's whole-artifact cache records.
 * A pure function of the durable inputs — identical inputs ⇒ identical string,
 * forever, on every machine that reads the same `Fabric.geojson`.
 */
export function regionFingerprint(input: RegionFingerprintInput): string {
  const { algorithm, seed, version, params, region, fabricFeatures } = input;
  const geometry = canonicalJson({ ring: region.ring, spine: region.spine?.points ?? null });
  const canon = [
    FP_VERSION,
    algorithm,
    String(seed),
    String(version),
    canonicalJson(params),
    "G:" + geometry,
    "C:" + canonicalConstraints(fabricFeatures),
  ].join("|");
  return fnv1a64Hex(canon);
}

/**
 * Freshness test for a cached region record against the current expected
 * fingerprint. BACK-COMPAT (plan 024 §5.1, DoD #6): a record with NO stored
 * fingerprint is a PRE-024 record — grandfathered as fresh so opening an
 * existing campaign never triggers a regen storm (deleting `.mapcache/` stays
 * harmless; Jonah's real campaign opens from cache, byte-intact). Only a record
 * that HAS a fingerprint AND mismatches is stale. A `undefined` expected
 * fingerprint (a caller that can't compute one) also can't invalidate.
 */
export function isCacheRecordFresh(
  storedFingerprint: string | undefined,
  expectedFingerprint: string | undefined
): boolean {
  if (storedFingerprint === undefined || expectedFingerprint === undefined) return true;
  return storedFingerprint === expectedFingerprint;
}

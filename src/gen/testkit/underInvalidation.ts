/**
 * Under-invalidation property harness (plan 033-A) — the shipping gate for
 * consumption-aware invalidation (33-C/33-D).
 *
 * THE PROPERTY. A declared consumption map `{ kinds, marginMeters }` for an
 * algorithm claims: "this generator's output is a function of ONLY the sketch
 * features whose kind is in `kinds` and whose bbox comes within
 * `marginMeters` of the region's bbox". Scoped invalidation (plan 033-C)
 * will key on that claim, so an under-declaration silently serves STALE BYTES
 * AS FRESH — the exact failure class plan 029 exists to prevent. This harness
 * converts the declaration from trusted to VERIFIED: for every sketch kind
 * NOT in the declared set (placed anywhere, including overlapping the
 * region), and for every declared kind placed strictly OUTSIDE the margin,
 * generating with vs without the extra feature must be BYTE-IDENTICAL.
 *
 * Placements are seeded + fuzzed (mulberry32 over fixed literals — same bytes
 * every run, per the repo's determinism doctrine): for non-declared kinds one
 * placement OVERLAPS the region, one TOUCHES its bbox (sub-meter gap,
 * "touching-but-not-consumed"), the rest sit far away; for declared kinds the
 * placements straddle just-outside-margin, mid-range, and far. The harness
 * self-checks every outside-placement's bbox gap (a placement bug must fail
 * loudly, never pass vacuously) and returns violations as DATA so the
 * prove-the-net-catches test can assert that an intentionally under-declared
 * table FAILS.
 *
 * Headless testkit module: registry + region + model types only — no DOM, no
 * map, no Obsidian. Generation goes through `algorithm.generate` exactly like
 * the generator unit tests (pure, controller-free).
 */
import { FABRIC_KINDS, isPolygonKind, type FabricFeature, type FabricKind } from "../../model/fabric";
import type { GenerationConstraints } from "../types";
import type { ProcgenRegion } from "../region";
import { makeCorridorRegion, makeRegion, makeSpine } from "../region";
import { algorithmById } from "../procgen/registry";
import { hashSeed, mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";

type Pt = [number, number];

/** The declared consumption for one algorithm — the exact shape plan 033-C
 * moves onto the registry (`consumesSketch` + `influenceMargin`). */
export interface DeclaredConsumption {
  /** Sketch kinds this algorithm's generator reads. */
  kinds: readonly FabricKind[];
  /** Influence reach, meters, measured bbox-to-bbox (feature bbox vs region
   * bbox) — the 33-C invalidation predicate is `kind ∈ kinds ∧ bboxGap ≤
   * marginMeters`, so the harness proves inertness strictly BEYOND it. */
  marginMeters: number;
}

export interface UnderInvalidationViolation {
  algorithmId: string;
  kind: FabricKind;
  declared: boolean;
  /** Human-readable placement label ("overlap", "touch gap≈0.8m", "gap≈33m"…). */
  placement: string;
  /** Achieved feature-bbox → region-bbox gap in meters (0 for overlap). */
  gapMeters: number;
  /** Where the two JSON byte streams first diverge (and their lengths). */
  detail: string;
}

export interface UnderInvalidationOptions {
  /** Placements tried per sketch kind (the runtime knob — downscale here if
   * the fuzz tier ever runs hot). Default 3; capped at 5. */
  placementsPerKind?: number;
  /** Base seed for the placement fuzz (fixed default ⇒ same bytes forever). */
  seed?: number;
}

const WORLD: BBox = { minX: -50000, minY: -50000, maxX: 50000, maxY: 50000 };
const DEFAULT_PLACEMENTS = 3;
const MAX_PLACEMENTS = 5;

// ─── Per-algorithm generation fixtures ───────────────────────────────────────
// One region + params per algorithm, chosen for MAXIMUM consumption
// sensitivity (the preset that reads the most: euro-medieval city reads
// water/river/road/wall/farmland; lazy-lowland river has slope coupling on;
// paddy-terraces is farmland's elevation-coupled preset). Literal geometry —
// same region every run.

function hexRing(cx: number, cy: number, r: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

interface AlgorithmFixture {
  region: ProcgenRegion;
  params: Record<string, unknown>;
  genSeed: number;
}

/** The fixed spine both line-kind fixtures elaborate (river gets its own copy
 * of the geometry so corridor widths differ only via params). */
const FIXTURE_SPINE: Pt[] = [
  [-600, 0],
  [-300, 80],
  [0, -40],
  [300, 60],
  [600, 0],
];

export function fixtureFor(algorithmId: string): AlgorithmFixture {
  const alg = algorithmById(algorithmId);
  if (!alg) throw new Error(`underInvalidation: unknown algorithm "${algorithmId}"`);
  const genSeed = hashSeed(9001, "under-invalidation", algorithmId);
  switch (algorithmId) {
    case "city":
      return { region: makeRegion("ui-region-city", hexRing(0, 0, 220)), params: { profile: "euro-medieval" }, genSeed };
    case "forest":
      return {
        region: makeRegion("ui-region-forest", hexRing(0, 0, 220)),
        params: { variety: "broadleaf", density: 0.7, clearings: 0.12, edgeRaggedness: 0.45 },
        genSeed,
      };
    case "park":
      return {
        region: makeRegion("ui-region-park", hexRing(0, 0, 200)),
        params: { variety: "city-park", pathDensity: 0.5, pond: true },
        genSeed,
      };
    case "farmland":
      return {
        region: makeRegion("ui-region-farmland", hexRing(0, 0, 260)),
        // paddy-terraces: the elevation-coupled preset — the one that reads
        // the sketched mountains' field. Declarations are per-ALGORITHM, so
        // the harness runs the most-consuming params.
        params: { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 },
        genSeed,
      };
    case "mountain":
      return {
        region: makeRegion("ui-region-mountain", hexRing(0, 0, 300)),
        params: { terrain: "alpine", amplitude: 0.85, roughness: 0.6 },
        genSeed,
      };
    case "river": {
      const params = {
        windiness: 0.85,
        braiding: 0.5,
        width: 26,
        widthGrowth: 0.7,
        braidBias: 0.2,
        slopeSensitivity: 1,
      };
      const spine = makeSpine("ui-region-river", FIXTURE_SPINE);
      return { region: makeCorridorRegion("ui-region-river", spine, alg.corridorMaxOffset!(params)), params, genSeed };
    }
    case "wall": {
      const params = { style: "curtain-wall", towerSpacing: 60, moat: true, gatehouseScale: 1 };
      const spine = makeSpine("ui-region-wall", FIXTURE_SPINE);
      return { region: makeCorridorRegion("ui-region-wall", spine, alg.corridorMaxOffset!(params)), params, genSeed };
    }
    case "relief": {
      // Terrain add-stamp (line kind): emits no fabric, so it is trivially inert
      // to every sketch — the harness still proves nothing it "reads" leaks in.
      const params = { polarity: "ridge", height: 300, halfWidth: 180 };
      const spine = makeSpine("ui-region-relief", FIXTURE_SPINE);
      return { region: makeCorridorRegion("ui-region-relief", spine, alg.corridorMaxOffset!(params)), params, genSeed };
    }
    case "landform":
      // Terrain replace-stamp (polygon kind): emits no fabric — consumesSketch [].
      return {
        region: makeRegion("ui-region-landform", hexRing(0, 0, 240)),
        params: { mode: "plateau", band: 120, priority: 0 },
        genSeed,
      };
    default:
      throw new Error(`underInvalidation: no fixture for algorithm "${algorithmId}" — add one when registering it`);
  }
}

// ─── Injected sketch features ────────────────────────────────────────────────

/** Feature template around the origin: shape only; `place` translates it.
 * Lines are ~600 m polylines; polygons are hexagons (r 180 m). The mountain
 * carries a REAL procgen block (alpine, high amplitude): the elevation-field
 * read (`elevationFieldFromFabric`) keys on `procgen.algorithm === "mountain"`,
 * so a blockless mountain sketch would be invisible to the very consumers the
 * harness probes. Other kinds are read by geometry+kind alone. */
function templateFor(kind: FabricKind, rng: () => number): { coords: Pt[]; isPolygon: boolean } {
  if (isPolygonKind(kind)) {
    const r = 180 + rng() * 60;
    return { coords: hexRing(0, 0, r), isPolygon: true };
  }
  const wob = (rng() - 0.5) * 120;
  return {
    coords: [
      [0, 0],
      [220, 40 + wob],
      [430, -30],
      [640, 25],
    ],
    isPolygon: false,
  };
}

function bboxOf(coords: Pt[]): BBox {
  const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of coords) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return b;
}

/** The per-feature invalidation reach the harness proves inertness OUTSIDE of
 * for a DECLARED kind (ruling 2026-07-15 variable support). For the terrain
 * STAMP kinds it is the INJECTED feature's own support (matching
 * `terrainStampSupport`): relief → `halfWidth + apron` (the injected relief
 * carries a foothill apron so the harness exercises the WIDENED support — a
 * skirt'd relief must be proven inert only past halfWidth+apron), mountain/
 * landform → 0 (compact support). Every other kind uses the algorithm's scalar
 * `marginMeters`.
 *
 * CARVE-OUT (plan 041 island-from-coastline): an INVERTED sea landform has GLOBAL
 * support (`terrainStampSupport` → Infinity — its exterior mask is nonzero across
 * the whole campaign box, campaign-wide dirty like the base params). The harness's
 * injected landform is a compact PLATEAU (reach 0), so this reach-0 assertion is
 * unaffected; an inverted sea is never "inert outside a reach" and so is out of
 * this compact-support harness's scope. */
const INJECTED_RELIEF_HALFWIDTH = 180; // MUST equal featureFrom's relief `halfWidth`
const INJECTED_RELIEF_APRON = 140; // MUST equal featureFrom's relief `apron`
const INJECTED_RELIEF_REACH = INJECTED_RELIEF_HALFWIDTH + INJECTED_RELIEF_APRON;
function declaredReach(kind: FabricKind, declared: DeclaredConsumption): number {
  if (kind === "relief") return INJECTED_RELIEF_REACH;
  if (kind === "mountain" || kind === "landform") return 0;
  return declared.marginMeters;
}

/** Euclidean bbox-to-bbox separation (0 when they overlap/touch) — the same
 * currency the 33-C invalidation walk will use. */
export function bboxGap(a: BBox, b: BBox): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

function featureFrom(id: string, kind: FabricKind, coords: Pt[], isPolygon: boolean): FabricFeature {
  const geometry: FabricFeature["geometry"] = isPolygon
    ? { type: "Polygon", coordinates: [coords] }
    : { type: "LineString", coordinates: coords };
  // Terrain-stamp kinds carry a REAL procgen block: `terrainAt` (the future
  // river/farmland source) keys on `procgen.algorithm`, so a blockless stamp
  // would be invisible to the consumers the harness probes. mountain/relief/
  // landform all read by block; other kinds by geometry+kind alone.
  let procgen: FabricFeature["properties"]["procgen"];
  if (kind === "mountain") {
    procgen = {
      algorithm: "mountain",
      seed: hashSeed(7007, "ui-mountain", id),
      version: 1,
      params: { terrain: "alpine", amplitude: 0.85, roughness: 0.6 },
    };
  } else if (kind === "relief") {
    procgen = {
      algorithm: "relief",
      seed: hashSeed(7007, "ui-relief", id),
      version: 1,
      // Carries a foothill apron: the support the harness proves inertness beyond
      // is halfWidth + apron (INJECTED_RELIEF_REACH), matching terrainStampSupport.
      params: { polarity: "ridge", height: 300, halfWidth: INJECTED_RELIEF_HALFWIDTH, apron: INJECTED_RELIEF_APRON },
    };
  } else if (kind === "landform") {
    procgen = {
      algorithm: "landform",
      seed: hashSeed(7007, "ui-landform", id),
      version: 1,
      params: { mode: "plateau", band: 120, priority: 0 },
    };
  } else {
    procgen = undefined;
  }
  return {
    type: "Feature",
    id,
    geometry,
    properties: { kind, ...(procgen ? { procgen } : {}) },
  };
}

/** Translate the template so its bbox sits `gap` meters from the region bbox
 * along one of the four compass directions (cycled by placement index), with
 * seeded perpendicular jitter. Perpendicular position never shrinks the gap
 * (Euclidean bbox separation ≥ the axis separation). */
function placeOutside(
  regionBbox: BBox,
  coords: Pt[],
  gap: number,
  dirIndex: number,
  rng: () => number
): Pt[] {
  const tb = bboxOf(coords);
  const jitter = (rng() - 0.5) * 300;
  let dx = 0;
  let dy = 0;
  switch (dirIndex % 4) {
    case 0: // +X
      dx = regionBbox.maxX + gap - tb.minX;
      dy = regionBbox.minY + jitter - tb.minY;
      break;
    case 1: // -Y
      dx = regionBbox.minX + jitter - tb.minX;
      dy = regionBbox.minY - gap - tb.maxY;
      break;
    case 2: // -X
      dx = regionBbox.minX - gap - tb.maxX;
      dy = regionBbox.maxY + jitter - tb.maxY;
      break;
    default: // +Y
      dx = regionBbox.maxX + jitter - tb.maxX;
      dy = regionBbox.maxY + gap - tb.minY;
      break;
  }
  return coords.map((p): Pt => [p[0] + dx, p[1] + dy]);
}

/** Center the template on the region's generation-relevant interior. */
function placeOverlapping(region: ProcgenRegion, coords: Pt[]): Pt[] {
  const cx = (region.bbox.minX + region.bbox.maxX) / 2;
  const cy = (region.bbox.minY + region.bbox.maxY) / 2;
  const tb = bboxOf(coords);
  const tx = (tb.minX + tb.maxX) / 2;
  const ty = (tb.minY + tb.maxY) / 2;
  return coords.map((p): Pt => [p[0] + cx - tx, p[1] + cy - ty]);
}

/** First byte index where two strings diverge, formatted with lengths. */
function firstDivergence(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return `byte-divergence at ${i} (baseline ${a.length} B, with-feature ${b.length} B)`;
}

// ─── The harness ─────────────────────────────────────────────────────────────

interface Placement {
  label: string;
  coords: Pt[];
  /** Expected minimum bbox gap for the self-check; null for overlap/touch
   * placements (which are only legal for NON-declared kinds). */
  minGap: number | null;
}

/**
 * Property-check one algorithm against a declared consumption map. Returns
 * violations as data (empty array = the declaration holds for every seeded
 * placement). Throws only on harness-internal errors (unknown algorithm, a
 * placement that lands inside the margin — a bug in the harness itself).
 */
export function checkUnderInvalidation(
  algorithmId: string,
  declared: DeclaredConsumption,
  options: UnderInvalidationOptions = {}
): UnderInvalidationViolation[] {
  const alg = algorithmById(algorithmId);
  if (!alg) throw new Error(`underInvalidation: unknown algorithm "${algorithmId}"`);
  const nPlace = Math.min(MAX_PLACEMENTS, Math.max(1, options.placementsPerKind ?? DEFAULT_PLACEMENTS));
  const baseSeed = options.seed ?? 20260714;
  const { region, params, genSeed } = fixtureFor(algorithmId);

  const generate = (features: FabricFeature[] | undefined): string => {
    const constraints: GenerationConstraints = {
      worldBounds: WORLD,
      ...(features && features.length > 0 ? { fabricFeatures: features } : {}),
    };
    return JSON.stringify(alg.generate(genSeed, region, params, constraints));
  };

  const baseline = generate(undefined);
  const violations: UnderInvalidationViolation[] = [];

  for (const kind of FABRIC_KINDS) {
    const isDeclared = declared.kinds.includes(kind);
    for (let i = 0; i < nPlace; i++) {
      const rng = mulberry32(hashSeed(baseSeed, algorithmId, kind, i));
      const { coords, isPolygon } = templateFor(kind, rng);

      let placement: Placement;
      if (isDeclared) {
        // Declared kind: probe strictly OUTSIDE the reach — just outside,
        // mid-range, far (cycled), each with seeded jitter that only ever
        // ADDS distance. VARIABLE SUPPORT (ruling 2026-07-15): a terrain STAMP
        // kind uses the INJECTED feature's own per-feature support
        // (`declaredReach`: relief → its halfWidth, mountain/landform → 0), not
        // the algorithm's scalar margin — so a relief is proven inert only beyond
        // its cross-profile band (where the field is exactly 0), which is what
        // the scoped invalidation actually keys on.
        const reach = declaredReach(kind, declared);
        const tier = i % 3;
        const gap =
          tier === 0
            ? reach + 3 + rng() * 25
            : tier === 1
              ? reach + 200 + rng() * 150
              : reach + 1800 + rng() * 400;
        placement = {
          label: `outside-reach gap≈${Math.round(gap)}m`,
          coords: placeOutside(region.bbox, coords, gap, i, rng),
          minGap: reach,
        };
      } else if (i === 0) {
        // Non-declared kind: even OVERLAPPING the region must be inert.
        placement = { label: "overlap", coords: placeOverlapping(region, coords), minGap: null };
      } else if (i === 1) {
        // Touching-but-not-consumed: hugging the region bbox.
        const gap = 0.5 + rng() * 0.5;
        placement = {
          label: `touch gap≈${gap.toFixed(1)}m`,
          coords: placeOutside(region.bbox, coords, gap, i, rng),
          minGap: null,
        };
      } else {
        const gap = 400 + rng() * 1800;
        placement = {
          label: `far gap≈${Math.round(gap)}m`,
          coords: placeOutside(region.bbox, coords, gap, i, rng),
          minGap: null,
        };
      }

      const achievedGap = bboxGap(bboxOf(placement.coords), region.bbox);
      if (placement.minGap !== null && achievedGap <= placement.minGap) {
        // Harness self-check: a mis-placed declared-kind probe would make the
        // property pass vacuously — that is a harness bug, fail loudly.
        throw new Error(
          `underInvalidation harness bug: ${algorithmId}/${kind} placement "${placement.label}" ` +
            `landed at gap ${achievedGap.toFixed(2)}m ≤ margin ${placement.minGap}m`
        );
      }

      const feature = featureFrom(`ui-${algorithmId}-${kind}-${i}`, kind, placement.coords, isPolygon);
      const withFeature = generate([feature]);
      if (withFeature !== baseline) {
        violations.push({
          algorithmId,
          kind,
          declared: isDeclared,
          placement: placement.label,
          gapMeters: achievedGap,
          detail: firstDivergence(baseline, withFeature),
        });
      }
    }
  }
  return violations;
}

/** Pretty one-line-per-violation formatter for assertion messages. */
export function formatViolations(violations: UnderInvalidationViolation[]): string {
  if (violations.length === 0) return "(no violations)";
  return violations
    .map(
      (v) =>
        `${v.algorithmId} reads undeclared/out-of-margin ${v.kind} ` +
        `[declared=${v.declared}, ${v.placement}, gap ${v.gapMeters.toFixed(1)}m]: ${v.detail}`
    )
    .join("\n");
}

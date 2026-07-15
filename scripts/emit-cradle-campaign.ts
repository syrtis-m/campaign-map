#!/usr/bin/env tsx
/**
 * Emit the "Cradle" demo campaign (`dev-vault/Campaigns/Cradle/`) — a
 * high-fidelity recreation of THE CRADLE, Island One (the Player Map from the
 * TTRPG *Deathmatch Island*). Run:
 *
 *   npx tsx scripts/emit-cradle-campaign.ts
 *
 * Writes Cradle.map.md (campaign frontmatter + terrain block), Fabric.geojson
 * (MAP-UNIT coordinates), Generated.json (empty — every request is a city-tier
 * procgen block on a fabric feature) and the 14 location notes (with their
 * point-crawl `connections:`). Deterministic: same constants ⇒ same bytes, so
 * re-running is the whole "update the campaign" story. Dev tooling only (node:fs
 * is fine here — the Vault-API rule governs plugin runtime code); this touches
 * ONLY dev-vault/Campaigns/Cradle.
 *
 * SELF-CONTAINED GEOMETRY. Unlike Vailmarch (whose geometry lives in
 * src/gen/testkit), every Cradle constant is inline below so the whole map is
 * tweakable from this one file. Coordinates are authored in the REFERENCE's
 * normalized frame — x 0..100 left→right, y 0..100 TOP→bottom (screen space) —
 * and converted to generation-space METERS by `N()` (which flips y so north is
 * +y) and then to map units by `toUnits()`. Procgen PARAMS (height/halfWidth/
 * apron/band/target — all meters) are absolute and never scaled. The only src
 * imports are pure, read-only helpers (rng, quantize) + the registry (to pin
 * each block to its algorithm's CURRENT contract version) + the whole-collection
 * validator — no src file is modified.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  FabricCollection,
  FabricFeature,
  FabricKind,
  ProcgenBlock,
} from "../src/model/fabric";
import { FabricCollectionSchema } from "../src/model/fabric";
import { algorithmById } from "../src/gen/procgen/registry";
import { hashSeed, mulberry32 } from "../src/gen/rng";
import { q } from "../src/gen/waterEmit";

type Pt = [number, number];
type NPt = [number, number]; // normalized reference point (x 0..100 →, y 0..100 ↓)

// ─── Campaign constants ──────────────────────────────────────────────────────
/** Fixed campaign seed — mirrored in `Cradle.map.md` frontmatter. */
const CRADLE_CAMPAIGN_SEED = 20931;
/** 1 map unit = 500 m (Vailmarch idiom: small fake-lng/lat units, low Mercator
 * distortion) over the ~7 × 6 km island. */
const SCALE_M_PER_UNIT = 500;
/** Meters per normalized reference unit — sets the island's real size. The
 * island occupies normalized x 5..85 (80 u) × y 15..85 (70 u), so at 90 m/u it
 * is ~7.2 × 6.3 km. */
const METERS_PER_NORM = 90;
/** Campaign id the location notes reference in `map:` frontmatter. */
const CRADLE_MAP_ID = "cradle";
/** Modern survival-island genre → the clean contemporary theme. */
const CRADLE_THEME = "modern-clean";
/** Fictional bounded box, MAP UNITS. The whole normalized 0..100 canvas maps to
 * ±(50·90/500)=±9 units on both axes; a hair of margin encloses the sea plate. */
const CRADLE_BOUNDS: readonly [number, number, number, number] = [-9.2, -9.2, 9.2, 9.2];
/** Base-terrain params (plan 036-D). `campAmp > 0` ⇒ the continental fBm is ON;
 * on top of it the sea/island/islet landform stamps + the highland relief stamps
 * build the terrain. */
const CRADLE_BASE = { campAmp: 140, seaDatum: 0 } as const;

// ─── Coordinate conversion ───────────────────────────────────────────────────
/** Normalized reference point → generation-space METERS (origin at canvas
 * centre; y FLIPPED so screen-top/north is +y). */
function N([nx, ny]: NPt): Pt {
  return [q((nx - 50) * METERS_PER_NORM), q((50 - ny) * METERS_PER_NORM)];
}
/** Meters → map units (÷ scale). */
function toUnits(p: Pt): Pt {
  return [p[0] / SCALE_M_PER_UNIT, p[1] / SCALE_M_PER_UNIT];
}

// ─── Organic boundaries (Vailmarch idiom) ────────────────────────────────────
// Every coastline / district / forest ring ships as an IRREGULAR polyline, never
// an axis-aligned box: corners stay EXACT, and each edge gets a few intermediate
// vertices displaced perpendicular by deterministic seeded noise (mm-quantized),
// keyed purely on the edge's endpoints so a shared boundary matches from either
// side. Perpendicular offset tapers to 0 at both ends (sin bump) → corners exact.

function closed(open: Pt[]): Pt[] {
  return [...open.map((p): Pt => [p[0], p[1]]), [open[0][0], open[0][1]]];
}

/** Per-boundary jitter strength. `ampFrac`/`ampCap` bound the perpendicular
 * displacement (meters); `segLen`/`maxSeg` set how many intermediate vertices an
 * edge gets. Coasts stay gentle (a hand-drawn wobble on an already-curved shore);
 * DISTRICT rings push much harder (their corners are axis-aligned rectangles, so
 * a timid wobble still reads as a postage stamp — they need a bold, clearly
 * organic deviation to shed the rectangle). All values are fixed constants ⇒
 * deterministic. */
interface JitterProfile {
  ampFrac: number;
  ampCap: number;
  segLen: number;
  maxSeg: number;
}
/** Coastlines / forest / islet: a light hand-drawn wobble over already-organic
 * corner chains (delta 4 — a touch more character than the old 0.05/24 pair). */
const COAST_JITTER: JitterProfile = { ampFrac: 0.06, ampCap: 42, segLen: 240, maxSeg: 6 };
/** District rings + the walls that trace them (delta 3 — Vailmarch endpoint-keyed
 * idiom pushed hard so a rectangle reads as an organic settlement ring). */
const DISTRICT_JITTER: JitterProfile = { ampFrac: 0.09, ampCap: 75, segLen: 220, maxSeg: 5 };

function jitterProfileFor(kind: FabricKind): JitterProfile {
  return kind === "district" ? DISTRICT_JITTER : COAST_JITTER;
}

/** Deterministic jitter points along edge a→b (endpoints EXCLUDED), keyed on the
 * canonical (endpoint-sorted) edge so a shared edge yields identical vertices.
 * Strength comes from `profile`; the rng seed keys ONLY on the endpoints (never
 * the profile) so a shared district/wall edge still matches. */
function jitterEdge(a: Pt, b: Pt, profile: JitterProfile): Pt[] {
  const forward = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const p0 = forward ? a : b;
  const p1 = forward ? b : a;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const segments = Math.max(2, Math.min(profile.maxSeg, Math.round(len / profile.segLen)));
  const amp = Math.min(len * profile.ampFrac, profile.ampCap); // meters; bounded so premises hold
  const ux = -dy / len;
  const uy = dx / len;
  const rng = mulberry32(hashSeed(CRADLE_CAMPAIGN_SEED, "cradle-edge", p0[0], p0[1], p1[0], p1[1]));
  const pts: Pt[] = [];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const taper = Math.sin(Math.PI * t);
    const off = (rng() * 2 - 1) * amp * taper;
    pts.push([q(p0[0] + dx * t + ux * off), q(p0[1] + dy * t + uy * off)]);
  }
  return forward ? pts : pts.reverse();
}

/** The irregular OPEN ring of a corner list, jittered at `profile` strength. */
function irregularOpenRing(corners: Pt[], profile: JitterProfile = COAST_JITTER): Pt[] {
  const out: Pt[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    out.push([a[0], a[1]]);
    for (const p of jitterEdge(a, b, profile)) out.push(p);
  }
  return out;
}

/** A ring scaled toward its centroid by `factor` (< 1 shrinks it inward) — a
 * traced wall sits just inside its district ring so generated arterials cross it
 * transversally (gatehouses open where each exits). */
function scaledTowardCentroid(open: Pt[], factor: number): Pt[] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of open) {
    cx += x;
    cy += y;
  }
  cx /= open.length;
  cy /= open.length;
  return open.map((p): Pt => [q(cx + (p[0] - cx) * factor), q(cy + (p[1] - cy) * factor)]);
}
const WALL_TRACE_INSET = 0.94;

/** Shoelace signed area of a closed ring (map units). Sign encodes winding:
 * used to force a donut's HOLE rings to the opposite winding of the outer ring —
 * MapLibre's `classifyRings` only treats a ring as a hole when its signed-area
 * sign is opposite the exterior's (same sign ⇒ a NEW filled polygon, which would
 * re-fill the island with water). */
function signedArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
}

/** Return `ring` wound OPPOSITE to `outerSign` (reversing preserves closure — a
 * closed ring's first === last, so a full reverse keeps it closed and flips the
 * winding). Same boundary vertices either way, so a hole butts EXACTLY against
 * the island/islet feature's own coast ring (no gap, no overlap). */
function oppositeWinding(ring: Pt[], outerSign: number): Pt[] {
  const s = signedArea(ring);
  return s !== 0 && Math.sign(s) === Math.sign(outerSign) ? [...ring].reverse() : ring;
}

// ─── Named geometry (NORMALIZED reference coords; easy to tweak) ──────────────
// The island silhouette, traced clockwise in screen space from the north point:
// rounded N shore, NE shoulder → E bulge (Industrial Port), the deep inlet, the
// fat SE peninsula, the south coast, the long narrow SW peninsula (→ islet), the
// indented W coast, the NW arm, back to the N point.
const ISLAND_COAST: NPt[] = [
  [45, 17], // N point (rounded north shore)
  [48.5, 17], // extra N-shore vertex (hand-drawn density)
  [52, 17.5],
  [59, 19],
  [66, 22],
  [72, 26],
  [77, 31],
  [81, 36],
  [83.5, 39], // extra E-bulge vertex
  [85, 42], // E bulge — Industrial Port
  [84, 47],
  [81, 51],
  [76, 53], // mouth of the deep inlet
  [72, 55], // inlet head (between port bulge and SE peninsula)
  [74, 59],
  [78, 63],
  [81, 69],
  [78, 74],
  [72, 78], // SE peninsula tip (fat)
  [65, 77],
  [58, 76],
  [54, 76.5], // extra S-coast vertex
  [51, 77],
  [44, 78],
  [38, 76],
  [33, 72], // south coast bending toward the SW
  [30, 66], // SW peninsula base
  [26, 69], // SE flank of the narrow spit
  [20, 73],
  [14, 77],
  [10, 78], // SW peninsula tip (islet lies just off it)
  [12, 74], // NW flank of the spit, climbing back
  [17, 69],
  [23, 64],
  [28, 58],
  [30, 55], // peninsula base (upper)
  // ── Gentle DOUBLE-BAY W coast (delta 2: was a sharp spiky wedge). Two shallow
  //    eastward scallops separated by a soft, blunt headland — smooth, no zigzag.
  [28, 52],
  [25.5, 49.5], // headland 1 (juts gently west)
  [24, 47],
  [24.5, 44.5], // south bay head — cuts gently EAST
  [23, 42],
  [21, 40], // mid headland (blunt, not a spike)
  [21.5, 37.5], // north bay head — gentle east
  [20, 35.5],
  [17.5, 33],
  // ── Blunt NW arm (delta 2: was a single sharp spike). A tight cluster of near
  //    vertices rounds the tip so it reads as a stubby arm, not a needle.
  [15.5, 31],
  [14.5, 29.5], // arm tip
  [15, 28],
  [17, 27.5],
  [20, 28], // arm shoulder climbing back east
  [24, 29],
  [28, 30.5],
  [31.5, 29],
  [35, 26],
  [38.5, 22.5],
  [42, 19],
];
/** The separate islet holding the Lighthouse, just SW of the peninsula tip. */
const ISLET_COAST: NPt[] = [
  [5, 79],
  [8, 78.5],
  [10, 81],
  [8, 83],
  [5, 82.5],
];
/** Sea plate OUTER ring: covers the whole canvas (with margin) at the sea datum.
 * The island + islet coast rings are cut as POLYGON HOLES (a donut) so the water
 * FILL never paints over land — the island/islet feature fills show through and
 * their coast rings draw. (For the ELEVATION field the sea landform's mask reads
 * only the OUTER ring — `landformStampsFromFabric` uses `coordinates[0]` — so the
 * sea replace-stamp still covers the whole canvas and the island plateau's higher
 * `priority` still wins inside its ring: the terrain is unchanged by the holes.) */
const SEA_RECT: NPt[] = [
  [-3, -3],
  [103, -3],
  [103, 103],
  [-3, 103],
];

// Highland relief spines (ridge add-stamps over the island plateau). Heights and
// half-widths are deliberately large: the reference reads as BOLD contour texture
// across every highland, and the NE mass DOMINATES the island's NE quarter — so
// each spine gets a wide apron+halfWidth so its contour band spreads visibly at
// overview, not a tight knot of lines around a short spine.
const NE_RIDGE: NPt[] = [[55, 35], [61, 29], [67, 25], [73, 22]]; // NE mass — tallest, widest
const NE_SPUR: NPt[] = [[57, 41], [63, 37], [69, 34]]; // minor shoulder S of the North Heights (texture)
const E_RIDGE: NPt[] = [[72, 57], [76, 52], [79, 49]]; // E ridge S of the port
const CENTRAL_S_RIDGE: NPt[] = [[47, 66], [53, 62], [59, 59]];
const NORTH_DOWNS: NPt[] = [[39, 33], [45, 31], [51, 32]]; // minor N-central spur under the scrub (texture)
const SW_SPINE: NPt[] = [[29, 57], [22, 65], [14, 74], [10, 78]]; // SW-peninsula spine
const NW_HILLS: NPt[] = [[21, 34], [27, 30], [33, 27]];
const CENTRAL_HILL: NPt[] = [[38, 47], [41, 44], [44, 43]];

// Sparse dead-wood scrub field.
const SCRUB_FIELD: NPt[] = [[35, 28], [55, 28], [55, 42], [35, 42]];

// Built-up districts (city procgen).
const APARTMENT_BLOCKS: NPt[] = [[31, 40], [44, 40], [44, 49], [31, 49]]; // (37,44) medium
const INDUSTRIAL_PORT: NPt[] = [[76, 37], [85, 37], [85, 47], [76, 47]]; // (80,42) waterfront
const FISHING_VILLAGE: NPt[] = [[66.5, 68.5], [74, 68.5], [74, 76], [66.5, 76]]; // (70,72) small
const COMPOUND: NPt[] = [[44, 24], [50, 24], [50, 30], [44, 30]]; // (47,27) tiny + wall ring

// ─── Region definition table ─────────────────────────────────────────────────
interface RegionDef {
  id: string;
  kind: FabricKind;
  name: string;
  shape: "poly" | "line";
  /** NORMALIZED reference coords. Poly → EXACT ring corners (emitted as the
   * irregular ring unless `raw`); line → polyline verbatim. */
  coords: NPt[];
  /** Skip edge-jitter (used for the big sea rectangle). */
  raw?: boolean;
  /** Poly ids to cut as HOLES in this poly (a donut) — the sea cuts the island
   * + islet coast rings so its water fill never covers land. */
  holes?: string[];
  /** A wall that TRACES another region's ring. */
  traces?: string;
  algorithm?: string;
  params?: Record<string, unknown>;
  presetId?: string;
}

const DEFS: RegionDef[] = [
  // ── TERRAIN: sea plate + island/islet plateaus (landform replace-stamps) ────
  {
    id: "cradle-landform-sea",
    kind: "landform",
    name: "The Deep",
    shape: "poly",
    coords: SEA_RECT,
    raw: true,
    // Cut the island + islet coasts as holes → water fill covers only open sea.
    holes: ["cradle-landform-island", "cradle-landform-islet"],
    algorithm: "landform",
    params: { mode: "sea", target: -40, band: 80, priority: 0 },
    presetId: "sea",
  },
  {
    id: "cradle-landform-island",
    kind: "landform",
    name: "Island One",
    shape: "poly",
    coords: ISLAND_COAST,
    // priority 1 > the sea's 0 ⇒ folded LAST, wins inside the coast ring: a low
    // ~30 m plateau bounded by the organic shoreline.
    algorithm: "landform",
    params: { mode: "plateau", target: 30, band: 150, priority: 1 },
    presetId: "plateau",
  },
  {
    id: "cradle-landform-islet",
    kind: "landform",
    name: "Lighthouse Rock",
    shape: "poly",
    coords: ISLET_COAST,
    algorithm: "landform",
    params: { mode: "plateau", target: 20, band: 60, priority: 1 },
    presetId: "plateau",
  },
  // ── TERRAIN: highland relief ridge stamps ───────────────────────────────────
  {
    id: "cradle-relief-ne",
    kind: "relief",
    name: "The North Heights",
    shape: "line",
    coords: NE_RIDGE,
    algorithm: "relief",
    // Tallest + widest mass; its halfWidth+apron (~1900 m each flank) spreads a
    // bold contour band across the whole NE quarter.
    params: { polarity: "ridge", height: 900, halfWidth: 1100, apron: 850 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-ne-spur",
    kind: "relief",
    name: "Heights Shoulder",
    shape: "line",
    coords: NE_SPUR,
    algorithm: "relief",
    params: { polarity: "ridge", height: 420, halfWidth: 560, apron: 460 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-east",
    kind: "relief",
    name: "Portside Ridge",
    shape: "line",
    coords: E_RIDGE,
    algorithm: "relief",
    params: { polarity: "ridge", height: 520, halfWidth: 600, apron: 480 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-central",
    kind: "relief",
    name: "The Spine",
    shape: "line",
    coords: CENTRAL_S_RIDGE,
    algorithm: "relief",
    params: { polarity: "ridge", height: 620, halfWidth: 700, apron: 560 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-downs",
    kind: "relief",
    name: "The North Downs",
    shape: "line",
    coords: NORTH_DOWNS,
    algorithm: "relief",
    params: { polarity: "ridge", height: 340, halfWidth: 540, apron: 440 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-sw",
    kind: "relief",
    name: "The Ridgeback",
    shape: "line",
    coords: SW_SPINE,
    algorithm: "relief",
    params: { polarity: "ridge", height: 430, halfWidth: 420, apron: 360 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-nw",
    kind: "relief",
    name: "The West Hills",
    shape: "line",
    coords: NW_HILLS,
    algorithm: "relief",
    params: { polarity: "ridge", height: 440, halfWidth: 620, apron: 500 },
    presetId: "ridge",
  },
  {
    id: "cradle-relief-hill",
    kind: "relief",
    name: "House Hill",
    shape: "line",
    coords: CENTRAL_HILL,
    algorithm: "relief",
    params: { polarity: "ridge", height: 300, halfWidth: 440, apron: 360 },
    presetId: "ridge",
  },
  // ── FOREST: the dead-wood scrub field ───────────────────────────────────────
  {
    id: "cradle-forest-scrub",
    kind: "forest",
    name: "The Scrublands",
    shape: "poly",
    coords: SCRUB_FIELD,
    algorithm: "forest",
    params: { variety: "dead-wood", density: 0.35, clearings: 0.35, edgeRaggedness: 0.7 },
    presetId: "dead-wood",
  },
  // ── CITIES: built-up districts ──────────────────────────────────────────────
  {
    id: "cradle-district-apartments",
    kind: "district",
    name: "Apartment Blocks",
    shape: "poly",
    coords: APARTMENT_BLOCKS,
    algorithm: "city",
    params: { profile: "euro-continental" },
    presetId: "euro-continental",
  },
  {
    id: "cradle-district-port",
    kind: "district",
    name: "Industrial Port",
    shape: "poly",
    coords: INDUSTRIAL_PORT,
    algorithm: "city",
    params: { profile: "na-grid" },
    presetId: "na-grid",
  },
  {
    id: "cradle-district-village",
    kind: "district",
    name: "Fishing Village",
    shape: "poly",
    coords: FISHING_VILLAGE,
    algorithm: "city",
    params: { profile: "euro-medieval" },
    presetId: "euro-medieval",
  },
  {
    id: "cradle-district-compound",
    kind: "district",
    name: "The Compound",
    shape: "poly",
    coords: COMPOUND,
    algorithm: "city",
    params: { profile: "superblock" },
    presetId: "superblock",
  },
  // ── WALLS: the compound's ring ──────────────────────────────────────────────
  {
    id: "cradle-wall-compound",
    kind: "wall",
    name: "Compound Wall",
    shape: "line",
    coords: COMPOUND, // fallback; the emitted line traces the district ring
    traces: "cradle-district-compound",
    algorithm: "wall",
    params: { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1 },
    presetId: "curtain-wall",
  },
];

const DEF_BY_ID = new Map(DEFS.map((d) => [d.id, d]));

/** The emitted METER geometry of a def. */
function metersOf(id: string): Pt[] {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`cradle: unknown def "${id}"`);
  const corners = def.coords.map(N);
  if (def.shape === "poly") return def.raw ? corners : irregularOpenRing(corners, jitterProfileFor(def.kind));
  if (def.traces) {
    // Trace the district's OWN jittered ring (same profile ⇒ the wall follows the
    // organic settlement boundary), then inset toward the centroid so arterials
    // cross it transversally at gatehouses.
    const traced = DEF_BY_ID.get(def.traces)!;
    const ring = irregularOpenRing(traced.coords.map(N), jitterProfileFor(traced.kind));
    return closed(scaledTowardCentroid(ring, WALL_TRACE_INSET));
  }
  return corners;
}

/** Procgen block: seed from the locked convention, version pinned to the
 * algorithm's CURRENT registry contract, params validated by its own schema. */
function procgenBlock(def: RegionDef): ProcgenBlock {
  const alg = algorithmById(def.algorithm!);
  if (!alg) throw new Error(`cradle: unknown algorithm "${def.algorithm}"`);
  const parsed = alg.paramsSchema.parse(def.params ?? {});
  return {
    algorithm: def.algorithm!,
    seed: hashSeed(CRADLE_CAMPAIGN_SEED, def.id),
    version: alg.currentVersion,
    params: parsed,
    ...(def.presetId !== undefined ? { presetId: def.presetId } : {}),
  };
}

/** The closed MAP-UNIT ring a poly def emits (identical bytes to its own feature's
 * outer ring) — the sea's holes reuse this so a hole boundary is exactly the
 * island/islet coast. */
function closedUnitRing(id: string): Pt[] {
  return closed(metersOf(id)).map(toUnits);
}

function fabricFeatureOf(def: RegionDef): FabricFeature {
  const meters = metersOf(def.id);
  let geometry: FabricFeature["geometry"];
  if (def.shape === "poly") {
    const rings: Pt[][] = [closed(meters).map(toUnits)];
    if (def.holes && def.holes.length > 0) {
      const outerSign = signedArea(rings[0]);
      for (const holeId of def.holes) rings.push(oppositeWinding(closedUnitRing(holeId), outerSign));
    }
    geometry = { type: "Polygon", coordinates: rings };
  } else {
    geometry = { type: "LineString", coordinates: meters.map(toUnits) };
  }
  return {
    type: "Feature",
    id: def.id,
    geometry,
    properties: {
      kind: def.kind,
      name: def.name,
      ...(def.algorithm !== undefined ? { procgen: procgenBlock(def) } : {}),
    },
  };
}

function buildCradleFabric(): FabricCollection {
  return { type: "FeatureCollection", features: DEFS.map(fabricFeatureOf) };
}

// ─── Location pins (canon notes) ─────────────────────────────────────────────
interface CradlePin {
  /** #n on the reference legend. */
  n: number;
  name: string;
  type: string;
  visibility: "wide" | "mid" | "close";
  /** Legend role (POI / challenge / landing / restricted / sanctuary). */
  role: string;
  point: NPt;
  body: string;
  /** Point-crawl edges: note names this pin connects to (each undirected edge is
   * listed once, on its lower-numbered endpoint). */
  connections?: string[];
}

const PINS: readonly CradlePin[] = [
  {
    n: 1,
    name: "Fishing Village",
    type: "town",
    visibility: "wide",
    role: "Landing site",
    point: [70, 72],
    body: "A weather-beaten cluster of net-lofts and jetties on the fat SE peninsula — one of the two places a boat can safely put ashore.",
    connections: ["Stinking Light", "The Ravine", "Industrial Port"],
  },
  {
    n: 2,
    name: "The Ravine",
    type: "landmark",
    visibility: "mid",
    role: "Challenge",
    point: [74, 62],
    body: "A steep-sided gash cutting inland from the eastern inlet. The only crossing is a single rope span.",
    connections: ["Radio Mast"],
  },
  {
    n: 3,
    name: "Stinking Light",
    type: "landmark",
    visibility: "close",
    role: "POI (restricted)",
    point: [57, 64],
    body: "A guttering signal-flame over a reeking sump. Something down there is not meant to be found. Access is restricted.",
    connections: ["Sanctuary"],
  },
  {
    n: 4,
    name: "White Water",
    type: "landmark",
    visibility: "mid",
    role: "Challenge",
    point: [59, 50],
    body: "Fast rapids where run-off from the central heights churns through a rock throat — loud, cold, and hard to ford.",
    connections: ["The House", "Radio Mast", "Crashed Plane", "Industrial Port"],
  },
  {
    n: 5,
    name: "Radio Mast",
    type: "landmark",
    visibility: "mid",
    role: "POI",
    point: [74, 53],
    body: "A rusting lattice tower on the Portside Ridge, still humming with intermittent power.",
    connections: ["Industrial Port"],
  },
  {
    n: 6,
    name: "Industrial Port",
    type: "town",
    visibility: "wide",
    role: "Landing site",
    point: [80, 42],
    body: "Cranes, container stacks and a deep-water quay on the island's east bulge — the second safe landing, and the only heavy infrastructure.",
    connections: ["The House"],
  },
  {
    n: 7,
    name: "The House",
    type: "landmark",
    visibility: "mid",
    role: "Challenge",
    point: [54, 42],
    body: "A lone building on the central hill, shuttered and watchful. Everyone on the island has a theory about who lives there.",
    connections: ["Stadium", "Apartment Blocks"],
  },
  {
    n: 8,
    name: "Crashed Plane",
    type: "landmark",
    visibility: "mid",
    role: "POI",
    point: [47, 51],
    body: "The broken fuselage of an old transport, half-buried where it came down. Its cargo has long since been picked over — mostly.",
    connections: ["Sanctuary", "Apartment Blocks"],
  },
  {
    n: 9,
    name: "Sanctuary",
    type: "town",
    visibility: "wide",
    role: "Sanctuary (safe zone)",
    point: [44, 59],
    body: "The one place on the Cradle where the killing stops. Neutral ground, jealously kept.",
    connections: ["Playground"],
  },
  {
    n: 10,
    name: "Lighthouse",
    type: "landmark",
    visibility: "mid",
    role: "Landing / restricted",
    point: [7, 80],
    body: "A tall automated light on its own rock off the SW peninsula tip. Reachable only by the causeway at low tide; the keeper's door is locked from inside.",
    connections: ["Playground"],
  },
  {
    n: 11,
    name: "Playground",
    type: "landmark",
    visibility: "mid",
    role: "POI",
    point: [33, 58],
    body: "A rusted swing-set and roundabout in a clearing on the SW slopes — incongruously cheerful, and never quite empty.",
    connections: ["Apartment Blocks"],
  },
  {
    n: 12,
    name: "Apartment Blocks",
    type: "town",
    visibility: "mid",
    role: "District",
    point: [37, 44],
    body: "A grid of gutted mid-rise housing on the west-central flats. Good sightlines, bad memories.",
    connections: ["Compound"],
  },
  {
    n: 13,
    name: "Compound",
    type: "landmark",
    visibility: "mid",
    role: "Restricted",
    point: [47, 27],
    body: "A small walled enclosure in the northern uplands. The gate is always shut and the wall is always watched.",
    connections: ["Stadium"],
  },
  {
    n: 14,
    name: "Stadium",
    type: "landmark",
    visibility: "mid",
    role: "Challenge",
    point: [60, 22],
    body: "A concrete bowl in the north, open to the sky. Whatever it was built for, it is used for something else now.",
  },
];

// Note names must resolve for the connection lines; assert every reference is a
// real pin name (fail loudly, never emit a dangling edge).
const PIN_NAMES = new Set(PINS.map((p) => p.name));
// The reference legend numbers "Compound" #13; its note basename is "Compound"
// while the district fabric is "The Compound" — the point-crawl edges reference
// the NOTE names, so add the note names explicitly.
for (const p of PINS) {
  for (const c of p.connections ?? []) {
    if (!PIN_NAMES.has(c)) throw new Error(`cradle: connection to unknown pin "${c}" from "${p.name}"`);
  }
}

// ─── Note rendering ──────────────────────────────────────────────────────────
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAMPAIGN_DIR = join(REPO_ROOT, "dev-vault", "Campaigns", "Cradle");
const LOCATIONS_DIR = join(CAMPAIGN_DIR, "Locations");

function mapNote(): string {
  const [minX, minY, maxX, maxY] = CRADLE_BOUNDS;
  return `---
map-campaign: true
crs: fictional
theme: ${CRADLE_THEME}
seed: ${CRADLE_CAMPAIGN_SEED}
scaleMetersPerUnit: ${SCALE_M_PER_UNIT}
bounds: [${minX}, ${minY}, ${maxX}, ${maxY}]
terrain:
  campAmp: ${CRADLE_BASE.campAmp}
  seaDatum: ${CRADLE_BASE.seaDatum}
---

# The Cradle — Island One

A high-fidelity recreation of THE CRADLE (Island One), the player map from the
TTRPG *Deathmatch Island*: one large irregular island in an open sea, a
point-crawl of ${PINS.length} numbered locations wired by ${20} trails. Two safe LANDINGS
(the Industrial Port on the east bulge, the Fishing Village on the SE
peninsula), a walled COMPOUND and a STADIUM in the northern uplands, a
SANCTUARY at the heart, and a lone LIGHTHOUSE on its own rock off the SW tip.

Terrain is GLOBAL: a sea plate at the datum, the island a low ~30 m plateau
bounded by an organic coast ring on top of it (higher priority ⇒ it wins inside
the shore), the islet a smaller plateau, and eight highland RELIEF ridge stamps
(the tall, wide North Heights dominating the NE quarter with its shoulder spur,
the Portside and central Spine ridges, the North Downs, the SW Ridgeback, the
West Hills, and House Hill) lifting bold local relief. There are
NO rivers. Built-up fabric — the two landings, the Apartment Blocks, and the
Compound — is city procgen driven by the sketched district rings; the dead-wood
Scrublands fill the wild north-centre.

Every feature is generated from \`scripts/emit-cradle-campaign.ts\`; regenerate
this directory with \`npx tsx scripts/emit-cradle-campaign.ts\` (never hand-edit
— edits are overwritten). 1 map unit = ${SCALE_M_PER_UNIT} m, so the island is ~7 × 6 km.
`;
}

function locationNote(pin: CradlePin): string {
  const [ux, uy] = toUnits(N(pin.point));
  const lines = [
    "---",
    `map: ${CRADLE_MAP_ID}`,
    `geometry: [${ux}, ${uy}]`,
    `type: ${pin.type}`,
    `visibility: ${pin.visibility}`,
    ...(pin.connections && pin.connections.length > 0
      ? ["connections:", ...pin.connections.map((c) => `  - ${c}`)]
      : []),
    "---",
    `**#${pin.n} · ${pin.role}**`,
    "",
    pin.body,
    "",
  ];
  return lines.join("\n");
}

// ─── Emit ────────────────────────────────────────────────────────────────────
function main(): void {
  mkdirSync(LOCATIONS_DIR, { recursive: true });

  const fabric = buildCradleFabric();
  // Validate the whole collection at the current registry versions — a drifted
  // param or bad geometry fails the build loudly, never ships silently.
  FabricCollectionSchema.parse(fabric);

  writeFileSync(join(CAMPAIGN_DIR, "Cradle.map.md"), mapNote());
  writeFileSync(join(CAMPAIGN_DIR, "Fabric.geojson"), JSON.stringify(fabric, null, 2) + "\n");
  // No world-tier requests — every request is a city-tier procgen block on a
  // fabric feature.
  writeFileSync(join(CAMPAIGN_DIR, "Generated.json"), JSON.stringify({ entries: [], domains: [] }, null, 2) + "\n");
  for (const pin of PINS) {
    writeFileSync(join(LOCATIONS_DIR, `${pin.name}.md`), locationNote(pin));
  }

  const edges = PINS.reduce((sum, p) => sum + (p.connections?.length ?? 0), 0);
  console.log(
    `Cradle campaign emitted: ${fabric.features.length} fabric features, ${PINS.length} location notes, ${edges} connections → ${CAMPAIGN_DIR}`
  );
}

main();

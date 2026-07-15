/**
 * Vailmarch — the SHOWCASE demo campaign, native to the plan 031–039 terrain +
 * coupling pipeline. One deterministic geometry source, two artifacts: headless
 * Vitest fixtures (imported directly by `vailmarch.test.ts`) and the
 * `dev-vault/Campaigns/Vailmarch` campaign (emitted by
 * `scripts/emit-vailmarch-campaign.ts` — regenerate with
 * `npx tsx scripts/emit-vailmarch-campaign.ts`).
 *
 * A river-valley march: coastal lowland + sea in the WEST, a relief SPINE (ridge
 * add-stamps, NO mountain polygons — ruling 2026-07-15: a mountain is just one
 * stamp kind of the global terrain field) across the NORTH with two arms reaching
 * south, a raised plateau in the EAST, a lake basin in the SOUTH. The river Vail
 * rises in the spine, carves a gorge through the ridge, and runs to the coast
 * gathering two tributaries; cities, walls, roads, farms, forests and parks pile
 * up along it with heavy overlap — every feature touches at least one other
 * system so the demo shows everything working together. Terrain is GLOBAL: base
 * fBm (persisted `terrain` block) + relief/landform stamps drive the forest
 * timberline, the flank pasture, and the paddy terraces — no polygon massifs.
 *
 * COORDINATE SPACES (the load-bearing convention). Unlike `overlapMap` (which
 * authors in map units), Vailmarch authors its single geometry source in
 * GENERATION-SPACE METERS — the space the generators and `terrainAt` actually
 * consume (region rings, spine corridors, stamp half-widths/heights are all
 * meters). `buildVailmarchFabric()` divides only the COORDINATES by
 * `VAILMARCH_SCALE_M_PER_UNIT` to emit map-unit `Fabric.geojson` (procgen
 * PARAMS — width/height/halfWidth/band/target, all meters — are never scaled).
 * The generation-proof tests build regions straight from the meter geometry, so
 * the exact shapes the campaign ships drive the headless generators. The host
 * closes the loop in-app: map-unit fabric × scale ⇒ the same meters.
 *
 * Determinism: every def is literal; seeds derive once from
 * `hashSeed(VAILMARCH_CAMPAIGN_SEED, featureId)` (the locked region-seed
 * convention); versions read from each algorithm's registry `currentVersion` so
 * the fixture never silently pins a stale contract. Pure module: model types +
 * registry only — no DOM, map, or Obsidian (testkit is headless).
 */
import type { FabricCollection, FabricFeature, FabricKind, ProcgenBlock } from "../../model/fabric";
import { algorithmById } from "../procgen/registry";
import { hashSeed, mulberry32 } from "../rng";
import { q } from "../waterEmit";

type Pt = [number, number];

/** Campaign seed — mirrored in `Vailmarch.map.md` frontmatter. */
export const VAILMARCH_CAMPAIGN_SEED = 48157;
/** 1 map unit = 500 m ⇒ small fake-lng/lat units (low Mercator distortion) over
 * a ~8 × 6 km valley whose terrain reads at overview zoom. */
export const VAILMARCH_SCALE_M_PER_UNIT = 500;
/** Fictional bounded box, MAP UNITS (encloses every feature with margin). */
export const VAILMARCH_BOUNDS: readonly [number, number, number, number] = [-9, -6, 8, 6];
/** Campaign id notes reference in `map:` frontmatter. */
export const VAILMARCH_MAP_ID = "vailmarch";
/** The campaign base-terrain params the demo ships with — persisted into
 * `Vailmarch.map.md`'s `terrain:` frontmatter block (plan 036-D), so the host
 * threads them to every terrain consumer and the DEM. `campAmp > 0` ⇒ the base
 * fBm is ON: continental relief EVERYWHERE, on top of which the relief/landform
 * stamps (and the Vail's carve) add the dramatic local terrain. Exported so the
 * emitter writes the same numbers the terrain tests exercise. */
export const VAILMARCH_BASE = { campAmp: 220, seaDatum: 0 } as const;

/** Close an open ring (append the first vertex). */
function closed(open: Pt[]): Pt[] {
  return [...open.map((p): Pt => [p[0], p[1]]), [open[0][0], open[0][1]]];
}

// ─── Organic boundaries (shortlist item 4) ───────────────────────────────────
// Every polygon ring ships as an IRREGULAR polyline, never an axis-aligned box:
// corners are kept EXACT (stable anchors a premise test can find), and each edge
// gets a handful of intermediate vertices displaced perpendicular by deterministic
// seeded noise (mm-quantized). The jitter is keyed PURELY on the edge's two
// endpoints (canonicalized so orientation doesn't matter) + the campaign seed, so
// a boundary SHARED by two rings (the twins' common edge, a belt/city edge, a
// forest/farm hedgerow edge) is bit-identical from either side WITHOUT any manual
// "irregularize once" bookkeeping — same endpoints ⇒ same key ⇒ same points. The
// perpendicular offset tapers to 0 at both endpoints (sin bump), so corners stay
// exact and adjacent edges join cleanly.

/** Deterministic jitter points inserted along the edge a→b (endpoints EXCLUDED),
 * in a→b traversal order. Keyed on the canonical (endpoint-sorted) edge so a
 * shared edge yields the identical vertices from either ring. */
function jitterEdge(a: Pt, b: Pt): Pt[] {
  // Canonical endpoint order (orientation-independent): a shared edge hashes the
  // same key and generates the same sequence regardless of traversal direction.
  const forward = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const p0 = forward ? a : b;
  const p1 = forward ? b : a;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const segments = Math.max(2, Math.min(5, Math.round(len / 280)));
  const amp = Math.min(len * 0.05, 24); // meters; bounded so premises hold (park margin, ring crossings)
  const ux = -dy / len; // unit perpendicular
  const uy = dx / len;
  const rng = mulberry32(hashSeed(VAILMARCH_CAMPAIGN_SEED, "vm-edge", p0[0], p0[1], p1[0], p1[1]));
  const pts: Pt[] = [];
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const taper = Math.sin(Math.PI * t); // 0 at both ends, 1 at the midpoint
    const off = (rng() * 2 - 1) * amp * taper;
    pts.push([q(p0[0] + dx * t + ux * off), q(p0[1] + dy * t + uy * off)]);
  }
  return forward ? pts : pts.reverse();
}

/** The irregular OPEN ring of a corner list: each exact corner, followed by that
 * edge's jittered intermediate vertices. Deterministic; shared edges match by
 * construction (endpoint-keyed jitter). */
function irregularOpenRing(corners: Pt[]): Pt[] {
  const out: Pt[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    out.push([a[0], a[1]]);
    for (const p of jitterEdge(a, b)) out.push(p);
  }
  return out;
}

/** A ring scaled toward its centroid by `factor` (< 1 shrinks it inward). Traced
 * walls use this to sit JUST INSIDE the district boundary — a real city wall runs
 * inside its ring, and (load-bearing) the inset makes generated arterials, which
 * terminate ON the district ring, CROSS the wall transversally so the wall opens
 * a bearing'd gatehouse where each exits (a coincident wall only endpoint-grazes,
 * which floating-point jitter defeats). The wall still traces the ring's organic
 * SHAPE point-for-point, only offset inward. */
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

/** Inward inset applied to a wall that traces a district ring (see above). */
const WALL_TRACE_INSET = 0.94;

// ─── Geometry definition table (METERS) ──────────────────────────────────────
// The single source of truth. `poly` coords are an OPEN ring; `line` coords are
// a polyline. `algorithm` absent ⇒ an inert sketch (roads) with no procgen
// block. Ids are stable and unique.

interface RegionDef {
  id: string;
  kind: FabricKind;
  name: string;
  shape: "poly" | "line";
  /** METERS (generation space). For a `poly` these are the EXACT ring CORNERS
   * (the emitted ring is `irregularOpenRing(coords)`); for a `line` these are the
   * polyline vertices verbatim (rivers/relief spines/roads never irregularize). */
  coords: Pt[];
  /** A wall that TRACES another region's ring: its emitted polyline is the traced
   * region's IRREGULAR closed ring, so the wall follows the organic district
   * boundary point-for-point (`coords` is then just a fallback, unused). */
  traces?: string;
  algorithm?: string;
  params?: Record<string, unknown>;
  presetId?: string;
}

// The coordinate anchors that MULTIPLE features share are named so a premise
// test and every consumer read the same literal (a shared district edge, a
// river confluence vertex, a mountain ring the forest/farm overlap).

/** Main district ring (Vailmarch capital) — the river crosses it, the wall
 * traces it, the belt shares its south edge, the park nests inside. */
const CAPITAL_RING: Pt[] = [
  [-1950, -150],
  [-1050, -150],
  [-1050, 650],
  [-1950, 650],
];
/** Twin district A ring; its EAST edge (x = 2100, y ∈ [-800,-100]) is shared
 * verbatim with twin B (ε = 0 — hashed shared-edge stubs). */
const TWIN_A_RING: Pt[] = [
  [1500, -800],
  [2100, -800],
  [2100, -100],
  [1500, -100],
];
const TWIN_B_RING: Pt[] = [
  [2100, -800],
  [2700, -800],
  [2700, -100],
  [2100, -100],
];
/** The river Vail (main trunk), source (spine) → mouth (coast). Vertex[2]
 * (-800,1500) is the north-tributary confluence; vertex[5] (-1900,-200) is the
 * east-tributary confluence. Crosses the relief ridge (gorge) between [0] and
 * [2], and the capital between [3] and [5]. */
const VAIL_SPINE: Pt[] = [
  [-500, 2500],
  [-650, 2050],
  [-800, 1500],
  [-1150, 850],
  [-1500, 300],
  [-1900, -200],
  [-2300, -500],
  [-2750, -450],
];

const DEFS: RegionDef[] = [
  // ── TERRAIN: relief ridge/valley (add-stamps) — the ONLY elevation now; no
  //    mountain polygons (ruling 2026-07-15). The main Marchspine ridge runs E–W
  //    across the north (~900 m); two arms reach south (~800/750 m): the Cairn Arm
  //    through Cairnwood + the paddy terraces, the Haward Arm through the flank
  //    pasture — so the forest timberline, the paddy contours, and the pasture
  //    slope-gate all read RELIEF, plus the Torrent's source sits in raised ground.
  {
    id: "vm-relief-spine",
    kind: "relief",
    name: "The Marchspine",
    shape: "line",
    coords: [[-3600, 2400], [-2000, 2550], [-500, 2650], [1200, 2500], [3200, 2250]],
    // `apron` (parallel agent's foothill param): the grand range's peaks rise out
    // of a wide foothill skirt rather than a mesa wall (make-it-look-real item 2).
    algorithm: "relief",
    params: { polarity: "ridge", height: 1000, halfWidth: 600, apron: 500 },
    presetId: "ridge",
  },
  {
    // Cairn Arm — a ridge spur reaching south off the Marchspine, running through
    // Cairnwood (timberline gradient) and down into the Cairnfoot paddy (contours).
    id: "vm-relief-west-spur",
    kind: "relief",
    name: "Cairn Arm",
    shape: "line",
    coords: [[-1550, 2650], [-1500, 2150], [-1500, 1650]],
    algorithm: "relief",
    params: { polarity: "ridge", height: 800, halfWidth: 500, apron: 300 },
    presetId: "ridge",
  },
  {
    // Haward Arm — the eastern spur; its south slope drives the Hoarfell pasture
    // slope-gate and lifts the Torrent Beck source.
    id: "vm-relief-east-spur",
    kind: "relief",
    name: "Haward Arm",
    shape: "line",
    coords: [[1400, 2500], [1400, 2000], [1400, 1550]],
    algorithm: "relief",
    params: { polarity: "ridge", height: 750, halfWidth: 500, apron: 300 },
    presetId: "ridge",
  },
  {
    id: "vm-relief-valley",
    kind: "relief",
    name: "Vail Valley",
    shape: "line",
    coords: [[-800, 1500], [-1500, 300], [-2300, -500]],
    algorithm: "relief",
    params: { polarity: "valley", height: 150, halfWidth: 380 },
    presetId: "valley",
  },
  // ── TERRAIN: landform replace-stamps (plateau / basin / sea) ────────────────
  {
    id: "vm-landform-plateau",
    kind: "landform",
    name: "Eastmarch Tableland",
    shape: "poly",
    coords: [[2300, -700], [3800, -700], [3800, 1500], [2300, 1500]],
    algorithm: "landform",
    params: { mode: "plateau", target: 400, band: 150, priority: 0 },
    presetId: "plateau",
  },
  {
    id: "vm-landform-basin",
    kind: "landform",
    name: "Merewater Hollow",
    shape: "poly",
    coords: [[-900, -2500], [600, -2500], [600, -1200], [-900, -1200]],
    algorithm: "landform",
    params: { mode: "basin", target: -60, band: 150, priority: 0 },
    presetId: "basin",
  },
  {
    id: "vm-landform-sea",
    kind: "landform",
    name: "The Cold Reach",
    shape: "poly",
    coords: [[-4200, -2600], [-2900, -2600], [-2900, 2600], [-4200, 2600]],
    algorithm: "landform",
    params: { mode: "sea", target: -40, band: 80, priority: 1 },
    presetId: "sea",
  },
  // ── RIVERS (one system: Vail + two tributaries; the Marn serves the twins) ──
  {
    id: "vm-river-vail",
    kind: "river",
    name: "The Vail",
    shape: "line",
    coords: VAIL_SPINE,
    algorithm: "river",
    params: { windiness: 0.6, braiding: 0.35, width: 30, widthGrowth: 0.9, braidBias: 0.2, slopeSensitivity: 0 },
    presetId: "lazy-lowland",
  },
  {
    // The ONE river that opts INTO terrain (slopeSensitivity 1) — a torrent off
    // the east massif; its mouth == VAIL_SPINE[2] (confluence, Strahler step).
    id: "vm-river-trib-north",
    kind: "river",
    name: "Torrent Beck",
    shape: "line",
    coords: [[1000, 2600], [400, 2050], [-200, 1700], [-800, 1500]],
    algorithm: "river",
    params: { windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2, braidBias: 0, slopeSensitivity: 1 },
    presetId: "mountain-torrent",
  },
  {
    // Mouth == VAIL_SPINE[5] (second confluence → second Strahler step).
    id: "vm-river-trib-east",
    kind: "river",
    name: "Elder Brook",
    shape: "line",
    coords: [[-500, -1000], [-1200, -600], [-1900, -200]],
    algorithm: "river",
    params: { windiness: 0.5, braiding: 0.2, width: 18, widthGrowth: 0.4, braidBias: 0.2, slopeSensitivity: 0 },
    presetId: "lazy-lowland",
  },
  {
    id: "vm-river-marn",
    kind: "river",
    name: "The Marn",
    shape: "line",
    coords: [[3200, 700], [2600, 100], [2000, -450], [1350, -950]],
    algorithm: "river",
    params: { windiness: 0.55, braiding: 0.3, width: 14, widthGrowth: 0.6, braidBias: 0.2, slopeSensitivity: 0 },
    presetId: "lazy-lowland",
  },
  // ── CITIES ──────────────────────────────────────────────────────────────────
  {
    id: "vm-district-capital",
    kind: "district",
    name: "Vailmarch",
    shape: "poly",
    coords: CAPITAL_RING,
    algorithm: "city",
    params: { profile: "euro-medieval" },
    presetId: "euro-medieval",
  },
  {
    id: "vm-district-twin-a",
    kind: "district",
    name: "Twinbridge",
    shape: "poly",
    coords: TWIN_A_RING,
    algorithm: "city",
    params: { profile: "euro-continental" },
    presetId: "euro-continental",
  },
  {
    id: "vm-district-twin-b",
    kind: "district",
    name: "Eastwool",
    shape: "poly",
    coords: TWIN_B_RING,
    algorithm: "city",
    params: { profile: "eixample" },
    presetId: "eixample",
  },
  {
    id: "vm-district-coast",
    kind: "district",
    name: "Saltmere",
    shape: "poly",
    // Its west fringe reaches INTO the Cold Reach sea landform (the harbour laps
    // the water) — an overlap the "coastal town touches the sea" premise asserts,
    // robust to both rings' organic jitter.
    coords: [[-2950, -1750], [-2400, -1750], [-2400, -1200], [-2950, -1200]],
    algorithm: "city",
    params: { profile: "na-grid" },
    presetId: "na-grid",
  },
  // ── WALLS ────────────────────────────────────────────────────────────────────
  {
    // Traces the capital ring; moat becomes the river where the Vail crosses the
    // ring (water-gate + leat); gates fall at generated arterial exits.
    id: "vm-wall-capital",
    kind: "wall",
    name: "Vailmarch Wall",
    shape: "line",
    coords: closed(CAPITAL_RING),
    traces: "vm-district-capital",
    algorithm: "wall",
    params: { style: "curtain-wall", towerSpacing: 70, moat: true, gatehouseScale: 1 },
    presetId: "curtain-wall",
  },
  {
    id: "vm-wall-twin",
    kind: "wall",
    name: "Twinbridge Rampart",
    shape: "line",
    coords: closed(TWIN_A_RING),
    traces: "vm-district-twin-a",
    algorithm: "wall",
    params: { style: "bastioned", towerSpacing: 90, moat: true, gatehouseScale: 1.4 },
    presetId: "bastioned",
  },
  {
    // Standalone barrier across the gorge, crossing the Vail near VAIL_SPINE[1]
    // (-650,2050) — a water-gate stands alone here.
    id: "vm-wall-gorge",
    kind: "wall",
    name: "The Throat Gate",
    shape: "line",
    coords: [[-1100, 2050], [-650, 2000], [-200, 2050]],
    algorithm: "wall",
    params: { style: "curtain-wall", towerSpacing: 60, moat: false, gatehouseScale: 1.2 },
    presetId: "curtain-wall",
  },
  // ── ROADS (inert sketch — no procgen block) ─────────────────────────────────
  {
    // Enters + leaves the capital ring (two forced gates) and runs on into
    // Twinbridge; the great east road.
    id: "vm-road-highway",
    kind: "road",
    name: "The East Road",
    shape: "line",
    coords: [[-2400, 350], [-1400, 100], [-200, -100], [1400, -350], [1800, -450]],
  },
  {
    id: "vm-road-valley",
    kind: "road",
    name: "Vailside Track",
    shape: "line",
    coords: [[-2600, -450], [-1900, -150], [-1150, 800], [-700, 1500]],
  },
  {
    // Over the pass, crossing the relief ridge beside the gorge gate.
    id: "vm-road-pass",
    kind: "road",
    name: "Marchspine Pass",
    shape: "line",
    coords: [[-700, 1550], [-650, 2050], [-600, 2600]],
  },
  // ── PARKS ────────────────────────────────────────────────────────────────────
  {
    // Nested strictly inside the capital (hole-with-frontage); urban-park aligns
    // its entrances to the generated streets.
    id: "vm-park-capital",
    kind: "park",
    name: "Kingsmoot Green",
    shape: "poly",
    // Kept well clear of the capital ring (≥100 m base gap on every side) so that
    // both rings' organic jitter can never push the nested-park margin under 30 m.
    coords: [[-1850, 300], [-1520, 300], [-1520, 540], [-1850, 540]],
    algorithm: "park",
    params: { variety: "urban-park", pathDensity: 0.5, pond: true },
    presetId: "urban-park",
  },
  {
    // Adjacent to the hedge wood (shared east edge) + inside the basin lowland.
    id: "vm-park-rural",
    kind: "park",
    name: "Merewood Common",
    shape: "poly",
    coords: [[-600, -2100], [-100, -2100], [-100, -1550], [-600, -1550]],
    algorithm: "park",
    params: { variety: "wild-common", pathDensity: 0.3, pond: false },
    presetId: "wild-common",
  },
  // ── FORESTS ──────────────────────────────────────────────────────────────────
  {
    // Climbs the Cairn Arm ridge → timberline thinning + conifer-upslope stands.
    id: "vm-forest-spine",
    kind: "forest",
    name: "Cairnwood",
    shape: "poly",
    coords: [[-1950, 1900], [-900, 1900], [-900, 2700], [-1950, 2700]],
    algorithm: "forest",
    params: { variety: "conifer", density: 0.8, clearings: 0.08, edgeRaggedness: 0.3 },
    presetId: "conifer",
  },
  {
    // Over the Vail downstream → channel exclusion + riparian ramp.
    id: "vm-forest-riparian",
    kind: "forest",
    name: "Willowmere Wood",
    shape: "poly",
    coords: [[-2600, -800], [-2000, -800], [-2000, -150], [-2600, -150]],
    algorithm: "forest",
    params: { variety: "broadleaf", density: 0.7, clearings: 0.14, edgeRaggedness: 0.5 },
    presetId: "broadleaf",
  },
  {
    // Overlaps the capital NE → its GENERATED canopy attenuates cityness there.
    id: "vm-forest-cityedge",
    kind: "forest",
    name: "Wardholt",
    shape: "poly",
    coords: [[-1400, 400], [-1000, 400], [-1000, 1100], [-1400, 1100]],
    algorithm: "forest",
    params: { variety: "mixed", density: 0.65, clearings: 0.16, edgeRaggedness: 0.5 },
    presetId: "mixed",
  },
  {
    // Shares its east edge with the rural park + its north edge with a farm
    // (hedgerow both sides; canopy continuity with the park).
    id: "vm-forest-hedge",
    kind: "forest",
    name: "Hollowbrake",
    shape: "poly",
    coords: [[-1200, -2100], [-600, -2100], [-600, -1550], [-1200, -1550]],
    algorithm: "forest",
    params: { variety: "mixed", density: 0.6, clearings: 0.18, edgeRaggedness: 0.5 },
    presetId: "mixed",
  },
  {
    // Deep wild wood, over the Marn (riparian) in the plateau's shadow.
    id: "vm-forest-wild",
    kind: "forest",
    name: "The Ghostwood",
    shape: "poly",
    coords: [[1500, -1250], [2200, -1250], [2200, -450], [1500, -450]],
    algorithm: "forest",
    params: { variety: "dead-wood", density: 0.4, clearings: 0.32, edgeRaggedness: 0.7 },
    presetId: "dead-wood",
  },
  // ── FARMLAND ──────────────────────────────────────────────────────────────────
  {
    // Peri-urban belt sharing the capital's south edge — gate lanes + gradient.
    id: "vm-farm-capital-belt",
    kind: "farmland",
    name: "Vailmarch Fields",
    shape: "poly",
    coords: [[-1950, -750], [-1050, -750], [-1050, -150], [-1950, -150]],
    algorithm: "farmland",
    params: { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.45, farmsteads: 0.45 },
    presetId: "enclosed-patchwork",
  },
  {
    // Peri-urban belt sharing Twinbridge's south edge.
    id: "vm-farm-twin-belt",
    kind: "farmland",
    name: "Twinbridge Holdings",
    shape: "poly",
    coords: [[1500, -1450], [2100, -1450], [2100, -800], [1500, -800]],
    algorithm: "farmland",
    params: { fieldType: "enclosed-patchwork", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.45, farmsteads: 0.45 },
    presetId: "enclosed-patchwork",
  },
  {
    // Over the Marn → riverine long-lots + water meadows.
    id: "vm-farm-riverine",
    kind: "farmland",
    name: "Marnside Strips",
    shape: "poly",
    coords: [[2600, -150], [3300, -150], [3300, 600], [2600, 600]],
    algorithm: "farmland",
    params: { fieldType: "open-field-strips", fieldSize: 0.55, hedging: "none", laneDensity: 0.6, farmsteads: 0.3 },
    presetId: "open-field-strips",
  },
  {
    // On the Haward Arm's south slope → relief slope-gated pasture.
    id: "vm-farm-flank",
    kind: "farmland",
    name: "Hoarfell Pasture",
    shape: "poly",
    coords: [[850, 1500], [1900, 1500], [1900, 2000], [850, 2000]],
    algorithm: "farmland",
    params: { fieldType: "enclosed-patchwork", fieldSize: 0.45, hedging: "fences", laneDensity: 0.35, farmsteads: 0.25 },
    presetId: "enclosed-patchwork",
  },
  {
    // On the Cairn Arm's south slope → paddy terraces reading the relief contours.
    id: "vm-farm-paddy",
    kind: "farmland",
    name: "Cairnfoot Terraces",
    shape: "poly",
    coords: [[-2000, 1600], [-1300, 1600], [-1300, 2100], [-2000, 2100]],
    algorithm: "farmland",
    params: { fieldType: "paddy-terraces", fieldSize: 0.35, hedging: "none", laneDensity: 0.4, farmsteads: 0.25 },
    presetId: "paddy-terraces",
  },
  {
    // Shares the hedge wood's north edge (hedgerow) + inside the basin.
    id: "vm-farm-hedge",
    kind: "farmland",
    name: "Hollowbrake Crofts",
    shape: "poly",
    coords: [[-1200, -1550], [-600, -1550], [-600, -1000], [-1200, -1000]],
    algorithm: "farmland",
    params: { fieldType: "open-field-strips", fieldSize: 0.5, hedging: "hedgerows", laneDensity: 0.55, farmsteads: 0.3 },
    presetId: "open-field-strips",
  },
];

/** All region defs, stable order (part of the byte-identity contract). */
export const VAILMARCH_DEFS: readonly RegionDef[] = DEFS;
export type VailmarchDef = RegionDef;

const DEF_BY_ID = new Map(DEFS.map((d) => [d.id, d]));
/** Look up a def by id (throws on a typo — a test that names a stale id fails
 * loudly, never silently reads undefined). */
export function defById(id: string): RegionDef {
  const d = DEF_BY_ID.get(id);
  if (!d) throw new Error(`vailmarch: unknown def "${id}"`);
  return d;
}

/** A region/spine's persisted seed — the locked hashSeed(campaignSeed, id). */
export function seedFor(id: string): number {
  return hashSeed(VAILMARCH_CAMPAIGN_SEED, id);
}

/** The emitted METER geometry of a def: for a `poly`, the IRREGULAR open ring
 * (corners + seeded edge jitter); for a `line`, the polyline verbatim, except a
 * wall with `traces`, which returns the traced region's irregular CLOSED ring so
 * the wall follows the organic district boundary point-for-point. */
export function metersOf(id: string): Pt[] {
  const def = defById(id);
  if (def.shape === "poly") return irregularOpenRing(def.coords);
  if (def.traces) return closed(scaledTowardCentroid(irregularOpenRing(defById(def.traces).coords), WALL_TRACE_INSET));
  return def.coords.map((p): Pt => [p[0], p[1]]);
}

/** Build the procgen block for a def: seed from the locked convention, version
 * pinned to the algorithm's CURRENT contract, params validated by the
 * algorithm's own zod schema (a drifted registry fails the build loudly). */
function procgenBlock(def: RegionDef): ProcgenBlock {
  const alg = algorithmById(def.algorithm!);
  if (!alg) throw new Error(`vailmarch: unknown algorithm "${def.algorithm}"`);
  const parsed = alg.paramsSchema.parse(def.params ?? {});
  return {
    algorithm: def.algorithm!,
    seed: seedFor(def.id),
    version: alg.currentVersion,
    params: parsed,
    ...(def.presetId !== undefined ? { presetId: def.presetId } : {}),
  };
}

/** Convert a meter point to map units (÷ scale). */
function toUnits(p: Pt): Pt {
  return [p[0] / VAILMARCH_SCALE_M_PER_UNIT, p[1] / VAILMARCH_SCALE_M_PER_UNIT];
}

/** One fabric feature (MAP-UNIT coordinates; procgen PARAMS stay meters). The
 * geometry is the def's EMITTED meter geometry (`metersOf` — irregular ring for a
 * poly, traced ring for a wall) scaled to units. */
function fabricFeatureOf(def: RegionDef): FabricFeature {
  const meters = metersOf(def.id);
  const geometry: FabricFeature["geometry"] =
    def.shape === "poly"
      ? { type: "Polygon", coordinates: [closed(meters).map(toUnits)] }
      : { type: "LineString", coordinates: meters.map(toUnits) };
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

/** The full Vailmarch fabric (MAP UNITS), stable order — never reorder without
 * re-emitting the campaign. */
export function buildVailmarchFabric(): FabricCollection {
  return { type: "FeatureCollection", features: DEFS.map(fabricFeatureOf) };
}

/** The whole fabric as METER-coordinate features — what `terrainAt` and the
 * generators' `constraints.fabricFeatures` consume in-app (the host scales the
 * map-unit fabric back to this). The generation-proof tests build their
 * constraints from THIS. */
export function buildVailmarchFabricMeters(): FabricFeature[] {
  return DEFS.map((def) => {
    const meters = metersOf(def.id);
    const geometry: FabricFeature["geometry"] =
      def.shape === "poly"
        ? { type: "Polygon", coordinates: [closed(meters)] }
        : { type: "LineString", coordinates: meters };
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
  });
}

// ─── Location pins (canon notes) ─────────────────────────────────────────────

export interface VailmarchPin {
  /** Note basename (becomes `Locations/<name>.md`). */
  name: string;
  /** `type:` frontmatter — omitted for untyped pins. */
  type?: string;
  /** `visibility:` frontmatter — omitted where the default should apply. */
  visibility?: "wide" | "mid" | "close";
  /** METERS (generation space); the note stores `geometry:` in map units. */
  point: Pt;
  /** Note body (GM flavor). */
  body: string;
}

export const VAILMARCH_PINS: readonly VailmarchPin[] = [
  {
    name: "Vailmarch Market",
    type: "market",
    visibility: "mid",
    point: [-1500, 250],
    body: "The great square of Vailmarch, where the East Road fords the Vail. A typed `market` pin — the city plaza + arterial star anchor here (plan 039 §1.1).",
  },
  {
    name: "Vailmarch",
    type: "city",
    visibility: "wide",
    point: [-1500, 500],
    body: "The walled capital of the march, straddling the Vail. Bridges knit the two banks; the wall's moat becomes the river along the waterfront.",
  },
  {
    name: "Twinbridge",
    type: "town",
    visibility: "wide",
    point: [1800, -450],
    body: "The elder of the twin quarters below the tableland, its rampart older than Eastwool's grid. The two share a gate on the wall between them.",
  },
  {
    name: "Eastwool",
    type: "town",
    visibility: "mid",
    point: [2400, -450],
    body: "Eastwool's chamfered blocks were laid out in a single season. Its west gate faces Twinbridge across the shared wall.",
  },
  {
    name: "Saltmere",
    type: "town",
    visibility: "mid",
    point: [-2650, -1480],
    body: "A grid of net-lofts and salt-pans where the cold reach laps the march. The Vail's mouth silts its harbour a little more each winter.",
  },
  {
    name: "The Throat",
    visibility: "close",
    point: [-680, 2020],
    body: "Where the Vail knifes through the Marchspine — a gorge so narrow the Throat Gate wall bars it bank to bank, a single sluice for the river.",
  },
  {
    name: "Thorncap Shrine",
    type: "shrine",
    visibility: "close",
    point: [-1200, 2400],
    body: "The last shrine below the treeline of Cairnwood, where the conifers give out to bare fell. Pilgrims leave iron nails in the timber.",
  },
  {
    name: "Millrace Meet",
    visibility: "mid",
    point: [-800, 1500],
    body: "Torrent Beck throws itself into the Vail here in a churn of white water; the millers of the upper valley all keep wheels on the race.",
  },
  {
    name: "Plateau Watch",
    type: "landmark",
    visibility: "mid",
    point: [3000, 400],
    body: "A lonely tower on the Eastmarch Tableland, four hundred feet above the valley floor. On a clear day the watch can see the sea.",
  },
  {
    name: "Merelight",
    visibility: "mid",
    point: [-150, -1850],
    body: "A hermit's lantern-post on the shore of the Merewater, where the basin floods each spring. Herons stalk the reed-common of Merewood.",
  },
  {
    name: "Saltmere Light",
    type: "landmark",
    visibility: "close",
    point: [-2860, -1450],
    body: "The harbour beacon of Saltmere, its fire tended against the fogs of the cold reach.",
  },
];

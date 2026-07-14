/**
 * City profiles (procgen v3 §6): the per-genre parameter bundle that shapes a
 * domain's network — euro warren, euro continental, NA grid, NA suburb. This
 * file is a pure data table plus a theme→profile default; it makes no
 * decisions itself, so it has no determinism obligations beyond being a
 * constant (D6 — profiles are inputs, never derived at runtime from anything
 * host-side).
 *
 * SCOPE NOTE (v3.1): the Stage-A skeleton and the Stage-B growth loop read
 * their sections below. Stage-C (blocks/parcels) and wall parameters are
 * typed and populated with their §6 values so v3.2–v3.3 slot in without a
 * schema change or a re-tune of the values that already exist. Each field
 * documents which stage consumes it.
 */
import type { ProfileId } from "./domain";

/** Plaza-adjacent landmark footprint kinds (themes filter on `landmark`). */
export type LandmarkKind = "church" | "market" | "temple" | "keep";

/**
 * Form-based street-width table (plan 025 §3.3), metres facade-to-facade. Every
 * emitted `city-street` feature carries an explicit `width` read straight off
 * this table by its `roadClass` — themes ramp px from the width, and the §3.1
 * metrics (`streetLandShare`, `widthHistogram`) measure it directly.
 *
 * ADDITIVE-PARAMS (§3.3, binding): the four PRE-025 profiles set these to the
 * exact values the metrics module's class→width stand-in already used
 * (`WIDTH_BY_CLASS`: alley 5 · street 12 · ring 16 · arterial 18 · boulevard
 * 30), so emitting `width` changes ZERO measured metrics and moves ONLY the
 * cached bytes (a property gained, geometry untouched — the regenerate-on-
 * upgrade minor-version note in §3.3). New presets (superblock) set their own
 * widths — that IS their intended geometry signal, so their bytes/metrics are
 * theirs from birth. `boulevard` is unused by the current presets (it lands
 * with the §3.2 axial operator) but is typed now so haussmann slots in without
 * a schema change.
 */
export interface StreetWidths {
  arterial: number;
  ring: number;
  street: number;
  alley: number;
  boulevard: number;
}

/** The pre-025 class→width mapping, shared by every walkable profile so their
 * emitted widths reproduce the metrics stand-in exactly (additive-params). */
export const LEGACY_STREET_WIDTHS: StreetWidths = {
  arterial: 18,
  ring: 16,
  street: 12,
  alley: 5,
  boulevard: 30,
};

export interface CityProfile {
  id: ProfileId;

  // ── Stage A: skeleton (read in v3.0) ──────────────────────────────────
  /** Number of radial arterials from the center to the domain boundary when
   * no `routeHints` are supplied. §6 gives ranges; a single value is fixed
   * here for determinism (D3 — a count, not a convergence). */
  arterialCount: number;
  /** Waterfront street offsets (meters) from each sketched river, per bank.
   * Empty ⇒ no waterfront streets (NA profiles). Euro profiles quay at 20 m
   * and 55 m. Read by `skeleton.ts` (§5.1.4). */
  waterfrontOffsets: number[];
  /** Landmark footprints placed adjacent to the central plaza, facing it
   * (§5.1.6). The first two always place; extras (index ≥ 2, v3.3 landmark
   * pass) place with a hashed chance for variety. Read by `skeleton.ts`. */
  landmarks: LandmarkKind[];
  /** Half-extent (meters) of the central plaza polygon before per-vertex
   * hash jitter — final plaza spans roughly `2×plazaRadius` (§5.1.6, "~30–50 m
   * polygon"). Read by `skeleton.ts`. */
  plazaRadius: number;

  // ── Stage A: ring / wall (v3.3) ─────────────────────────────────────────
  /** Whether this profile always grows a defensive ring road + wall (§5.1.5). */
  hasWall: boolean;
  /** When `hasWall` is false: hashed chance the domain grows one anyway (§6
   * euro-continental "optional"; 0 for NA profiles). Read by `skeleton.ts`. */
  wallChance: number;
  /** Ring-road contour radius as a fraction of the domain radius (§5.1.5). */
  ringRadiusFrac: number;

  // ── Stage B: growth loop (v3.1) ────────────────────────────────────────
  /** Nominal grown-street segment length, meters (v3.1 addition — §6 lists no
   * step length; the growth loop needs one). Read by `growth.ts`. */
  segmentLen: number;
  /** Base probability that a committed segment spawns each side branch,
   * scaled up by cityness (v3.1 addition). Read by `growth.ts`. */
  branchProb: number;
  /** Cityness threshold below which growth stops (§5.4: "streets stop where
   * cityness < profile.edge"). Read by `growth.ts`. */
  edge: number;
  /** Base branch angle off a parent edge, radians (§6 "branchAngle"). */
  branchAngle: number;
  /** Random spread applied to `branchAngle`, radians (the "±" in §6). */
  branchAngleJitter: number;
  /** Per-segment curvature magnitude, radians/step (§6 "curvature"). 0 ⇒
   * straight streets (NA grid). */
  curvature: number;
  /** Junction snap distance, meters (§6 "snapDist"). */
  snapDist: number;
  /** Reject a joined edge whose angle falls below this, radians (§6
   * "minAngle") — kills slivers. */
  minAngle: number;
  /** Reject a committed edge shorter than this, meters. */
  minEdge: number;
  /** Prune dangling stubs shorter than this unless court-capped, meters. */
  minStub: number;
  /** Hard budget on committed segments (§6 "maxSegments", D3). */
  maxSegments: number;
  /** Sub-branch alleys in high-cityness blocks (§6 "alleys"). */
  alleys: boolean;
  /** Leave unsnapped street ends as cul-de-sac bulbs — the NA-suburb
   * signature (§6 "cul-de-sacs"). */
  culdesacs: boolean;
  /** Probability a candidate end may snap/trim to nearby fabric at all —
   * <1 lowers snap odds so unsnapped ends ARE the cul-de-sacs (§5.2
   * na-suburb, v3.4). Crossing cuts always apply (planarity). */
  snapProb: number;
  /** Grid-mode azimuth offsets (radians) added to each quadrant's hashed
   * base azimuth; non-empty switches the direction prior from the tensor
   * field to quadrant grids that jog where they meet (§5.2 na-grid, v3.4).
   * Empty for organic profiles. */
  gridAzimuths: number[];

  // ── Form-based width (plan 025 §3.3) ────────────────────────────────────
  /** Metre width emitted per roadClass (see `StreetWidths`). Read at emission
   * in `index.ts` and by the §3.1 metrics; NEVER affects growth geometry. */
  streetWidths: StreetWidths;

  // ── Corner treatment / grid orientation (plan 025-C, §3.4 + §2.4) ────────
  /** Block-corner chamfer setback in metres (plan 025 §3.4). >0 runs the
   * `chamferRing` post-pass on every block: each convex corner is cut back
   * `chamfer` m along both incident edges, turning square blocks into
   * octagons — the Barcelona-Cerdà signature (§2.4, the octagonal
   * intersection). The setback is capped per-corner so adjacent chamfers never
   * cross (see `chamferRing`). 0 ⇒ no chamfer (every pre-025-C preset). Applied
   * BEFORE parcels so footprints front the cut corner (the chaflán) and never
   * poke into it. Read in `index.ts`; NEVER affects growth geometry. */
  chamfer: number;
  /** Single-cardinal grid orientation (plan 025 §2.4 eixample). When true and
   * `gridAzimuths` is non-empty, the growth grid prior uses a fixed base
   * azimuth (0) for ALL quadrants instead of a per-quadrant hashed base, so the
   * whole city aligns to ONE orientation rather than jogging at the quadrant
   * seams the way `na-grid` does. false ⇒ the per-quadrant jog (every other
   * grid preset). Read by `growth.ts`. */
  uniformGrid: boolean;

  // ── Stage C: blocks / parcels / footprints (v3.2 — typed now, unread) ──
  /** Target block area window, m² (§6 "block target"). */
  blockAreaMin: number;
  blockAreaMax: number;
  /** OBB parcelling stop rules (§5.3.2). */
  parcelMinArea: number;
  parcelMaxAspect: number;
  parcelMinFrontage: number;
  /** Footprint inset from the parcel toward its frontage edge, meters
   * (buildings face the street; §5.3.3). */
  footprintInset: number;
  /** Base building depth, meters (scaled by cityness — §5.3.3 "depth/coverage
   * by cityness + profile"; v3.2 addition). Read by `parcels.ts`. */
  footprintDepth: number;
  /** Base fraction of the parcel's frontage width the building occupies
   * (scaled by cityness; v3.2 addition). Read by `parcels.ts`. */
  footprintCoverage: number;
}

/**
 * §6 parameter table. Angle fields are stored in radians (the table lists
 * degrees). Tune against screenshots per phase — these are the documented
 * starting values, not sacred.
 */
export const PROFILES: Record<ProfileId, CityProfile> = {
  "euro-medieval": {
    id: "euro-medieval",
    arterialCount: 5,
    waterfrontOffsets: [20, 55],
    landmarks: ["church", "market", "keep"],
    plazaRadius: 20,
    hasWall: true,
    wallChance: 1,
    ringRadiusFrac: 0.55,
    segmentLen: 40,
    branchProb: 0.45,
    edge: 0.22,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (25 * Math.PI) / 180,
    curvature: (8 * Math.PI) / 180,
    snapDist: 18,
    minAngle: (30 * Math.PI) / 180,
    minEdge: 12,
    minStub: 18,
    maxSegments: 4000,
    alleys: true,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [],
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 1000,
    blockAreaMax: 3000,
    parcelMinArea: 120,
    parcelMaxAspect: 3.5,
    parcelMinFrontage: 6,
    footprintInset: 1.5,
    footprintDepth: 10,
    footprintCoverage: 0.78,
  },
  "euro-continental": {
    id: "euro-continental",
    arterialCount: 4,
    waterfrontOffsets: [20, 55],
    landmarks: ["church", "market", "temple"],
    plazaRadius: 22,
    hasWall: false,
    wallChance: 0.4,
    ringRadiusFrac: 0.6,
    segmentLen: 55,
    branchProb: 0.35,
    edge: 0.2,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (10 * Math.PI) / 180,
    curvature: (3 * Math.PI) / 180,
    snapDist: 22,
    minAngle: (45 * Math.PI) / 180,
    minEdge: 16,
    minStub: 22,
    maxSegments: 3000,
    alleys: false,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [],
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 3000,
    blockAreaMax: 8000,
    parcelMinArea: 200,
    parcelMaxAspect: 3,
    parcelMinFrontage: 8,
    footprintInset: 2,
    footprintDepth: 14,
    footprintCoverage: 0.7,
  },
  "na-grid": {
    id: "na-grid",
    arterialCount: 4,
    waterfrontOffsets: [],
    landmarks: ["market", "temple"],
    plazaRadius: 24,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 80,
    branchProb: 0.5,
    edge: 0.2,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (2 * Math.PI) / 180,
    curvature: 0,
    snapDist: 25,
    minAngle: (60 * Math.PI) / 180,
    minEdge: 20,
    minStub: 25,
    maxSegments: 2500,
    alleys: true,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [0, Math.PI / 2],
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 6000,
    blockAreaMax: 12000,
    parcelMinArea: 300,
    parcelMaxAspect: 2.5,
    parcelMinFrontage: 10,
    footprintInset: 3,
    footprintDepth: 15,
    footprintCoverage: 0.6,
  },
  "na-suburb": {
    id: "na-suburb",
    arterialCount: 3,
    waterfrontOffsets: [],
    landmarks: ["market"],
    plazaRadius: 20,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 45,
    branchProb: 0.4,
    edge: 0.12,
    branchAngle: (75 * Math.PI) / 180,
    branchAngleJitter: (20 * Math.PI) / 180,
    curvature: (12 * Math.PI) / 180,
    snapDist: 12,
    minAngle: (35 * Math.PI) / 180,
    minEdge: 14,
    minStub: 30,
    maxSegments: 2000,
    alleys: false,
    culdesacs: true,
    snapProb: 0.55,
    gridAzimuths: [],
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 12000,
    blockAreaMax: 30000,
    parcelMinArea: 500,
    parcelMaxAspect: 2,
    parcelMinFrontage: 14,
    footprintInset: 4,
    footprintDepth: 10,
    footprintCoverage: 0.4,
  },
  // ── superblock (plan 025 §2.6) — the research's ANTI-pattern AS A GENRE ────
  // The Le-Corbusier / Chongqing modernist megablock, encoded DELIBERATELY as a
  // dystopian aesthetic (neon-sprawl / Dishonored), NOT as good urbanism. Its
  // §3.1 benchmark asserts the anti-pattern IS produced — sparse intersections,
  // internal dead-ends, wide arterial canyons, megablock grain. DO NOT "fix" it
  // toward walkable numbers: low connectivity is the whole point (§1.1, §2.6).
  //
  // How the params buy the look, all data-only (no new operator, §4 seq #2):
  //  • gridAzimuths [0, π/2] — a coarse orthogonal ARTERIAL grid (the canyons);
  //  • segmentLen 130 + high `edge` (0.4) + low branchProb (0.14) + low
  //    maxSegments — few, long streets ⇒ ~megablock faces, sparse junctions;
  //  • culdesacs true + snapProb 0.35 — the internal streets DEAD-END rather
  //    than knit through (the low-permeability signature);
  //  • streetWidths.arterial 85 (§1.1 "roads 70–100 m") — the wide canyon that
  //    reads on screen + drives streetLandShare/widthHistogram into >20 m;
  //  • towers-in-plot footprints — big inset, low coverage on huge parcels.
  superblock: {
    id: "superblock",
    arterialCount: 4,
    waterfrontOffsets: [],
    landmarks: ["market"],
    plazaRadius: 26,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 130,
    branchProb: 0.14,
    edge: 0.4,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (3 * Math.PI) / 180,
    curvature: 0,
    snapDist: 26,
    minAngle: (55 * Math.PI) / 180,
    minEdge: 22,
    minStub: 40,
    maxSegments: 900,
    alleys: false,
    culdesacs: true,
    snapProb: 0.35,
    gridAzimuths: [0, Math.PI / 2],
    // Wide arterial CANYONS (§1.1 70–100 m); ordinary internal streets stay
    // narrow so the width hierarchy reads as a hard step, not a ramp.
    streetWidths: { arterial: 85, ring: 40, street: 14, alley: 8, boulevard: 90 },
    chamfer: 0,
    uniformGrid: false,
    // Megablocks (§1.1 400–800 m): 400²–800² m² parcels-target windows.
    blockAreaMin: 160000,
    blockAreaMax: 640000,
    parcelMinArea: 4000,
    parcelMaxAspect: 2.2,
    parcelMinFrontage: 24,
    // Towers-in-plot: deep inset, sparse coverage on the huge parcels.
    footprintInset: 10,
    footprintDepth: 24,
    footprintCoverage: 0.32,
  },
  // ── tartan-grid (plan 025 §2.2) — Seoul / Tokyo Marunouchi two-scale grid ──
  // A COARSE regular arterial grid whose cells are packed with a FINE, dense
  // street+alley web — permeability at two scales at once, and the HIGHEST
  // intersection density of any preset (§1.3 tartan grids; anchor Seoul 313 /
  // Tokyo Nihonbashi 386). Data-only (no new operator): the look is bought by
  //  • gridAzimuths [0, π/2] — orthogonal grid direction prior;
  //  • wide arterials (26 m mains) vs narrow ordinary streets (9 m) — the
  //    "main/minor alternating" width contrast reads on screen;
  //  • short segmentLen (36 m ⇒ ~40 m grain) + high branchProb + low edge +
  //    high maxSegments + alleys — the fine web filling each coarse cell.
  "tartan-grid": {
    id: "tartan-grid",
    arterialCount: 6,
    waterfrontOffsets: [],
    landmarks: ["market", "temple"],
    plazaRadius: 22,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 36,
    branchProb: 0.62,
    edge: 0.1,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (3 * Math.PI) / 180,
    curvature: 0,
    snapDist: 16,
    minAngle: (55 * Math.PI) / 180,
    minEdge: 11,
    minStub: 16,
    maxSegments: 5200,
    alleys: true,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [0, Math.PI / 2],
    // Wide arterial mains vs narrow streets/alleys — the two-scale "tartan".
    streetWidths: { arterial: 26, ring: 16, street: 9, alley: 4, boulevard: 30 },
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 1000,
    blockAreaMax: 3000,
    parcelMinArea: 110,
    parcelMaxAspect: 3.5,
    parcelMinFrontage: 6,
    footprintInset: 1.2,
    footprintDepth: 9,
    footprintCoverage: 0.82,
  },
  // ── ward-grid (plan 025 §2.3) — Savannah modular walled quarters ───────────
  // A regular grid organised into WALLED modular quarters, each anchored by a
  // generated square/park (the landmark plaza + extra landmarks read as the
  // ward squares). Directional width asymmetry (§1.3 Savannah: 24–26 m mains,
  // 10 m standards) is approximated by the wide arterial (24 m) vs narrow
  // street (10 m) contrast. The ring wall is what makes the quarters read as
  // ENCLOSED (the "walled-quarter" screenshot signature), distinguishing it
  // from na-grid (open, jogged) and euro-medieval (walled but organic).
  "ward-grid": {
    id: "ward-grid",
    arterialCount: 4,
    waterfrontOffsets: [],
    landmarks: ["market", "temple", "church"],
    plazaRadius: 30,
    hasWall: true,
    wallChance: 1,
    ringRadiusFrac: 0.62,
    segmentLen: 64,
    branchProb: 0.42,
    edge: 0.16,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (4 * Math.PI) / 180,
    curvature: 0,
    snapDist: 22,
    minAngle: (55 * Math.PI) / 180,
    minEdge: 18,
    minStub: 22,
    maxSegments: 3200,
    alleys: false,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [0, Math.PI / 2],
    // Wide E-W mains vs narrow N-S standards (§1.3) — directional asymmetry.
    streetWidths: { arterial: 24, ring: 18, street: 10, alley: 6, boulevard: 30 },
    chamfer: 0,
    uniformGrid: false,
    blockAreaMin: 3000,
    blockAreaMax: 8000,
    parcelMinArea: 200,
    parcelMaxAspect: 3,
    parcelMinFrontage: 8,
    footprintInset: 2,
    footprintDepth: 13,
    footprintCoverage: 0.7,
  },
  // ── eixample (plan 025 §2.4) — Barcelona Cerdà chamfered octagon grid ──────
  // Uniform square blocks on a SINGLE cardinal orientation (uniformGrid) with
  // CHAMFERED corners (chamfer > 0 ⇒ the octagonal-intersection signature, the
  // one visual that must READ on screen), and a two-level avenue/street
  // hierarchy (wide arterials = the avenues connecting the territory; ordinary
  // streets = the locality). Anchor: Barcelona Cerdà ~103 int/km². The larger
  // segmentLen (78 m ⇒ ~100 m+ blocks) keeps blocks big enough that the 16 m
  // chamfer is clearly visible; no alleys (uniform blocks, not a fine web).
  eixample: {
    id: "eixample",
    arterialCount: 4,
    waterfrontOffsets: [],
    landmarks: ["market"],
    plazaRadius: 24,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 78,
    branchProb: 0.5,
    edge: 0.14,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (1.5 * Math.PI) / 180,
    curvature: 0,
    snapDist: 24,
    minAngle: (60 * Math.PI) / 180,
    minEdge: 22,
    minStub: 26,
    maxSegments: 2600,
    alleys: false,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [0, Math.PI / 2],
    // Avenue (arterial) vs street two-level hierarchy (§2.4).
    streetWidths: { arterial: 22, ring: 16, street: 13, alley: 6, boulevard: 30 },
    // The Cerdà chaflán: cut each block corner back 22 m → octagonal blocks +
    // octagonal intersections (a bold setback so the octagon READS on screen at
    // the gallery's fixed zoom, capped per-edge in `chamferRing`). uniformGrid
    // keeps the whole grid on ONE cardinal azimuth.
    chamfer: 22,
    uniformGrid: true,
    blockAreaMin: 6000,
    blockAreaMax: 12000,
    parcelMinArea: 280,
    parcelMaxAspect: 2.5,
    parcelMinFrontage: 10,
    footprintInset: 2.5,
    footprintDepth: 15,
    footprintCoverage: 0.6,
  },
};

/**
 * Default profile for a campaign theme (procgen v3 §3.1): parchment / ink-soot
 * read as euro-medieval; modern-clean / neon-sprawl as NA grid. Anything else
 * — including `obsidian-native` and an absent theme — defaults to
 * euro-medieval (the richest, most forgiving profile).
 */
export function defaultProfileForTheme(theme: string | undefined): ProfileId {
  switch (theme) {
    case "modern-clean":
      return "na-grid";
    // neon-sprawl is the dystopia/Dishonored palette — the superblock megablock
    // IS its genre (plan 025 §2.6 "superblock (neon-sprawl default)"). Only the
    // pre-filled default for a FRESH neon-sprawl district changes; existing
    // regions persist their own params and never re-roll (additive rule).
    case "neon-sprawl":
      return "superblock";
    case "parchment":
    case "ink-soot":
      return "euro-medieval";
    default:
      return "euro-medieval";
  }
}

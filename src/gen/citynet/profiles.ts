/**
 * City profiles: the per-genre parameter bundle that shapes a domain's network
 * — euro warren, euro continental, NA grid, NA suburb, and the pattern presets.
 * This file is a pure data table plus a theme→profile default; it makes no
 * decisions itself, so it has no determinism obligations beyond being a
 * constant (D6 — profiles are inputs, never derived at runtime from anything
 * host-side). Each field documents which stage consumes it.
 */
import type { ProfileId } from "./domain";

/** Plaza-adjacent landmark footprint kinds (themes filter on `landmark`). */
export type LandmarkKind = "church" | "market" | "temple" | "keep";

/**
 * Form-based street-width table, metres facade-to-facade. Every emitted
 * `city-street` feature carries an explicit `width` read straight off this
 * table by its `roadClass` — themes ramp px from the width, and the metrics
 * (`streetLandShare`, `widthHistogram`) measure it directly.
 */
export interface StreetWidths {
  arterial: number;
  ring: number;
  street: number;
  alley: number;
  boulevard: number;
}

/**
 * Axial-breakthrough configuration. A profile that carries this drives a
 * deterministic post-growth pass that CUTS wide boulevards THROUGH the
 * already-grown organic fabric — the Haussmann breakthrough (perspective
 * boulevards slicing the retained medieval warren) and the Baroque trident (a
 * fan of straight corsi from one gate piazza). The cut splices `boulevard`-class
 * edges into the planar street graph BEFORE faces and parcels, so the blocks it
 * crosses re-close and their parcels re-split fronting the boulevard — no reflow
 * pass, all downstream stages compute once against the final graph. The organic
 * fabric BETWEEN the cuts is untouched (the palimpsest is preserved).
 *
 * OPTIONAL: a profile that omits it (`undefined`) skips `driveBoulevards`
 * entirely — the operator only runs for a profile that opts in (haussmann,
 * baroque-axial).
 */
export interface AxialConfig {
  /** How many boulevard cuts to drive. Haussmann: 2–4 chords fanning across the
   * fabric; Baroque trident: the fan count (3 = the classic Roma Trident). */
  count: number;
  /** `"breakthrough"` (Haussmann): each cut is a chord between two boundary
   * points at interleaved bearings — the chords cross at interior STAR plazas.
   * `"trident"` (Baroque): all cuts share ONE apex (a gate piazza on the rim)
   * and fan straight toward monumental endpoints on the far side. */
  mode: "breakthrough" | "trident";
  /** Max elbow displacement of a cut's midpoint, as a fraction of its length,
   * perpendicular to the chord (the Haussmann "slight convex effect").
   * 0 ⇒ dead-straight (Baroque corsi are straight). Hashed sign per cut. */
  elbow: number;
}

/**
 * Concentric-ring composition (canal-rings / radial-star / euro-medieval
 * growth-rings). A profile carrying this drives the `rings.ts` operator: `count`
 * concentric rings around the generation center, stepping from `innerFrac` to
 * `outerFrac` of the region's interior radius.
 *
 *  • `mode: "roads"` (radial-star, growth-ring) — the rings splice into the
 *    grown graph as `ring`-class GROWN edges (concentric CONNECTOR rings crossed
 *    by the radial arterials → wedge blocks), BEFORE faces/parcels.
 *  • `mode: "canals"` (canal-rings) — the rings are WATER: emitted as visible
 *    canal features AND folded into the constraints as `river` lines, so the
 *    shared citynet water machinery gives bridges where radials cross and quays
 *    along the banks with no new water plumbing.
 *
 * OPTIONAL: a profile that omits it never runs the ring operator.
 */
export interface ConcentricConfig {
  /** Number of concentric rings (radial-star: 3–4; growth-ring inner: 1). */
  count: number;
  mode: "roads" | "canals";
  /** Innermost ring radius as a fraction of `region.maxInteriorDistance`. */
  innerFrac: number;
  /** Outermost ring radius as a fraction of `region.maxInteriorDistance`. */
  outerFrac: number;
}

/** The class→width mapping shared by every walkable profile, so their emitted
 * widths match the metrics width stand-in exactly. */
export const LEGACY_STREET_WIDTHS: StreetWidths = {
  arterial: 18,
  ring: 16,
  street: 12,
  alley: 5,
  boulevard: 30,
};

export interface CityProfile {
  id: ProfileId;

  // ── Stage A: skeleton ─────────────────────────────────────────────────
  /** Number of radial arterials from the center to the domain boundary when
   * no `routeHints` are supplied. A single fixed value (not a range) keeps it
   * deterministic (D3 — a count, not a convergence). */
  arterialCount: number;
  /** Waterfront street offsets (meters) from each sketched river, per bank.
   * Empty ⇒ no waterfront streets (NA profiles). Euro profiles quay at 20 m
   * and 55 m. Read by `skeleton.ts`. */
  waterfrontOffsets: number[];
  /** Landmark footprints placed adjacent to the central plaza, facing it.
   * The first two always place; extras (index ≥ 2) place with a hashed chance
   * for variety. Read by `skeleton.ts`. */
  landmarks: LandmarkKind[];
  /** Half-extent (meters) of the central plaza polygon before per-vertex
   * hash jitter — final plaza spans roughly `2×plazaRadius` (~30–50 m polygon).
   * Read by `skeleton.ts`. */
  plazaRadius: number;

  // ── Stage A: ring / wall ────────────────────────────────────────────────
  /** Whether this profile always grows a defensive ring road + wall. */
  hasWall: boolean;
  /** When `hasWall` is false: hashed chance the domain grows one anyway
   * (euro-continental "optional"; 0 for NA profiles). Read by `skeleton.ts`. */
  wallChance: number;
  /** Ring-road contour radius as a fraction of the domain radius. */
  ringRadiusFrac: number;

  // ── Stage B: growth loop ───────────────────────────────────────────────
  /** Nominal grown-street segment length, meters. Read by `growth.ts`. */
  segmentLen: number;
  /** Base probability that a committed segment spawns each side branch,
   * scaled up by cityness. Read by `growth.ts`. */
  branchProb: number;
  /** Cityness threshold below which growth stops (streets stop where
   * cityness < profile.edge). Read by `growth.ts`. */
  edge: number;
  /** Base branch angle off a parent edge, radians. */
  branchAngle: number;
  /** Random spread applied to `branchAngle`, radians. */
  branchAngleJitter: number;
  /** Per-segment curvature magnitude, radians/step. 0 ⇒
   * straight streets (NA grid). */
  curvature: number;
  /** Junction snap distance, meters. */
  snapDist: number;
  /** Reject a joined edge whose angle falls below this, radians — kills
   * slivers. */
  minAngle: number;
  /** Reject a committed edge shorter than this, meters. */
  minEdge: number;
  /** Prune dangling stubs shorter than this unless court-capped, meters. */
  minStub: number;
  /** Hard budget on committed segments (D3). */
  maxSegments: number;
  /** Sub-branch alleys in high-cityness blocks. */
  alleys: boolean;
  /** Leave unsnapped street ends as cul-de-sac bulbs — the NA-suburb
   * signature. */
  culdesacs: boolean;
  /** Probability a candidate end may snap/trim to nearby fabric at all —
   * <1 lowers snap odds so unsnapped ends ARE the cul-de-sacs (na-suburb).
   * Crossing cuts always apply (planarity). */
  snapProb: number;
  /** Grid-mode azimuth offsets (radians) added to each quadrant's hashed
   * base azimuth; non-empty switches the direction prior from the tensor
   * field to quadrant grids that jog where they meet (na-grid).
   * Empty for organic profiles. */
  gridAzimuths: number[];

  // ── Form-based width ────────────────────────────────────────────────────
  /** Metre width emitted per roadClass (see `StreetWidths`). Read at emission
   * in `index.ts` and by the metrics; NEVER affects growth geometry. */
  streetWidths: StreetWidths;

  // ── Corner treatment / grid orientation ─────────────────────────────────
  /** Block-corner chamfer setback in metres. >0 runs the `chamferRing`
   * post-pass on every block: each convex corner is cut back `chamfer` m along
   * both incident edges, turning square blocks into octagons — the
   * Barcelona-Cerdà signature (the octagonal intersection). The setback is
   * capped per-corner so adjacent chamfers never cross (see `chamferRing`).
   * 0 ⇒ no chamfer. Applied BEFORE parcels so footprints front the cut corner
   * (the chaflán) and never poke into it. Read in `index.ts`; NEVER affects
   * growth geometry. */
  chamfer: number;
  /** Single-cardinal grid orientation (eixample). When true and `gridAzimuths`
   * is non-empty, the growth grid prior uses a fixed base azimuth (0) for ALL
   * quadrants instead of a per-quadrant hashed base, so the whole city aligns
   * to ONE orientation rather than jogging at the quadrant seams the way
   * `na-grid` does. false ⇒ the per-quadrant jog. Read by `growth.ts`. */
  uniformGrid: boolean;

  // ── Axial breakthrough ──────────────────────────────────────────────────
  /** Optional axial-breakthrough config (see `AxialConfig`). Present ⇒ the
   * `driveBoulevards` post-pass cuts boulevards through the grown fabric before
   * faces/parcels (haussmann + baroque-axial). Absent ⇒ no boulevards. Read in
   * `index.ts` after growth. */
  axial?: AxialConfig;

  // ── Concentric rings + additive upgrades ────────────────────────────────
  /** Optional concentric-ring config (see `ConcentricConfig`). Present ⇒ the
   * `rings.ts` operator lays concentric ring roads (radial-star) or canals
   * (canal-rings). */
  concentric?: ConcentricConfig;
  /** Seam-boulevard upgrade (na-grid): promote the per-quadrant grid-collision
   * seam into ONE wide diagonal boulevard (a Market-Street cut) across the
   * fabric. DEFAULT off (registry param). When on, `index.ts` drives a single
   * breakthrough boulevard so the seam becomes a feature, not a jog. */
  seamBoulevard?: boolean;
  /** Growth-rings upgrade (euro-medieval): number of successive WALLS/ring-roads
   * — 1 (default, a single wall) or 2 (a second, older inner ring road, the
   * Paris Châtelet reading). `2` splices one inner concentric ring road via
   * `rings.ts`. Exposed as a registry param. */
  growthRings?: number;

  // ── Stage C: blocks / parcels / footprints ──────────────────────────────
  /** Target block area window, m². */
  blockAreaMin: number;
  blockAreaMax: number;
  /** OBB parcelling stop rules. */
  parcelMinArea: number;
  parcelMaxAspect: number;
  parcelMinFrontage: number;
  /** Footprint inset from the parcel toward its frontage edge, meters
   * (buildings face the street). */
  footprintInset: number;
  /** Base building depth, meters (scaled by cityness). Read by `parcels.ts`. */
  footprintDepth: number;
  /** Base fraction of the parcel's frontage width the building occupies
   * (scaled by cityness). Read by `parcels.ts`. */
  footprintCoverage: number;
}

/**
 * Parameter table. Angle fields are stored in radians. Tune against screenshots
 * per phase — these are the documented starting values, not sacred.
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
  // ── superblock — the research's ANTI-pattern AS A GENRE ───────────────────
  // The Le-Corbusier / Chongqing modernist megablock, encoded DELIBERATELY as a
  // dystopian aesthetic (neon-sprawl / Dishonored), NOT as good urbanism. Its
  // benchmark asserts the anti-pattern IS produced — sparse intersections,
  // internal dead-ends, wide arterial canyons, megablock grain. DO NOT "fix" it
  // toward walkable numbers: low connectivity is the whole point.
  //
  // How the params buy the look, all data-only (no new operator):
  //  • gridAzimuths [0, π/2] — a coarse orthogonal ARTERIAL grid (the canyons);
  //  • segmentLen 130 + high `edge` (0.4) + low branchProb (0.14) + low
  //    maxSegments — few, long streets ⇒ ~megablock faces, sparse junctions;
  //  • culdesacs true + snapProb 0.35 — the internal streets DEAD-END rather
  //    than knit through (the low-permeability signature);
  //  • streetWidths.arterial 85 (roads 70–100 m) — the wide canyon that
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
    // Wide arterial CANYONS (70–100 m); ordinary internal streets stay
    // narrow so the width hierarchy reads as a hard step, not a ramp.
    streetWidths: { arterial: 85, ring: 40, street: 14, alley: 8, boulevard: 90 },
    chamfer: 0,
    uniformGrid: false,
    // Megablocks (400–800 m): 400²–800² m² parcels-target windows.
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
  // ── tartan-grid — Seoul / Tokyo Marunouchi two-scale grid ─────────────────
  // A COARSE regular arterial grid whose cells are packed with a FINE, dense
  // street+alley web — permeability at two scales at once, and the HIGHEST
  // intersection density of any preset (tartan grids; anchor Seoul 313 /
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
  // ── ward-grid — Savannah modular walled quarters ──────────────────────────
  // A regular grid organised into WALLED modular quarters, each anchored by a
  // generated square/park (the landmark plaza + extra landmarks read as the
  // ward squares). Directional width asymmetry (Savannah: 24–26 m mains,
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
    // Wide E-W mains vs narrow N-S standards — directional asymmetry.
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
  // ── eixample — Barcelona Cerdà chamfered octagon grid ─────────────────────
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
    // Avenue (arterial) vs street two-level hierarchy.
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
  // ── haussmann — Paris breakthrough boulevards ─────────────────────────────
  // An EURO-MEDIEVAL organic base (identical growth params — the retained
  // medieval warren) PLUS the axial-breakthrough operator: 3 wide (30 m,
  // roadClass `boulevard`) perspective boulevards CUT as chords through the
  // grown fabric, crossing at interior STAR plazas, slight elbow permitted
  // (the "convex effect"). The organic fabric BETWEEN the cuts survives — the
  // palimpsest IS the look. The base fabric being identical to euro-medieval
  // makes the boulevards the ONLY differentiator: the operator's whole
  // contribution reads on screen. hasWall stays true (the gates + ring
  // anchor the "aimed at the gates" reading; the operator itself derives its
  // chord bearings from the region + center, so it is robust with or without a
  // wall). Anchor: Paris Étoile 133 · Mayfair 165 (organic grain, few grand cuts).
  haussmann: {
    id: "haussmann",
    arterialCount: 5,
    waterfrontOffsets: [20, 55],
    landmarks: ["church", "market", "keep", "temple"],
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
    // 3 boulevard chords, slight convex elbow — the breakthrough web + stars.
    axial: { count: 3, mode: "breakthrough", elbow: 0.06 },
    blockAreaMin: 1000,
    blockAreaMax: 3000,
    parcelMinArea: 120,
    parcelMaxAspect: 3.5,
    parcelMinFrontage: 6,
    footprintInset: 1.5,
    footprintDepth: 10,
    footprintCoverage: 0.78,
  },
  // ── baroque-axial — Roma Trident / Turin Via Po ───────────────────────────
  // Organic euro-medieval base + a TRIDENT: a fan of `count` straight corsi all
  // radiating from ONE gate piazza on the rim toward monumental endpoints on the
  // far side (the "points of view"). Distinct from haussmann (independent
  // chords crossing at multiple stars): here the boulevards share the apex —
  // ONE grand star at the gate piazza, straight axes (elbow 0). Distinct from
  // radial-star: that IS the whole fabric; this composes a few axes THROUGH
  // retained organic fabric. Anchor: Roma Trident · Turin Via Po.
  "baroque-axial": {
    id: "baroque-axial",
    arterialCount: 5,
    waterfrontOffsets: [20, 55],
    landmarks: ["church", "market", "keep", "temple"],
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
    // 3 straight corsi fanning from one gate piazza — the Roma Trident.
    axial: { count: 3, mode: "trident", elbow: 0 },
    blockAreaMin: 1000,
    blockAreaMax: 3000,
    parcelMinArea: 120,
    parcelMaxAspect: 3.5,
    parcelMinFrontage: 6,
    footprintInset: 1.5,
    footprintDepth: 10,
    footprintCoverage: 0.78,
  },
  // ── canal-rings — Amsterdam 17th-c. concentric canal city ─────────────────
  // Concentric canal ARCS around the generation center, crossed by radial
  // arterials. The canals emit as WATER (a distinct `city-landmark` type=canal
  // line, painted with the theme water hue) AND are folded into the constraint
  // system as `river` lines — so the EXISTING citynet water machinery does the
  // work with no new plumbing: the radial
  // arterials BRIDGE each canal (cost-field crossing toll ⇒ shared bridges),
  // quays line the banks (waterfrontOffsets → the offset-quay path), and grown
  // streets + footprints stay OUT of the water ⇒ the elongated blocks BETWEEN
  // the rings. A regular-block base (euro-continental-like) reads as the tidy
  // burgher fabric between canals. Anchor: Amsterdam 17th-c. ≈195 int/km².
  "canal-rings": {
    id: "canal-rings",
    // Several radials so multiple bridges cross each canal ring (the Amsterdam
    // radial-street reading); they cast from the center to the rim.
    arterialCount: 6,
    // Quays hug each canal bank: a near bank (12 m) and a service lane (34 m).
    waterfrontOffsets: [12, 34],
    landmarks: ["church", "market", "temple"],
    plazaRadius: 22,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 52,
    branchProb: 0.36,
    edge: 0.16,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (8 * Math.PI) / 180,
    curvature: (3 * Math.PI) / 180,
    snapDist: 22,
    minAngle: (40 * Math.PI) / 180,
    minEdge: 16,
    minStub: 22,
    maxSegments: 3200,
    alleys: false,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [],
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    // 3 concentric canals from ~0.34 to ~0.9 of the interior radius.
    concentric: { count: 3, mode: "canals", innerFrac: 0.34, outerFrac: 0.9 },
    blockAreaMin: 2000,
    blockAreaMax: 6000,
    parcelMinArea: 160,
    parcelMaxAspect: 3.2,
    parcelMinFrontage: 7,
    footprintInset: 1.5,
    footprintDepth: 12,
    footprintCoverage: 0.74,
  },
  // ── radial-star — Paris Étoile / baroque star ─────────────────────────────
  // Avenues radiating from a rond-point (the region center) crossed by
  // concentric CONNECTOR RINGS, wedge blocks subdividing toward the rim. Unlike
  // baroque-axial (a few axes composed THROUGH organic fabric), here the radial
  // star + rings ARE the fabric. Realised by (a) a high `arterialCount` — the
  // star spokes — and (b) the concentric ring ROADS (`mode:"roads"`)
  // spliced into the grown graph, so spokes × rings box the wedge blocks. A
  // regular-block growth base fills each wedge. Anchor: Paris Étoile ≈133.
  "radial-star": {
    id: "radial-star",
    // The rond-point spokes: many radials fan from the center (the "star").
    arterialCount: 9,
    waterfrontOffsets: [],
    landmarks: ["church", "market", "temple", "keep"],
    plazaRadius: 30,
    hasWall: false,
    wallChance: 0,
    ringRadiusFrac: 0,
    segmentLen: 58,
    branchProb: 0.34,
    edge: 0.16,
    branchAngle: Math.PI / 2,
    branchAngleJitter: (10 * Math.PI) / 180,
    curvature: (4 * Math.PI) / 180,
    snapDist: 24,
    minAngle: (40 * Math.PI) / 180,
    minEdge: 18,
    minStub: 24,
    maxSegments: 3000,
    alleys: false,
    culdesacs: false,
    snapProb: 1,
    gridAzimuths: [],
    // The star avenues read as through-avenues (arterial width) — the emitted
    // ring roads carry `ring` width; the spokes carry `arterial` width.
    streetWidths: LEGACY_STREET_WIDTHS,
    chamfer: 0,
    uniformGrid: false,
    // 3 concentric connector rings from ~0.3 to ~0.92 of the interior radius.
    concentric: { count: 3, mode: "roads", innerFrac: 0.3, outerFrac: 0.92 },
    blockAreaMin: 2000,
    blockAreaMax: 6000,
    parcelMinArea: 160,
    parcelMaxAspect: 3.2,
    parcelMinFrontage: 8,
    footprintInset: 2,
    footprintDepth: 13,
    footprintCoverage: 0.7,
  },
};

/**
 * Default profile for a campaign theme: parchment / ink-soot
 * read as euro-medieval; modern-clean / neon-sprawl as NA grid. Anything else
 * — including `obsidian-native` and an absent theme — defaults to
 * euro-medieval (the richest, most forgiving profile).
 */
export function defaultProfileForTheme(theme: string | undefined): ProfileId {
  switch (theme) {
    case "modern-clean":
      return "na-grid";
    // neon-sprawl is the dystopia/Dishonored palette — the superblock megablock
    // IS its genre. This only sets the pre-filled default for a FRESH
    // neon-sprawl district; existing regions persist their own params.
    case "neon-sprawl":
      return "superblock";
    case "parchment":
    case "ink-soot":
      return "euro-medieval";
    default:
      return "euro-medieval";
  }
}

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
    blockAreaMin: 12000,
    blockAreaMax: 30000,
    parcelMinArea: 500,
    parcelMaxAspect: 2,
    parcelMinFrontage: 14,
    footprintInset: 4,
    footprintDepth: 10,
    footprintCoverage: 0.4,
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
    case "neon-sprawl":
      return "na-grid";
    case "parchment":
    case "ink-soot":
      return "euro-medieval";
    default:
      return "euro-medieval";
  }
}

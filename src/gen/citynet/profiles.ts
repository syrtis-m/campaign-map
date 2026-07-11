/**
 * City profiles (procgen v3 §6): the per-genre parameter bundle that shapes a
 * domain's network — euro warren, euro continental, NA grid, NA suburb. This
 * file is a pure data table plus a theme→profile default; it makes no
 * decisions itself, so it has no determinism obligations beyond being a
 * constant (D6 — profiles are inputs, never derived at runtime from anything
 * host-side).
 *
 * SCOPE NOTE (v3.0): only the Stage-A skeleton reads a handful of these fields
 * (`arterialCount`, `waterfrontOffsets`, `landmarks`, plaza sizing). Every
 * later-stage parameter — growth angles, snapping, blocks, parcels, walls — is
 * already typed and populated with its §6 value so that v3.1–v3.3 slot in
 * without a schema change or a re-tune of the values that already exist. Each
 * field documents which stage consumes it.
 */
import type { ProfileId } from "./domain";

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
   * (§5.1.6). Read by `skeleton.ts`. */
  landmarks: ("church" | "market")[];
  /** Half-extent (meters) of the central plaza polygon before per-vertex
   * hash jitter — final plaza spans roughly `2×plazaRadius` (§5.1.6, "~30–50 m
   * polygon"). Read by `skeleton.ts`. */
  plazaRadius: number;

  // ── Stage A: ring / wall (v3.3 — typed now, unread in v3.0) ────────────
  /** Whether this profile grows a defensive ring road + wall (§5.1.5). */
  hasWall: boolean;
  /** Ring-road network-distance contour radius as a fraction of `radius`
   * (v3.3). Ignored when `hasWall` is false. */
  ringRadiusFrac: number;

  // ── Stage B: growth loop (v3.1 — typed now, unread in v3.0) ────────────
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
  /** Grid azimuths (radians) seeded per quadrant for `na-grid` jogs; empty
   * for organic profiles (§5.2). */
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
    landmarks: ["church", "market"],
    plazaRadius: 20,
    hasWall: true,
    ringRadiusFrac: 0.55,
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
    gridAzimuths: [],
    blockAreaMin: 1000,
    blockAreaMax: 3000,
    parcelMinArea: 120,
    parcelMaxAspect: 3.5,
    parcelMinFrontage: 6,
    footprintInset: 1.5,
  },
  "euro-continental": {
    id: "euro-continental",
    arterialCount: 4,
    waterfrontOffsets: [20, 55],
    landmarks: ["church", "market"],
    plazaRadius: 22,
    hasWall: false,
    ringRadiusFrac: 0.6,
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
    gridAzimuths: [],
    blockAreaMin: 3000,
    blockAreaMax: 8000,
    parcelMinArea: 200,
    parcelMaxAspect: 3,
    parcelMinFrontage: 8,
    footprintInset: 2,
  },
  "na-grid": {
    id: "na-grid",
    arterialCount: 4,
    waterfrontOffsets: [],
    landmarks: ["market"],
    plazaRadius: 24,
    hasWall: false,
    ringRadiusFrac: 0,
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
    gridAzimuths: [0, Math.PI / 2],
    blockAreaMin: 6000,
    blockAreaMax: 12000,
    parcelMinArea: 300,
    parcelMaxAspect: 2.5,
    parcelMinFrontage: 10,
    footprintInset: 3,
  },
  "na-suburb": {
    id: "na-suburb",
    arterialCount: 3,
    waterfrontOffsets: [],
    landmarks: ["market"],
    plazaRadius: 20,
    hasWall: false,
    ringRadiusFrac: 0,
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
    gridAzimuths: [],
    blockAreaMin: 12000,
    blockAreaMax: 30000,
    parcelMinArea: 500,
    parcelMaxAspect: 2,
    parcelMinFrontage: 14,
    footprintInset: 4,
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

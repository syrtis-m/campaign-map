/**
 * Park generator (plan 022 §3.3, reshaped by plan 027-A/-B). Pure/headless (no
 * DOM/map/Obsidian imports; reads only its arguments, D6): a sketched `park`
 * polygon is the region; this fills it with a ground fabric, lays a REAL path
 * skeleton hung off boundary ENTRANCES, and dresses it per `variety` —
 * everything strictly inside the ring.
 *
 * Four varieties (params, never presetId — mirrors the city algorithm's
 * `profile` branch): `formal-garden` (axial composition on the ring's principal
 * inertia axis + mirror-symmetric beds/bosquets + a central basin), `city-park`
 * (perimeter loop + curvilinear entrance-to-entrance diagonals + lawns + canopy
 * clumps + optional pond + bandstand), `wild-common` (restraint by design: a
 * meadow, 1–2 desire-line crossings, sparse edge trees, a duck pond, ONE
 * landmark), `japanese-garden` (a deliberately asymmetric strolling garden: one
 * winding circuit around an irregular pond, an island + bridge, lanterns at
 * inflections + the water edge, odd-count horizontal-dominant rock groups, a
 * teahouse + roji stepping-stone spur, and an optional raked-gravel
 * `karesansui` court; small regions degrade gracefully).
 *
 * Plan 027-A figure-ground rewrite:
 *  - GROUND is ONE `park-lawn` polygon = the region ring (no cell lattice).
 *  - CANOPY (the second green) = `park-canopy` harmonic-blob clumps at hashed
 *    absolute-lattice anchors (city-park).
 *  - PATHS are `park-path` LINESTRINGS carrying a `class` (theme casing+fill).
 *
 * Plan 027-B skeleton rewrite (§2):
 *  - ENTRANCES: boundary points where a SKETCHED road passes within a threshold
 *    of the ring (`constraints.fabricFeatures`, gen-space via
 *    `indexFabricConstraints`), plus hashed edge-midpoint fallbacks (2–5 total).
 *    Each entrance is derived from LOCAL geometry (a specific road crossing or a
 *    specific ring edge) and hashed on its ABSOLUTE boundary position — so a
 *    far-vertex edit leaves near-side entrances byte-identical (edit-local), and
 *    a re-roll (new seed) re-selects the midpoint fallbacks.
 *  - PATHS connect entrances (city diagonals, wild desire lines) and now REACH
 *    the ring: a path endpoint sits on the boundary (distance ~0, clears the
 *    containment gate's −1 m tolerance, which scans centerlines).
 *  - formal-garden lays its axes on the ring's principal inertia axis (stable
 *    under small edits, hash-tiebroken when isotropic) with a cross-axis at the
 *    basin node and mirror-symmetric beds/bosquets (exact reflection within
 *    mm-quantization) around a central circular basin (`park-pond` + fountain).
 *  - japanese-garden gains lanterns, a teahouse + roji spur, and odd-count rock
 *    groups; the circuit is the winding loop around the pond.
 *  - point dressing (fountain/bandstand/monument/lantern/teahouse) is emitted as
 *    one `park-point` gid carrying `pointKind` (theme tints per kind; symbols in
 *    27-C).
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic + seeded harmonic blobs / low-freq warps;
 *    seeded only by `hashSeed(seed, salt, …)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property: the lawn is the ring itself (seed-independent); canopy
 *    clumps + path warps + rocks + trees + entrances key on ABSOLUTE world
 *    position (lattice anchor, boundary point, ring edge) or the region's
 *    `interiorPole` — so a ring vertex edit changes only boundary features +
 *    nearby dressing, while a re-roll re-places everything.
 *  - Containment: paths clip to the region (`clipPolylineToRegion`); points,
 *    canopy, pond, island, court, beds are verified vertex-by-vertex and
 *    shrunk/dropped if they do not fit.
 *  - Feature ids hash positions (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort stays stable.
 */
import { hashSeed, mulberry32 } from "./rng";
import { distanceToBoundary, insetRing, clipPolylineToRegion, type ProcgenRegion } from "./region";
import { q, harmonicBlobRing, blobFeature, spanQuad } from "./waterEmit";
import { indexFabricConstraints } from "./fabricConstraints";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const PARK_VARIETIES = ["formal-garden", "city-park", "wild-common", "japanese-garden"] as const;
export type ParkVariety = (typeof PARK_VARIETIES)[number];

/** Park params (plan 022 §3.3). `pathDensity` 0–1 scales the path web; `pond`
 * toggles the water anchor (japanese-garden always ponds; formal-garden always
 * gets its central basin — both are intrinsic to the composition). `variety`
 * drives layout AND is carried onto features for theme tinting. */
export interface ParkParams {
  variety: ParkVariety;
  pathDensity: number;
  pond: boolean;
}

const MIN_FEATURE_M = 22; // below this a loop/clump is too small to read
const MARGIN_M = 1; // mm-scale slack inside the containment bound
const TREE_CELL_M = 40; // scatter-tree stipple grid
const TREE_JITTER_FRAC = 0.3;
const CANOPY_CELL_M = 170; // canopy-clump anchor lattice (world meters)
const CANOPY_JITTER_FRAC = 0.28;
const ROAD_ENTRANCE_THRESH_M = 30; // a sketched road nearer than this to the ring = a gate
const ENTRANCE_DEDUPE_M = 25; // two entrances closer than this collapse to one
const MIN_ENTRANCE_EDGE_M = 18; // a ring edge shorter than this hosts no midpoint entrance
const ENTRANCE_MID_PROB = 0.55; // per-edge fallback-entrance inclusion probability (local, edit-safe)
const MAX_ENTRANCES = 6; // restraint cap (roads + fallbacks)

/** Per-variety layout profile (a pure lookup on the `variety` param — like the
 * city algorithm switching on `profile`; never reads a presetId). */
interface Layout {
  pathHalfM: number;
  scatterTrees: boolean; // stipple grid of trees (city)
  canopy: boolean; // harmonic-blob canopy clumps (the second green)
}

function layoutFor(v: ParkVariety): Layout {
  switch (v) {
    case "formal-garden":
      return { pathHalfM: 3.5, scatterTrees: false, canopy: false };
    case "city-park":
      return { pathHalfM: 3, scatterTrees: true, canopy: true };
    case "wild-common":
      return { pathHalfM: 2, scatterTrees: true, canopy: false };
    case "japanese-garden":
      return { pathHalfM: 1.6, scatterTrees: false, canopy: false };
  }
}

/** Signed position-hashed offset in [-amp, amp], keyed on integer indices. */
function jitter(seed: number, salt: string, ix: number, iy: number, amp: number): Pt {
  const rng = mulberry32(hashSeed(seed, salt, ix, iy));
  return [(rng() * 2 - 1) * amp, (rng() * 2 - 1) * amp];
}

/** A single [0,1) draw keyed on a salt + integer coordinates (position-hashed). */
function hash01(seed: number, salt: string, ...ks: number[]): number {
  return mulberry32(hashSeed(seed, salt, ...ks))();
}

/** Is every point within `r` of (x,y) inside the ring? True iff (x,y) is at
 * least `r` from the boundary — used to gate contained shapes/points. */
function clearOf(region: ProcgenRegion, x: number, y: number, r: number): boolean {
  return distanceToBoundary(region, x, y) >= r;
}

function ringContained(region: ProcgenRegion, ring: Pt[], margin: number): boolean {
  for (const [x, y] of ring) if (distanceToBoundary(region, x, y) < margin) return false;
  return true;
}

/** The open ring (closing vertex stripped). */
function openOf(ring: Pt[]): Pt[] {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring.slice();
}

interface Entrance {
  pt: Pt;
  arc: number; // arc-length position along the boundary, for ordering/pairing
}

/** Nearest point ON the ring boundary to (x,y): its coordinates + arc-length
 * position + distance. Closed-form per-segment projection, deterministic. */
function projectToRing(open: Pt[], perim: number[], x: number, y: number): { pt: Pt; arc: number; dist: number } {
  let best = { pt: [x, y] as Pt, arc: 0, dist: Infinity };
  const n = open.length;
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best.dist) best = { pt: [q(px), q(py)], arc: perim[i] + t * Math.hypot(dx, dy), dist: d };
  }
  return best;
}

/**
 * Boundary entrances (plan 027-B §2): where sketched roads meet the ring, plus
 * hashed edge-midpoint fallbacks, 2–`MAX_ENTRANCES` total. Sorted by arc
 * position. Each is derived from LOCAL geometry and hashed on absolute position
 * (edit-local); road entrances are always kept, midpoint fallbacks re-select on
 * a re-roll. Never throws; always returns ≥1 (a lone deepest edge) so callers
 * can pair up.
 */
function computeEntrances(seed: number, region: ProcgenRegion, roadLines: Pt[][]): Entrance[] {
  const open = openOf(region.ring);
  const n = open.length;
  if (n < 3) return [];
  // Cumulative arc-length at each vertex (perim[n] would be the full perimeter).
  const perim: number[] = [0];
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    perim.push(perim[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  const chosen: Entrance[] = [];
  const tryAdd = (e: Entrance): boolean => {
    for (const c of chosen) if (Math.hypot(c.pt[0] - e.pt[0], c.pt[1] - e.pt[1]) < ENTRANCE_DEDUPE_M) return false;
    chosen.push(e);
    return true;
  };

  // (1) Sketched-road entrances — the road vertex nearest the boundary, if it
  //     clears the threshold, projected onto the ring. Always kept (up to cap).
  for (const road of roadLines) {
    let best = { pt: [0, 0] as Pt, arc: 0, dist: Infinity };
    for (const [rx, ry] of road) {
      const pr = projectToRing(open, perim, rx, ry);
      if (pr.dist < best.dist) best = pr;
    }
    if (best.dist <= ROAD_ENTRANCE_THRESH_M) tryAdd({ pt: best.pt, arc: best.arc });
    if (chosen.length >= MAX_ENTRANCES) break;
  }

  // (2) Hashed edge-midpoint fallbacks — one candidate per ring edge, scored by
  //     a hash of the edge's ABSOLUTE endpoints. Inclusion is PER-EDGE LOCAL (a
  //     threshold on that edge's own score — no global sort), so moving a far
  //     vertex changes ONLY the two edges it touches; every other edge's
  //     entrance stays byte-identical. Roads (above), when present, ARE the
  //     entrances — the midpoints are a fallback for a park with none.
  const mids: { e: Entrance; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = open[i];
    const b = open[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < MIN_ENTRANCE_EDGE_M) continue;
    const mid: Pt = [q((a[0] + b[0]) / 2), q((a[1] + b[1]) / 2)];
    const score = hash01(seed, "park-entrance", Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]));
    mids.push({ e: { pt: mid, arc: perim[i] + len / 2 }, score });
  }
  if (chosen.length === 0) {
    for (const m of mids) if (m.score < ENTRANCE_MID_PROB) tryAdd(m.e);
  }
  // Floor (>=2) + cap (<=MAX): the ONLY non-local steps, and each fires rarely —
  // the floor only when a ring is too sparse for the local test to yield a pair,
  // the cap only when roads + dense fallbacks overflow. Both sort by score for
  // determinism; typical parks never reach either branch.
  if (chosen.length < 2) {
    const byScore = [...mids].sort((p, r) => p.score - r.score || p.e.arc - r.e.arc);
    for (const m of byScore) {
      if (chosen.length >= 2) break;
      tryAdd(m.e);
    }
  }
  chosen.sort((a, b) => a.arc - b.arc);
  return chosen.length > MAX_ENTRANCES ? chosen.slice(0, MAX_ENTRANCES) : chosen;
}

/** Vertex mean + covariance principal axis of the ring, in radians. The
 * longest-inertia direction (eigenvector of the larger eigenvalue). When the
 * ring is near-isotropic (a square) the axis is degenerate, so a hash picks 0
 * or π/2 deterministically — a tiny edit that breaks the symmetry then snaps
 * the axis to the genuinely longer dimension (stable under small edits). */
function principalAxis(seed: number, open: Pt[]): number {
  let mx = 0;
  let my = 0;
  for (const [x, y] of open) {
    mx += x;
    my += y;
  }
  mx /= open.length;
  my /= open.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of open) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Beds/axes center on the region's interiorPole, not this vertex-mean — only
  // the ANGLE is used (the axis orientation, stable under small edits).
  const iso = Math.abs(sxx - syy) < 1e-3 && Math.abs(sxy) < 1e-3;
  return iso ? (hash01(seed, "park-axis") < 0.5 ? 0 : Math.PI / 2) : 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

function rot(p: Pt, ang: number, ox: number, oy: number): Pt {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = p[0] - ox;
  const dy = p[1] - oy;
  return [ox + dx * c - dy * s, oy + dx * s + dy * c];
}

/**
 * Generate a park inside a sketched polygon region (plan 022 §3.3 / 027-A/-B).
 * `constraints.fabricFeatures` are consumed for the SKETCHED-road entrances
 * (plan 027-B §2 — sketched roads only; the park↔city-street continuity is
 * plan 024's cascade). All output is strictly inside `region.ring`.
 */
export function generatePark(
  seed: number,
  region: ProcgenRegion,
  params: ParkParams,
  constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { variety, pathDensity, pond } = params;
  const L = layoutFor(variety);
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  const [cx, cy] = region.interiorPole; // stable anchor (lattice argmax)
  const maxD = region.maxInteriorDistance;
  const roadLines = indexFabricConstraints(constraints.fabricFeatures).roadLines;
  const entrances = computeEntrances(seed, region, roadLines);

  // ── Emitters ────────────────────────────────────────────────────────────
  const emitLine = (run: Pt[], cls: string, extra: Record<string, unknown> = {}): void => {
    if (run.length < 2) return;
    const a = run[0];
    const b = run[run.length - 1];
    out.push({
      type: "Feature",
      id: hashSeed(seed, "park-path", q(a[0]), q(a[1]), q(b[0]), q(b[1]), run.length),
      geometry: { type: "LineString", coordinates: run.map((p) => [q(p[0]), q(p[1])]) },
      properties: { generatorId: "park-path", type: "park-path", parkType: variety, class: cls, halfWidthM: L.pathHalfM, ...extra },
    });
  };
  // Clip a polyline to the region and emit each contained run (endpoints on the
  // ring where the line crosses it — the entrance-connects contract).
  const emitClipped = (line: Pt[], cls: string, extra: Record<string, unknown> = {}): void => {
    for (const runRaw of clipPolylineToRegion(region, line)) emitLine(runRaw, cls, extra);
  };
  const emitPoint = (px: number, py: number, kind: string, salt: string, ...ks: number[]): void => {
    if (!clearOf(region, px, py, MARGIN_M)) return;
    out.push({
      type: "Feature",
      id: hashSeed(seed, salt, ...ks),
      geometry: { type: "Point", coordinates: [q(px), q(py)] },
      properties: { generatorId: "park-point", type: "park-point", parkType: variety, pointKind: kind },
    });
  };
  // A straight A→B resampled into small steps (so clipping drops near-rim parts).
  const straight = (a: Pt, b: Pt, step = 8): Pt[] => {
    const nSteps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    const pts: Pt[] = [];
    for (let i = 0; i <= nSteps; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / nSteps, a[1] + ((b[1] - a[1]) * i) / nSteps]);
    return pts;
  };
  // A curvilinear (Olmsted) path A→B: a straight baseline warped perpendicular
  // by two low-frequency sines whose phases hash on the endpoints; the warp
  // tapers to 0 at both ends (a sin envelope) so entrance endpoints stay on the
  // ring. Deterministic, edit-local (keyed on the two entrance positions).
  const warped = (a: Pt, b: Pt, amp: number): Pt[] => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) return [a, b];
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const rng = mulberry32(hashSeed(seed, "park-warp", q(a[0]), q(a[1]), q(b[0]), q(b[1])));
    const ph1 = rng() * Math.PI * 2;
    const ph2 = rng() * Math.PI * 2;
    // Bow toward the interior pole (deterministic) so a chord between two
    // boundary entrances always curves INTO the park — never outside a convex
    // ring (which would clip the diagonal away).
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const dir = nx * (cx - mid[0]) + ny * (cy - mid[1]) >= 0 ? 1 : -1;
    const steps = Math.max(8, Math.ceil(len / 16));
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(Math.PI * t); // 0 at both ends
      const w = dir * amp * env * (0.6 * Math.sin(t * Math.PI + ph1) + 0.4 * Math.sin(t * Math.PI * 2 + ph2));
      pts.push([a[0] + ux * len * t + nx * w, a[1] + uy * len * t + ny * w]);
    }
    return pts;
  };

  // ── Ground: ONE merged lawn polygon = the region ring. `meadow` for the
  //    wild-common (rougher tone), `formal` inverts figure-ground in themes. ──
  out.push(
    blobFeature(seed, "park-lawn", region.ring, {
      parkType: variety,
      formal: variety === "formal-garden",
      meadow: variety === "wild-common",
    })
  );

  // ── Canopy: the second green (city-park). Harmonic-blob clumps at hashed
  //    absolute-lattice anchors — sparse, contained by shrink-to-fit. ─────────
  if (L.canopy) {
    const cjit = CANOPY_CELL_M * CANOPY_JITTER_FRAC;
    const cix0 = Math.floor(bbox.minX / CANOPY_CELL_M) - 1;
    const cix1 = Math.ceil(bbox.maxX / CANOPY_CELL_M) + 1;
    const ciy0 = Math.floor(bbox.minY / CANOPY_CELL_M) - 1;
    const ciy1 = Math.ceil(bbox.maxY / CANOPY_CELL_M) + 1;
    for (let ix = cix0; ix <= cix1; ix++) {
      for (let iy = ciy0; iy <= ciy1; iy++) {
        if (hash01(seed, "park-canopy-place", ix, iy) >= 0.3) continue;
        const [dx, dy] = jitter(seed, "park-canopy-jit", ix, iy, cjit);
        const ax = (ix + 0.5) * CANOPY_CELL_M + dx;
        const ay = (iy + 0.5) * CANOPY_CELL_M + dy;
        if (pond && Math.hypot(ax - cx, ay - cy) < maxD * 0.42) continue; // off open water
        const salt = `park-canopy-${ix}-${iy}`;
        for (let base = CANOPY_CELL_M * 0.5; base >= MIN_FEATURE_M; base *= 0.78) {
          const ring = harmonicBlobRing(seed, salt, ax, ay, base, 0.35, 3, 40);
          if (ringContained(region, ring, MARGIN_M)) {
            out.push(blobFeature(seed, "park-canopy", ring, { parkType: variety }));
            break;
          }
        }
      }
    }
  }

  // ── Pond / basin footprint decided up front (paths route around it) ────────
  const wantPond = pond || variety === "japanese-garden" || variety === "formal-garden";
  let pondRing: Pt[] | null = null;
  // A formal basin is a small, near-circular central pool; other ponds are
  // larger, irregular. The wild-common duck pond sits OFF-centre (see below).
  if (wantPond && maxD >= 25 && variety !== "wild-common") {
    const irregular = variety === "formal-garden" ? 0.12 : 0.5;
    const startFrac = variety === "formal-garden" ? 0.3 : 0.45;
    for (let base = maxD * startFrac; base >= maxD * 0.12; base *= 0.8) {
      const ring = harmonicBlobRing(seed, "park-pond", cx, cy, base, irregular, 3, 48);
      if (ringContained(region, ring, MARGIN_M)) {
        pondRing = ring;
        break;
      }
    }
    if (pondRing) out.push(blobFeature(seed, "park-pond", pondRing, { parkType: variety }));
  }

  // ── Per-variety skeleton (plan 027-B §2) ───────────────────────────────────
  if (variety === "formal-garden") {
    buildFormal();
  } else if (variety === "city-park") {
    buildCityPark();
  } else if (variety === "wild-common") {
    buildWildCommon();
  } else {
    buildJapanese();
  }

  // ── formal-garden: principal-axis composition + mirror-symmetric beds ──────
  function buildFormal(): void {
    const open = openOf(region.ring);
    const angle = principalAxis(seed, open);
    const long: Pt = [Math.cos(angle), Math.sin(angle)];
    const cross: Pt = [-long[1], long[0]];
    const reach = maxD * 3; // longer than any chord; clipping trims to the ring
    // Dominant axis + cross-axis through the basin node (interiorPole).
    emitClipped(straight([cx - long[0] * reach, cy - long[1] * reach], [cx + long[0] * reach, cy + long[1] * reach]), "axis");
    emitClipped(straight([cx - cross[0] * reach, cy - cross[1] * reach], [cx + cross[0] * reach, cy + cross[1] * reach]), "axis");
    // Mirrored secondary axes parallel to the dominant axis, scaled by density.
    const arms = Math.round(pathDensity * 2); // 0..2 mirrored pairs
    for (let s = 1; s <= arms; s++) {
      const off = (maxD * s) / (arms + 1);
      for (const sign of [1, -1]) {
        const o: Pt = [cx + cross[0] * off * sign, cy + cross[1] * off * sign];
        emitClipped(straight([o[0] - long[0] * reach, o[1] - long[1] * reach], [o[0] + long[0] * reach, o[1] + long[1] * reach]), "axis");
      }
    }
    // Central fountain at the basin node.
    emitPoint(cx, cy, "fountain", "park-point-fountain", 0);
    // Mirror-symmetric compartments: place in the (rotated) axis frame at
    // symmetric ±cross offsets, at two radii, then rotate back. broderie beds
    // hug the basin end; bosquet quincunx tree-blocks sit in the outer cells.
    const bedHalf = Math.max(6, maxD * 0.1);
    const rings = 1 + Math.round(pathDensity); // 1..2 concentric rings of cells
    for (let r = 1; r <= rings; r++) {
      const alongOff = (maxD * 0.5 * r) / rings + bedHalf;
      const crossOff = maxD * 0.4;
      // Four mirror positions in the local (axis-aligned) frame.
      for (const sa of [1, -1]) {
        for (const sc of [1, -1]) {
          const local: Pt = [cx + long[0] * alongOff * sa + cross[0] * crossOff * sc, cy + long[1] * alongOff * sa + cross[1] * crossOff * sc];
          const isBroderie = r === 1; // inner ring = broderie parterres; outer = bosquets
          if (isBroderie) {
            // A bed square, axis-aligned (corners are the rotated local frame).
            const corners: Pt[] = [
              [-bedHalf, -bedHalf],
              [bedHalf, -bedHalf],
              [bedHalf, bedHalf],
              [-bedHalf, bedHalf],
              [-bedHalf, -bedHalf],
            ].map(([lx, ly]) => rot([local[0] + lx, local[1] + ly], angle, local[0], local[1]));
            if (ringContained(region, corners, MARGIN_M)) out.push(blobFeature(seed, "park-bed", corners, { parkType: variety, bedKind: "broderie" }));
          } else {
            // Bosquet: a quincunx (4 corners + centre) of trees.
            const spread = bedHalf * 0.7;
            const quincunx: Pt[] = [
              [0, 0],
              [-spread, -spread],
              [spread, -spread],
              [spread, spread],
              [-spread, spread],
            ];
            quincunx.forEach(([lx, ly], qi) => {
              const p = rot([local[0] + lx, local[1] + ly], angle, local[0], local[1]);
              emitTreeAt(p[0], p[1], "park-tree-bosquet", Math.round(local[0]), Math.round(local[1]), qi);
            });
          }
        }
      }
    }
  }

  // ── city-park: perimeter loop + curvilinear entrance-to-entrance diagonals ─
  function buildCityPark(): void {
    // Perimeter loop, inset from the ring (round line-joins smooth it in paint).
    const inset = Math.max(8, Math.min(60, maxD * 0.2));
    const loop = insetRing(region, inset);
    if (loop.length >= 4) emitLine(loop, "loop");
    else {
      // Concave fallback: a harmonic loop around the anchor (old 027-A path).
      const loopR = maxD * (0.62 - pathDensity * 0.12);
      if (loopR > MIN_FEATURE_M) emitLine(harmonicBlobRing(seed, "park-loop", cx, cy, loopR, 0.35, 2, 56), "loop");
    }
    // Curvilinear diagonals: connect each entrance to its ~opposite (crossing
    // the interior), plus neighbours when the park is dense.
    connectEntranceDiagonals(pathDensity > 0.5);
    // Bandstand near the anchor (a city-park focal point). emitPoint gates
    // containment; a touch off the pole so it does not sit dead-centre.
    emitPoint(cx + maxD * 0.12, cy - maxD * 0.12, "bandstand", "park-point-bandstand", 0);
  }

  // ── wild-common: restraint. Meadow + 1–2 desire lines + sparse edge trees +
  //    a duck pond + ONE landmark. ──────────────────────────────────────────
  function buildWildCommon(): void {
    connectEntranceDiagonals(false, 2); // at most 2 desire-line crossings
    // Duck pond: small, irregular, OFF-centre (deterministic offset from pole).
    if (maxD >= 25) {
      const orng = mulberry32(hashSeed(seed, "park-duckpond"));
      const oth = orng() * Math.PI * 2;
      const orad = maxD * 0.35;
      const px = cx + Math.cos(oth) * orad;
      const py = cy + Math.sin(oth) * orad;
      for (let base = maxD * 0.22; base >= MIN_FEATURE_M * 0.6; base *= 0.8) {
        const ring = harmonicBlobRing(seed, "park-pond", px, py, base, 0.55, 3, 40);
        if (ringContained(region, ring, MARGIN_M)) {
          pondRing = ring;
          out.push(blobFeature(seed, "park-pond", ring, { parkType: variety }));
          break;
        }
      }
    }
    // ONE landmark (monument/maypole) near the pole.
    emitPoint(cx, cy, "monument", "park-point-monument", 0);
  }

  // ── japanese-garden: winding circuit + island/bridge + lanterns + rocks +
  //    teahouse/roji + karesansui court. ──────────────────────────────────────
  function buildJapanese(): void {
    // Circuit: a single winding loop around the pond (miegakure — strong warp),
    // at a hashed offset so no single side reveals the whole pond.
    const circuitR = maxD * (0.6 - pathDensity * 0.1);
    let circuit: Pt[] = [];
    if (circuitR > MIN_FEATURE_M) {
      circuit = harmonicBlobRing(seed, "park-circuit", cx, cy, circuitR, 0.8, 4, 56);
      // Emit only the contained portion (a concave ring can clip the circuit).
      if (ringContained(region, circuit, MARGIN_M)) emitLine(circuit, "circuit");
      else {
        emitClipped(circuit, "circuit");
      }
    }
    // Island + bridges (graceful degradation: island only on a large region).
    if (pondRing && maxD >= 130) {
      const islandBase = maxD * 0.14;
      const island = harmonicBlobRing(seed, "park-island", cx, cy, islandBase, 0.4, 3, 40);
      if (ringContained(region, island, MARGIN_M)) {
        out.push(blobFeature(seed, "park-island", island, { parkType: variety }));
        const brng = mulberry32(hashSeed(seed, "park-bridge-count"));
        const nBridges = 1 + (brng() < 0.5 ? 0 : 1);
        for (let bI = 0; bI < nBridges; bI++) {
          const theta = (bI / nBridges) * Math.PI * 2 + brng() * 0.7;
          const inner: Pt = [cx + Math.cos(theta) * islandBase * 1.05, cy + Math.sin(theta) * islandBase * 1.05];
          const outer: Pt = [cx + Math.cos(theta) * maxD * 0.42, cy + Math.sin(theta) * maxD * 0.42];
          if (clearOf(region, outer[0], outer[1], L.pathHalfM + MARGIN_M)) {
            out.push(spanQuad(seed, "park-bridge", inner, outer, Math.max(1.4, L.pathHalfM), { parkType: variety, style: "arch" }));
          }
        }
      }
    }
    // Lanterns at circuit inflections (a few sampled points) + 2 water-edge.
    if (circuit.length > 8) {
      for (let k = 0; k < 4; k++) {
        const idx = Math.floor((k / 4) * (circuit.length - 1));
        const p = circuit[idx];
        emitPoint(p[0], p[1], "lantern", "park-point-lantern", k);
      }
    }
    if (pondRing) {
      for (let k = 0; k < 2; k++) {
        const th = (k / 2) * Math.PI * 2 + hash01(seed, "park-lantern-water", k) * 0.8;
        const rr = maxD * 0.36;
        emitPoint(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, "lantern", "park-point-lantern-water", k);
      }
    }
    // Rocks: odd-count (3/5/3) horizontal-dominant groups at circuit viewpoints.
    if (pondRing) {
      const clusterSizes = [3, 5, 3];
      for (let cI = 0; cI < clusterSizes.length; cI++) {
        const crng = mulberry32(hashSeed(seed, "park-rock-cluster", cI));
        const theta = (cI / clusterSizes.length) * Math.PI * 2 + crng() * 1.0;
        const rad = maxD * (0.5 + crng() * 0.12);
        const gx = cx + Math.cos(theta) * rad;
        const gy = cy + Math.sin(theta) * rad;
        if (!clearOf(region, gx, gy, 4)) continue;
        const count = clusterSizes[cI];
        for (let r = 0; r < count; r++) {
          const [dx, dy] = jitter(seed, "park-rock-jit", cI, r, 3.5);
          const px = gx + dx;
          const py = gy + dy;
          if (!clearOf(region, px, py, MARGIN_M)) continue;
          // Horizontal-dominant: sizeN wider than tall (Sakuteiki), for 27-C paint.
          out.push({
            type: "Feature",
            id: hashSeed(seed, "park-rock", cI, r),
            geometry: { type: "Point", coordinates: [q(px), q(py)] },
            properties: { generatorId: "park-rock", type: "park-rock", parkType: variety, sizeW: 1.6, sizeH: 1 },
          });
        }
      }
    }
    // Teahouse + roji stepping-stone spur (short, its own dashed `roji` class).
    if (maxD >= 80) {
      const trng = mulberry32(hashSeed(seed, "park-teahouse"));
      const tth = trng() * Math.PI * 2;
      const trad = maxD * 0.6;
      const tx = cx + Math.cos(tth) * trad;
      const ty = cy + Math.sin(tth) * trad;
      if (clearOf(region, tx, ty, MARGIN_M)) {
        emitPoint(tx, ty, "teahouse", "park-point-teahouse", 0);
        // Roji spur toward the circuit (a short walk inward).
        const spurEnd: Pt = [cx + Math.cos(tth) * maxD * 0.42, cy + Math.sin(tth) * maxD * 0.42];
        emitClipped(warped([tx, ty], spurEnd, maxD * 0.05), "roji");
      }
    }
    // Specimen trees at circuit viewpoints (framing the strolling views) —
    // placed individually at deterministic angles, never in rows.
    const nSpecimen = 6;
    for (let sI = 0; sI < nSpecimen; sI++) {
      const srng = mulberry32(hashSeed(seed, "park-specimen", sI));
      const theta = (sI / nSpecimen) * Math.PI * 2 + srng() * 0.9;
      const rad = maxD * (0.55 + srng() * 0.18);
      emitTreeAt(cx + Math.cos(theta) * rad, cy + Math.sin(theta) * rad, "park-tree", sI, Math.round(rad));
    }
    // Karesansui gravel court (large regions only — top of the ladder).
    if (maxD >= 200) {
      const half = maxD * 0.16;
      const ex = cx + maxD * 0.5;
      const ey = cy - maxD * 0.5;
      const court: Pt[] = [
        [ex - half, ey - half],
        [ex + half, ey - half],
        [ex + half, ey + half],
        [ex - half, ey + half],
        [ex - half, ey - half],
      ];
      if (ringContained(region, court, MARGIN_M)) out.push(blobFeature(seed, "park-court", court, { parkType: variety }));
    }
  }

  // Connect entrances with curvilinear diagonals (city + wild). `withNeighbors`
  // also links adjacent entrances; `maxLines` caps the total (wild restraint).
  function connectEntranceDiagonals(withNeighbors: boolean, maxLines = 99): void {
    const m = entrances.length;
    if (m < 2) return;
    const done = new Set<string>();
    let emitted = 0;
    const link = (i: number, j: number): void => {
      if (emitted >= maxLines || i === j) return;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (done.has(key)) return;
      done.add(key);
      const a = entrances[i].pt;
      const b = entrances[j].pt;
      const amp = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.12, maxD * 0.28);
      emitClipped(warped(a, b, amp), "walk");
      emitted++;
    };
    // Each entrance to its ~opposite (crossing the interior → a legible web).
    for (let i = 0; i < m; i++) link(i, (i + Math.floor(m / 2)) % m);
    if (withNeighbors) for (let i = 0; i < m; i++) link(i, (i + 1) % m);
  }

  // Emit a tree point at (px,py) with a stable position-hashed id.
  function emitTreeAt(px: number, py: number, salt: string, ...ks: number[]): void {
    if (!clearOf(region, px, py, MARGIN_M)) return;
    out.push({
      type: "Feature",
      id: hashSeed(seed, salt, ...ks),
      geometry: { type: "Point", coordinates: [q(px), q(py)] },
      properties: { generatorId: "park-tree", type: "park-tree", parkType: variety },
    });
  }

  // ── Trees: scatter stipple (city full-area; wild sparse toward the edges) ──
  if (L.scatterTrees) {
    const treeJit = TREE_CELL_M * TREE_JITTER_FRAC;
    const tx0 = Math.floor(bbox.minX / TREE_CELL_M) - 1;
    const tx1 = Math.ceil(bbox.maxX / TREE_CELL_M) + 1;
    const ty0 = Math.floor(bbox.minY / TREE_CELL_M) - 1;
    const ty1 = Math.ceil(bbox.maxY / TREE_CELL_M) + 1;
    for (let ix = tx0; ix <= tx1; ix++) {
      for (let iy = ty0; iy <= ty1; iy++) {
        const [dx, dy] = jitter(seed, "park-tree-jit", ix, iy, treeJit);
        const px = (ix + 0.5) * TREE_CELL_M + dx;
        const py = (iy + 0.5) * TREE_CELL_M + dy;
        if (!clearOf(region, px, py, MARGIN_M)) continue;
        // wild-common: sparse AND biased to the edges (an open meadow centre).
        if (variety === "wild-common") {
          if (distanceToBoundary(region, px, py) > maxD * 0.55) continue; // keep the middle open
          if (hash01(seed, "park-tree-place", ix, iy) >= 0.35) continue;
        } else {
          if (hash01(seed, "park-tree-place", ix, iy) >= 0.28) continue;
        }
        if (pondRing && Math.hypot(px - cx, py - cy) < maxD * 0.42) continue; // off the water
        emitTreeAt(px, py, "park-tree", ix, iy);
      }
    }
  }

  return out;
}

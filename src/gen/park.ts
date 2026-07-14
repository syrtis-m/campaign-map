/**
 * Park generator (plan 022 §3.3, reshaped by plan 027-A). Pure/headless (no
 * DOM/map/Obsidian imports; reads only its arguments, D6): a sketched `park`
 * polygon is the region; this fills it with a ground fabric, lays a path web,
 * and dresses it per `variety` — everything strictly inside the ring.
 *
 * Four varieties (params, never presetId — mirrors the city algorithm's
 * `profile` branch): `formal-garden` (axial paths + symmetric beds),
 * `city-park` (curved loop + lawns + canopy clumps + optional pond),
 * `wild-common` (sparse paths + scattered trees), `japanese-garden` (a
 * deliberately asymmetric strolling garden: winding single-track circuit, an
 * irregular pond anchor with an island + short bridges, deterministic rock
 * groupings, specimen trees at viewpoints, and an optional raked-gravel
 * `karesansui` court; small regions degrade gracefully — drop court → drop
 * island → pond only).
 *
 * Plan 027-A figure-ground rewrite (fixes the "green square with graph-paper
 * texture" defect diagnosed against review/v4.7-park-*.png):
 *  - GROUND is ONE `park-lawn` polygon = the region ring (replaces the jittered
 *    22 m cell lattice entirely — the lattice was the source of the antialiasing
 *    hairline grid). A single merged polygon has no interior seams.
 *  - CANOPY (the second green — lawn vs wooded blocks, the #1 legibility fix)
 *    is a set of `park-canopy` harmonic-blob clumps at hashed absolute-lattice
 *    anchors (city-park). Keyed on absolute world position like the trees, so a
 *    far-vertex edit leaves interior clumps byte-identical while a re-roll
 *    replaces them; contained by shrink-to-fit. (Phase C upgrades these to
 *    domain-warped marching squares + a real polygon union.)
 *  - PATHS are `park-path` LINESTRINGS carrying a `class` (`axis`/`loop`/
 *    `circuit`/`walk`) — same centerlines as before, re-emitted as polylines so
 *    the theme can render a casing line under a lighter fill line (round joins
 *    fix the old notch problem for free). Replaces the hairline span quads.
 *
 * Determinism argument (procgen_v3_design.md §4):
 *  - D4/D6: closed-form arithmetic + seeded harmonic blobs; seeded only by
 *    `hashSeed(seed, salt, …)`.
 *  - D5: every emitted coordinate is mm-quantized before it leaves.
 *  - Identity property: the lawn is the ring itself (seed-independent); canopy
 *    clumps + path banks + rocks + trees key on ABSOLUTE world position (canopy
 *    lattice anchor, path centreline point, tree lattice cell) or the region's
 *    `interiorPole` (a lattice argmax stable under a far vertex edit) — so a ring
 *    vertex edit changes only boundary features + nearby dressing, while a
 *    re-roll (new seed) re-places everything (measured in the gate: edit overlap
 *    ≫ re-roll overlap on the tree scatter, now that the lawn is seed-invariant).
 *  - Containment: a path LineString emits only the contiguous runs whose every
 *    vertex clears (halfWidth + margin) of the boundary, so its ±halfWidth banks
 *    stay inside; canopy/pond/island/court are verified vertex-by-vertex and
 *    shrunk/dropped if they do not fit.
 *  - Feature ids hash positions (never emission order), integers so
 *    `clipNetworkToTile`'s `Number(id)` sort stays stable.
 */
import { hashSeed, mulberry32 } from "./rng";
import { distanceToBoundary, type ProcgenRegion } from "./region";
import { q, harmonicBlobRing, blobFeature, spanQuad } from "./waterEmit";
import type { GenerationConstraints } from "./types";

type Pt = [number, number];

export const PARK_VARIETIES = ["formal-garden", "city-park", "wild-common", "japanese-garden"] as const;
export type ParkVariety = (typeof PARK_VARIETIES)[number];

/** Park params (plan 022 §3.3). `pathDensity` 0–1 scales the path web; `pond`
 * toggles the water anchor (japanese-garden always ponds — see below). `variety`
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

/** Per-variety layout profile (a pure lookup on the `variety` param — like the
 * city algorithm switching on `profile`; never reads a presetId). */
interface Layout {
  pathHalfM: number;
  pathClass: string; // "axis" | "loop" | "circuit" | "walk"
  scatterTrees: boolean; // stipple grid of trees (wild/city)
  canopy: boolean; // harmonic-blob canopy clumps (the second green)
  formalCross: boolean; // axial cross + symmetric rectangle beds
  loop: boolean; // a curved/winding ring path
  loopLobes: number;
  loopIrregularity: number;
}

function layoutFor(v: ParkVariety): Layout {
  switch (v) {
    case "formal-garden":
      return { pathHalfM: 3.5, pathClass: "axis", scatterTrees: false, canopy: false, formalCross: true, loop: false, loopLobes: 0, loopIrregularity: 0 };
    case "city-park":
      return { pathHalfM: 3, pathClass: "loop", scatterTrees: true, canopy: true, formalCross: false, loop: true, loopLobes: 2, loopIrregularity: 0.35 };
    case "wild-common":
      return { pathHalfM: 2, pathClass: "walk", scatterTrees: true, canopy: false, formalCross: false, loop: true, loopLobes: 2, loopIrregularity: 0.6 };
    case "japanese-garden":
      return { pathHalfM: 1.6, pathClass: "circuit", scatterTrees: false, canopy: false, formalCross: false, loop: true, loopLobes: 4, loopIrregularity: 0.8 };
  }
}

/** Signed position-hashed offset in [-amp, amp], keyed on integer indices. */
function jitter(seed: number, salt: string, ix: number, iy: number, amp: number): Pt {
  const rng = mulberry32(hashSeed(seed, salt, ix, iy));
  return [(rng() * 2 - 1) * amp, (rng() * 2 - 1) * amp];
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

/**
 * Generate a park inside a sketched polygon region (plan 022 §3.3 / 027-A).
 * Emits the ground (`park-lawn` = the region ring), canopy clumps
 * (`park-canopy`), a `park-path` LineString web (classed), formal `park-bed`
 * rectangles, per-variety water (`park-pond`/`park-island`/`park-bridge`),
 * `park-court` gravel, `park-rock` points and `park-tree` points — all strictly
 * inside `region.ring`. `constraints` accepted for signature parity, not
 * consumed in v1 (the park→city interaction is plan 024's cascade).
 */
export function generatePark(
  seed: number,
  region: ProcgenRegion,
  params: ParkParams,
  _constraints: GenerationConstraints
): GeoJSON.Feature[] {
  const { variety, pathDensity, pond } = params;
  const L = layoutFor(variety);
  const out: GeoJSON.Feature[] = [];
  const bbox = region.bbox;
  const [cx, cy] = region.interiorPole; // stable anchor (lattice argmax)
  const maxD = region.maxInteriorDistance;

  // ── Ground: ONE merged lawn polygon = the region ring (no lattice, no seams).
  //    The lawn is seed-independent (it IS the sketched shape) — edit-locality
  //    now lives on the seed-driven canopy/tree scatter, not the ground. ───────
  out.push(blobFeature(seed, "park-lawn", region.ring, { parkType: variety, formal: variety === "formal-garden" }));

  // ── Canopy: the second green (lawn vs wooded blocks). Harmonic-blob clumps at
  //    hashed absolute-lattice anchors — sparse, contained by shrink-to-fit.
  //    (Phase C: domain-warped marching squares + real union.) ─────────────────
  if (L.canopy) {
    const cjit = CANOPY_CELL_M * CANOPY_JITTER_FRAC;
    const cix0 = Math.floor(bbox.minX / CANOPY_CELL_M) - 1;
    const cix1 = Math.ceil(bbox.maxX / CANOPY_CELL_M) + 1;
    const ciy0 = Math.floor(bbox.minY / CANOPY_CELL_M) - 1;
    const ciy1 = Math.ceil(bbox.maxY / CANOPY_CELL_M) + 1;
    for (let ix = cix0; ix <= cix1; ix++) {
      for (let iy = ciy0; iy <= ciy1; iy++) {
        // ~30% of cells host a clump — a handful in a large park, none in a small.
        if (mulberry32(hashSeed(seed, "park-canopy-place", ix, iy))() >= 0.3) continue;
        const [dx, dy] = jitter(seed, "park-canopy-jit", ix, iy, cjit);
        const ax = (ix + 0.5) * CANOPY_CELL_M + dx;
        const ay = (iy + 0.5) * CANOPY_CELL_M + dy;
        // Keep canopy off open water.
        if ((pond || variety === "japanese-garden") && Math.hypot(ax - cx, ay - cy) < maxD * 0.42) continue;
        // Largest clump that fits (shrink until every vertex clears the ring).
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

  // ── Path web: LineStrings carrying a `class` (theme renders casing + fill). ──
  const emitPathLine = (line: Pt[], cls: string): void => {
    const hw = L.pathHalfM;
    let run: Pt[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        const a = run[0];
        const b = run[run.length - 1];
        out.push({
          type: "Feature",
          id: hashSeed(seed, "park-path", q(a[0]), q(a[1]), q(b[0]), q(b[1]), run.length),
          geometry: { type: "LineString", coordinates: run.map((p) => [q(p[0]), q(p[1])]) },
          properties: { generatorId: "park-path", type: "park-path", parkType: variety, class: cls, halfWidthM: hw },
        });
      }
      run = [];
    };
    for (const p of line) {
      if (clearOf(region, p[0], p[1], hw + MARGIN_M)) run.push(p);
      else flush();
    }
    flush();
  };
  // Resample a straight segment into small steps (so near-rim parts drop cleanly).
  const straight = (a: Pt, b: Pt, step = 8): Pt[] => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
    return pts;
  };

  if (L.formalCross) {
    // Axial cross through the anchor + optional secondary axes by pathDensity.
    emitPathLine(straight([bbox.minX, cy], [bbox.maxX, cy]), "axis");
    emitPathLine(straight([cx, bbox.minY], [cx, bbox.maxY]), "axis");
    const arms = Math.round(pathDensity * 2); // 0..2 mirrored secondary axes
    for (let s = 1; s <= arms; s++) {
      const off = (maxD * s) / (arms + 1);
      emitPathLine(straight([bbox.minX, cy + off], [bbox.maxX, cy + off]), "axis");
      emitPathLine(straight([bbox.minX, cy - off], [bbox.maxX, cy - off]), "axis");
    }
  }
  if (L.formalCross) {
    // Symmetric rectangular beds flanking the axes — the signature of a formal
    // garden. Mirrored in all four quadrants at two radii scaled by pathDensity.
    const bedHalf = Math.max(6, maxD * 0.1);
    const rings = 1 + Math.round(pathDensity); // 1..2 concentric bed rings
    for (let r = 1; r <= rings; r++) {
      const off = (maxD * 0.55 * r) / rings + bedHalf;
      const centres: Pt[] = [
        [cx + off, cy + off], [cx - off, cy + off], [cx + off, cy - off], [cx - off, cy - off],
      ];
      for (const [bx, by] of centres) {
        const bed: Pt[] = [
          [bx - bedHalf, by - bedHalf],
          [bx + bedHalf, by - bedHalf],
          [bx + bedHalf, by + bedHalf],
          [bx - bedHalf, by + bedHalf],
          [bx - bedHalf, by - bedHalf],
        ];
        if (ringContained(region, bed, MARGIN_M)) out.push(blobFeature(seed, "park-bed", bed, { parkType: variety, bedKind: "border" }));
      }
    }
  }
  if (L.loop) {
    // A curved (city) / winding (japanese) ring path around the anchor. Radius
    // shrinks a touch with pathDensity so a denser park reads busier inside.
    const loopR = maxD * (0.62 - pathDensity * 0.12);
    if (loopR > MIN_FEATURE_M) {
      const loop = harmonicBlobRing(seed, "park-loop", cx, cy, loopR, L.loopIrregularity, L.loopLobes, 56);
      emitPathLine(loop, L.pathClass);
      // A connecting spoke (city/wild) so the loop is reachable from the centre.
      if (!L.formalCross) emitPathLine(straight([cx, cy], loop[Math.floor(loop.length / 4)]), "walk");
    }
  }

  // ── Pond + island + bridges (city-park option / japanese anchor) ──────────
  const wantPond = pond || variety === "japanese-garden";
  let pondRing: Pt[] | null = null;
  if (wantPond && maxD >= 25) {
    // Largest blob that fits: shrink until every vertex clears the boundary.
    for (let base = maxD * 0.45; base >= maxD * 0.15; base *= 0.8) {
      const ring = harmonicBlobRing(seed, "park-pond", cx, cy, base, 0.5, 3, 48);
      if (ringContained(region, ring, MARGIN_M)) {
        pondRing = ring;
        break;
      }
    }
    if (pondRing) {
      out.push(blobFeature(seed, "park-pond", pondRing, { parkType: variety }));
      // Island: only when the region is large enough (graceful degradation —
      // the ladder is court(≥200) → island(≥130) → pond(≥25) → pond-only, in
      // maxInteriorDistance meters ≈ half the shorter span of the region).
      if (variety === "japanese-garden" && maxD >= 130) {
        const islandBase = maxD * 0.14;
        const island = harmonicBlobRing(seed, "park-island", cx, cy, islandBase, 0.4, 3, 40);
        if (ringContained(region, island, MARGIN_M)) {
          out.push(blobFeature(seed, "park-island", island, { parkType: variety }));
          // 1–2 short bridges from the pond rim toward the island (deterministic
          // angles). Reuses the shared span emitter at pond scale.
          const brng = mulberry32(hashSeed(seed, "park-bridge-count"));
          const nBridges = 1 + (brng() < 0.5 ? 0 : 1);
          for (let bI = 0; bI < nBridges; bI++) {
            const theta = (bI / nBridges) * Math.PI * 2 + brng() * 0.7;
            const inner: Pt = [cx + Math.cos(theta) * islandBase * 1.05, cy + Math.sin(theta) * islandBase * 1.05];
            const outer: Pt = [cx + Math.cos(theta) * maxD * 0.42, cy + Math.sin(theta) * maxD * 0.42];
            if (clearOf(region, outer[0], outer[1], L.pathHalfM + MARGIN_M)) {
              out.push(spanQuad(seed, "park-bridge", inner, outer, Math.max(1.4, L.pathHalfM), { parkType: variety }));
            }
          }
        }
      }
    }
  }

  // ── Rocks (japanese): deterministic 2–3–5 clusters weighted to the pond edge ─
  if (variety === "japanese-garden" && pondRing) {
    const clusterSizes = [2, 3, 5];
    const nClusters = 3;
    for (let cI = 0; cI < nClusters; cI++) {
      const crng = mulberry32(hashSeed(seed, "park-rock-cluster", cI));
      const theta = (cI / nClusters) * Math.PI * 2 + crng() * 1.0;
      const rad = maxD * (0.5 + crng() * 0.12); // just outside the pond rim
      const gx = cx + Math.cos(theta) * rad;
      const gy = cy + Math.sin(theta) * rad;
      if (!clearOf(region, gx, gy, 4)) continue;
      const count = clusterSizes[cI % clusterSizes.length];
      for (let r = 0; r < count; r++) {
        const [dx, dy] = jitter(seed, "park-rock-jit", cI, r, 3.5);
        const px = gx + dx;
        const py = gy + dy;
        if (!clearOf(region, px, py, MARGIN_M)) continue;
        out.push({
          type: "Feature",
          id: hashSeed(seed, "park-rock", cI, r),
          geometry: { type: "Point", coordinates: [q(px), q(py)] },
          properties: { generatorId: "park-rock", type: "park-rock", parkType: variety },
        });
      }
    }
  }

  // ── Karesansui gravel court (japanese, large regions only) ─────────────────
  // Top rung of the degradation ladder — needs the most room (court → island →
  // pond). A gravel court reads only in a genuinely large garden.
  if (variety === "japanese-garden" && maxD >= 200) {
    // One rectangle near an "entrance": offset from the anchor toward +x/+y.
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
    if (ringContained(region, court, MARGIN_M)) {
      out.push(blobFeature(seed, "park-court", court, { parkType: variety }));
    }
  }

  // ── Trees: scatter stipple (wild/city), formal rows, or specimen (japanese) ─
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
        // Wild commons read denser than a manicured city park.
        const chance = variety === "wild-common" ? 0.55 : 0.28;
        if (mulberry32(hashSeed(seed, "park-tree-place", ix, iy))() >= chance) continue;
        // Keep trees out of the pond footprint.
        if (pondRing && Math.hypot(px - cx, py - cy) < maxD * 0.42) continue;
        out.push({
          type: "Feature",
          id: hashSeed(seed, "park-tree", ix, iy),
          geometry: { type: "Point", coordinates: [q(px), q(py)] },
          properties: { generatorId: "park-tree", type: "park-tree", parkType: variety },
        });
      }
    }
  } else if (L.formalCross) {
    // Formal rows: evenly spaced trees flanking the two main axes (symmetry).
    const spacing = Math.max(18, maxD / 4);
    const flank = L.pathHalfM + 4;
    for (let d = spacing; d < maxD; d += spacing) {
      const places: Pt[] = [
        [cx + d, cy + flank], [cx + d, cy - flank], [cx - d, cy + flank], [cx - d, cy - flank],
        [cx + flank, cy + d], [cx - flank, cy + d], [cx + flank, cy - d], [cx - flank, cy - d],
      ];
      for (let pI = 0; pI < places.length; pI++) {
        const [px, py] = places[pI];
        if (!clearOf(region, px, py, MARGIN_M)) continue;
        out.push({
          type: "Feature",
          id: hashSeed(seed, "park-tree", Math.round(px), Math.round(py)),
          geometry: { type: "Point", coordinates: [q(px), q(py)] },
          properties: { generatorId: "park-tree", type: "park-tree", parkType: variety },
        });
      }
    }
  } else if (variety === "japanese-garden") {
    // Specimen trees placed individually at viewpoints around the pond/loop
    // (deterministic angles), never in rows.
    const nSpecimen = 6;
    for (let sI = 0; sI < nSpecimen; sI++) {
      const srng = mulberry32(hashSeed(seed, "park-specimen", sI));
      const theta = (sI / nSpecimen) * Math.PI * 2 + srng() * 0.9;
      const rad = maxD * (0.55 + srng() * 0.18);
      const px = cx + Math.cos(theta) * rad;
      const py = cy + Math.sin(theta) * rad;
      if (!clearOf(region, px, py, MARGIN_M)) continue;
      out.push({
        type: "Feature",
        id: hashSeed(seed, "park-tree", sI, Math.round(rad)),
        geometry: { type: "Point", coordinates: [q(px), q(py)] },
        properties: { generatorId: "park-tree", type: "park-tree", parkType: variety },
      });
    }
  }

  return out;
}

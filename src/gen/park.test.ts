import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generatePark, type ParkParams } from "./park";
import { makeRegion, distanceToBoundary, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import type { FabricFeature } from "../model/fabric";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A 1000 m square park region in gen-space meters (large ⇒ every japanese
 * element fits: pond + island + rocks + court). */
const SQUARE: Pt[] = [
  [0, 0],
  [1000, 0],
  [1000, 1000],
  [0, 1000],
  [0, 0],
];

// L-shape (concave) for containment stress: 900×900 minus the NE 450×450.
const L_SHAPE: Pt[] = [
  [0, 0],
  [900, 0],
  [900, 450],
  [450, 450],
  [450, 900],
  [0, 900],
  [0, 0],
];

const PARAMS = (o: Partial<ParkParams> = {}): ParkParams => ({
  variety: "city-park",
  pathDensity: 0.5,
  pond: true,
  ...o,
});

function regionFor(ring: Pt[]): ProcgenRegion {
  return makeRegion("park-test", ring);
}

function allCoords(feats: GeoJSON.Feature[]): Pt[] {
  const out: Pt[] = [];
  const scan = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      out.push([c[0], c[1]]);
      return;
    }
    for (const x of c) scan(x);
  };
  for (const f of feats) scan((f.geometry as { coordinates: unknown }).coordinates);
  return out;
}

/** Coordinate buckets for a single generatorId — the locality measure (a fine
 * grid so the seed-driven placement jitter registers under a re-roll). Since
 * 027-A the lawn is ONE polygon = the region ring (seed-independent), so
 * edit-locality is now measured on the seed-driven `park-tree` scatter (a
 * far-vertex edit leaves interior trees identical; a re-roll re-places all). */
function bucketsFor(feats: GeoJSON.Feature[], gid: string, grid: number): Set<string> {
  const s = new Set<string>();
  for (const f of feats) {
    if ((f.properties as { generatorId?: string }).generatorId !== gid) continue;
    for (const [x, y] of allCoords([f])) s.add(`${Math.round(x / grid)},${Math.round(y / grid)}`);
  }
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

function typeCount(feats: GeoJSON.Feature[], type: string): number {
  return feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === type).length;
}

/** Hash + per-type counts (the 022 golden tripwire idiom): any numeric drift
 * flips the sha256. */
function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.generatorId);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

describe("park generator — determinism", () => {
  it("matches the seeded snapshot fixture (japanese garden — golden drift tripwire)", () => {
    const p = PARAMS({ variety: "japanese-garden", pathDensity: 0.4, pond: true });
    expect(digest(generatePark(4242, regionFor(SQUARE), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(SQUARE);
    const a = generatePark(1234, region, PARAMS(), CONSTRAINTS);
    const b = generatePark(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const feats = generatePark(7, regionFor(SQUARE), PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });

  it("japanese-garden emits ground, path, pond, island, bridge, rock and court", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    expect(typeCount(feats, "park-lawn")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-path")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-pond")).toBe(1);
    expect(typeCount(feats, "park-island")).toBe(1);
    expect(typeCount(feats, "park-bridge")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-rock")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-court")).toBe(1);
  });

  it("formal-garden emits axial paths + mirror beds + bosquet trees + a central basin (plan 027-B §2)", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "formal-garden", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-path")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-bed")).toBeGreaterThan(0);
    expect(typeCount(feats, "park-tree")).toBeGreaterThan(0); // bosquet quincunx blocks
    // 027-B: the central basin is INTRINSIC to a formal garden (Versailles
    // Grande Perspective) — size-gated, NOT pond-param-gated, so it appears even
    // at pond=false. Deliberate change from 027-A's "formal has no pond".
    expect(typeCount(feats, "park-pond")).toBe(1);
    expect(typeCount(feats, "park-point")).toBeGreaterThan(0); // the fountain in the basin
  });
});

describe("park generator — containment (every coordinate inside the ring)", () => {
  for (const preset of [
    { name: "formal-garden", p: PARAMS({ variety: "formal-garden", pond: false }) },
    { name: "city-park", p: PARAMS({ variety: "city-park", pond: true }) },
    { name: "wild-common", p: PARAMS({ variety: "wild-common", pond: false }) },
    { name: "japanese-garden", p: PARAMS({ variety: "japanese-garden", pond: true }) },
  ]) {
    it(`all output inside the ring — ${preset.name}`, () => {
      const region = regionFor(SQUARE);
      const feats = generatePark(99, region, preset.p, CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
      }
    });
  }

  it("stays inside a strongly concave (L-shaped) region", () => {
    const region = regionFor(L_SHAPE);
    const feats = generatePark(42, region, PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const [x, y] of allCoords(feats)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("park generator — identity / edit locality", () => {
  it("a single vertex edit changes the tree scatter far less than a re-roll", () => {
    // city-park (PARAMS default) scatters trees on an ABSOLUTE-world lattice —
    // the seed-driven signal that carries edit-locality now that the lawn is the
    // (seed-independent) ring itself.
    const base = bucketsFor(generatePark(50, regionFor(SQUARE), PARAMS(), CONSTRAINTS), "park-tree", 20);

    // Move ONE corner outward — only trees near it change containment.
    const moved: Pt[] = [
      [0, 0],
      [1080, 0],
      [1000, 1000],
      [0, 1000],
      [0, 0],
    ];
    const movedBuckets = bucketsFor(generatePark(50, regionFor(moved), PARAMS(), CONSTRAINTS), "park-tree", 20);

    // Re-roll: a new seed re-places the whole tree scatter.
    const rerolled = bucketsFor(generatePark(51, regionFor(SQUARE), PARAMS(), CONSTRAINTS), "park-tree", 20);

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    expect(base.size).toBeGreaterThan(0);
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(80);
  });
});

describe("park generator — 027-A figure-ground topology", () => {
  it("emits exactly ONE merged lawn polygon per park (no per-cell lattice)", () => {
    for (const v of ["formal-garden", "city-park", "wild-common", "japanese-garden"] as const) {
      const feats = generatePark(77, regionFor(SQUARE), PARAMS({ variety: v }), CONSTRAINTS);
      expect(typeCount(feats, "park-lawn"), `${v}: expected one merged lawn`).toBe(1);
      const lawn = feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "park-lawn")!;
      expect(lawn.geometry.type).toBe("Polygon");
    }
  });

  it("city-park emits the canopy (second green) as ONE merged organic MultiPolygon (027-C blob-union)", () => {
    // Plan 027-C fixes the 027-A double-darkening: the per-clump blobFeature stack
    // (multiple overlapping Polygons) becomes ONE marching-squares union polygon,
    // so overlapping clumps paint a single flat figure-ground green.
    const feats = generatePark(88, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    expect(typeCount(feats, "park-canopy")).toBe(1);
    const canopy = feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "park-canopy")!;
    expect(canopy.geometry.type).toBe("MultiPolygon");
    // A seam-safe rim traces every canopy ring (never a line layer on the fill).
    expect(typeCount(feats, "park-canopy-rim")).toBeGreaterThan(0);
  });

  it("re-emits paths as classed LineStrings (cased-path pairing hook), not span quads", () => {
    const feats = generatePark(88, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    const paths = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-path");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.geometry.type).toBe("LineString");
      expect(typeof (p.properties as { class?: string }).class).toBe("string");
    }
  });
});

describe("park generator — graceful degradation (japanese-garden, shrinking regions)", () => {
  // court (≥130) → island (≥80) → pond (≥25) → pond-only, never throwing.
  const squareOf = (side: number): Pt[] => [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
    [0, 0],
  ];
  it("drops the court, then the island, then the pond as the region shrinks", () => {
    const p = PARAMS({ variety: "japanese-garden" });
    // maxInteriorDistance ≈ side/2 for a square.
    const big = generatePark(3, regionFor(squareOf(600)), p, CONSTRAINTS); // ~300
    const mid = generatePark(3, regionFor(squareOf(320)), p, CONSTRAINTS); // ~160 (court dropped)
    const small = generatePark(3, regionFor(squareOf(200)), p, CONSTRAINTS); // ~100 (island dropped)
    const tiny = generatePark(3, regionFor(squareOf(90)), p, CONSTRAINTS); // ~45 (pond only, no island/court)

    expect(typeCount(big, "park-court")).toBe(1);
    expect(typeCount(big, "park-island")).toBe(1);

    expect(typeCount(mid, "park-court")).toBe(0);
    expect(typeCount(mid, "park-island")).toBe(1);

    expect(typeCount(small, "park-court")).toBe(0);
    expect(typeCount(small, "park-island")).toBe(0);
    expect(typeCount(small, "park-pond")).toBe(1);

    expect(typeCount(tiny, "park-island")).toBe(0);
    expect(typeCount(tiny, "park-court")).toBe(0);
    // tiny may or may not fit a pond; it must not throw and stays contained.
    const region = regionFor(squareOf(90));
    for (const [x, y] of allCoords(tiny)) {
      expect(distanceToBoundary(region, x, y)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("park generator — preset semantics", () => {
  it("carries the variety onto emitted features (theme tint hook)", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "wild-common" }), CONSTRAINTS);
    expect(feats.length).toBeGreaterThan(0);
    for (const f of feats) expect((f.properties as { parkType?: string }).parkType).toBe("wild-common");
  });

  it("wild-common scatters more trees than a formal garden's rows", () => {
    const wild = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "wild-common" }), CONSTRAINTS);
    const formal = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "formal-garden" }), CONSTRAINTS);
    expect(typeCount(wild, "park-tree")).toBeGreaterThan(typeCount(formal, "park-tree"));
  });

  it("no pond when pond=false and variety is not japanese", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "city-park", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-pond")).toBe(0);
  });

  it("japanese-garden ponds even when pond=false (its composition anchor)", () => {
    const feats = generatePark(3, regionFor(SQUARE), PARAMS({ variety: "japanese-garden", pond: false }), CONSTRAINTS);
    expect(typeCount(feats, "park-pond")).toBe(1);
  });
});

describe("park generator — 027-B skeleton (entrances + per-variety structure)", () => {
  type Path = { coords: Pt[]; class: string };
  function paths(feats: GeoJSON.Feature[]): Path[] {
    return feats
      .filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-path")
      .map((f) => ({
        coords: (f.geometry as unknown as { coordinates: Pt[] }).coordinates,
        class: String((f.properties as { class?: string }).class),
      }));
  }
  function roadNear(from: Pt, to: Pt): FabricFeature {
    return {
      type: "Feature",
      id: `road-${from[0]}-${from[1]}`,
      geometry: { type: "LineString", coordinates: [from, to] },
      properties: { kind: "road" },
    } as FabricFeature;
  }

  it("hangs an entrance off a sketched road crossing — a path endpoint lands on the ring there", () => {
    // A road approaching the LEFT edge of SQUARE near y=500 ⇒ an entrance at ~[0,500].
    const constraints: GenerationConstraints = { ...CONSTRAINTS, fabricFeatures: [roadNear([-40, 500], [-8, 500])] };
    const region = regionFor(SQUARE);
    const feats = generatePark(50, region, PARAMS({ variety: "city-park" }), constraints);
    const endpoints: Pt[] = [];
    for (const p of paths(feats)) {
      endpoints.push(p.coords[0], p.coords[p.coords.length - 1]);
    }
    // Some path endpoint sits ON the boundary near the road projection [0,500].
    const hit = endpoints.some(([x, y]) => distanceToBoundary(region, x, y) < 2 && Math.hypot(x - 0, y - 500) < 25);
    expect(hit, "no path reaches the road-derived entrance at [0,500]").toBe(true);
  });

  it("with no roads, falls back to 2–5 boundary entrances and connects them", () => {
    const region = regionFor(SQUARE);
    const feats = generatePark(50, region, PARAMS({ variety: "city-park" }), CONSTRAINTS);
    // Every diagonal ('walk') endpoint sits on the ring (entrance-connects).
    for (const p of paths(feats).filter((x) => x.class === "walk")) {
      for (const end of [p.coords[0], p.coords[p.coords.length - 1]]) {
        expect(distanceToBoundary(region, end[0], end[1])).toBeLessThan(3);
      }
    }
  });

  it("city-park emits a closed perimeter loop (first ≈ last)", () => {
    const feats = generatePark(50, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    const loop = paths(feats).find((p) => p.class === "loop");
    expect(loop, "no perimeter loop").toBeDefined();
    const a = loop!.coords[0];
    const b = loop!.coords[loop!.coords.length - 1];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.01); // closed ring
    expect(loop!.coords.length).toBeGreaterThan(3);
  });

  it("formal-garden axis follows the ring's LONGEST dimension (rectangle) and mirror-matches beds", () => {
    // A wide rectangle (2:1) ⇒ the dominant axis is horizontal.
    const RECT: Pt[] = [
      [0, 0],
      [1600, 0],
      [1600, 800],
      [0, 800],
      [0, 0],
    ];
    const region = regionFor(RECT);
    const feats = generatePark(9, region, PARAMS({ variety: "formal-garden", pond: false }), CONSTRAINTS);
    const axes = paths(feats).filter((p) => p.class === "axis");
    expect(axes.length).toBeGreaterThan(0);
    // The longest axis path should span more in x than in y (horizontal dominant).
    const longest = axes.reduce((m, p) => {
      const len = Math.hypot(
        p.coords[p.coords.length - 1][0] - p.coords[0][0],
        p.coords[p.coords.length - 1][1] - p.coords[0][1]
      );
      return len > m.len ? { len, p } : m;
    }, { len: 0, p: axes[0] });
    const dx = Math.abs(longest.p.coords[longest.p.coords.length - 1][0] - longest.p.coords[0][0]);
    const dy = Math.abs(longest.p.coords[longest.p.coords.length - 1][1] - longest.p.coords[0][1]);
    expect(dx).toBeGreaterThan(dy);

    // Beds are mirror-symmetric across the horizontal axis (y = cy). Reflecting a
    // bed's centroid across cy should match another bed's centroid within mm.
    const beds = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-bed");
    expect(beds.length).toBeGreaterThanOrEqual(4);
    const cy = region.interiorPole[1];
    const centroid = (f: GeoJSON.Feature): Pt => {
      const ring = (f.geometry as unknown as { coordinates: Pt[][] }).coordinates[0];
      let x = 0;
      let y = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        x += ring[i][0];
        y += ring[i][1];
      }
      return [x / (ring.length - 1), y / (ring.length - 1)];
    };
    const cents = beds.map(centroid);
    for (const c of cents) {
      const mirrored: Pt = [c[0], 2 * cy - c[1]];
      const match = cents.some((o) => Math.hypot(o[0] - mirrored[0], o[1] - mirrored[1]) < 0.05);
      expect(match, `bed at ${c} has no mirror partner across y=${cy}`).toBe(true);
    }
  });

  it("japanese-garden emits lanterns and a teahouse as park-point, deterministically", () => {
    const region = regionFor(SQUARE);
    const p = PARAMS({ variety: "japanese-garden" });
    const a = generatePark(9, region, p, CONSTRAINTS);
    const points = a.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-point");
    const kinds = new Set(points.map((f) => String((f.properties as { pointKind?: string }).pointKind)));
    expect(kinds.has("lantern"), "no lanterns").toBe(true);
    expect(kinds.has("teahouse"), "no teahouse").toBe(true);
    // A roji spur (its own path class) accompanies the teahouse.
    expect(a.some((f) => String((f.properties as { class?: string }).class) === "roji")).toBe(true);
    // Rocks come in ODD-count groups (Sakuteiki) — total is a sum of 3/5/3.
    const rocks = typeCount(a, "park-rock");
    expect([3, 5, 6, 8, 11].includes(rocks) || rocks % 2 === 1, `rocks=${rocks}`).toBe(true);
    // Determinism: a second run is byte-identical.
    const b = generatePark(9, region, p, CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("wild-common is restrained: few paths, ONE landmark, a duck pond, an open centre", () => {
    const region = regionFor(SQUARE);
    const feats = generatePark(9, region, PARAMS({ variety: "wild-common" }), CONSTRAINTS);
    expect(typeCount(feats, "park-path")).toBeLessThanOrEqual(4); // 1–2 desire lines (each may clip to runs)
    expect(typeCount(feats, "park-point")).toBe(1); // ONE monument/maypole
    expect(typeCount(feats, "park-pond")).toBe(1); // the duck pond
    expect(typeCount(feats, "park-canopy")).toBe(0); // no manicured canopy masses
    // The meadow centre stays open (no trees within maxD*0.55 of the pole).
    const [cx, cy] = region.interiorPole;
    const treeInCentre = feats.some(
      (f) =>
        (f.properties as { generatorId?: string }).generatorId === "park-tree" &&
        Math.hypot((f.geometry as unknown as { coordinates: Pt }).coordinates[0] - cx, (f.geometry as unknown as { coordinates: Pt }).coordinates[1] - cy) <
          region.maxInteriorDistance * 0.4
    );
    expect(treeInCentre, "wild-common centre is not an open meadow").toBe(false);
    // The lawn carries the meadow flag (theme tint hook).
    const lawn = feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "park-lawn")!;
    expect((lawn.properties as { meadow?: boolean }).meadow).toBe(true);
  });

  it("entrance edit-locality: moving a far vertex leaves a road-pinned entrance's path byte-identical", () => {
    // Two roads pin entrances on the LEFT and TOP edges; the diagonal between
    // them is far from the bottom-right corner we move.
    const constraints: GenerationConstraints = {
      ...CONSTRAINTS,
      fabricFeatures: [roadNear([-40, 250], [-8, 250]), roadNear([250, -40], [250, -8])],
    };
    const base = generatePark(50, regionFor(SQUARE), PARAMS({ variety: "city-park" }), constraints);
    const movedRing: Pt[] = [
      [0, 0],
      [1080, 0],
      [1080, 1080], // far corner pushed out
      [0, 1000],
      [0, 0],
    ];
    const moved = generatePark(50, regionFor(movedRing), PARAMS({ variety: "city-park" }), constraints);
    // The 'walk' diagonal touching the left+top entrances is unaffected by the
    // far corner: its serialization is present in both outputs.
    const walk = (fs: GeoJSON.Feature[]): string[] =>
      fs
        .filter((f) => String((f.properties as { class?: string }).class) === "walk")
        .map((f) => JSON.stringify((f.geometry as unknown as { coordinates: Pt[] }).coordinates));
    const baseWalks = walk(base);
    const movedWalks = new Set(walk(moved));
    // At least one near-side diagonal survives byte-identical across the edit.
    expect(baseWalks.some((w) => movedWalks.has(w)), "no near-side diagonal stayed byte-identical").toBe(true);
  });
});

describe("park generator — 027-C organic water/canopy + glyph dressing", () => {
  type Ring = Pt[];
  function pondExterior(feats: GeoJSON.Feature[]): Ring {
    const pond = feats.find((f) => (f.properties as { generatorId?: string }).generatorId === "park-pond")!;
    expect(pond, "no park-pond").toBeDefined();
    expect(pond.geometry.type).toBe("MultiPolygon");
    // Largest exterior ring across the MultiPolygon.
    const polys = (pond.geometry as unknown as { coordinates: Pt[][][] }).coordinates;
    let best: Ring = polys[0][0];
    let bestN = -1;
    for (const poly of polys) if (poly[0].length > bestN) ((bestN = poly[0].length), (best = poly[0]));
    return best;
  }
  /** Coefficient of variation of a ring's radii about its centroid — a circle
   * reads ~0, an organic shoreline reads clearly non-zero. */
  function radiusCV(ring: Ring): number {
    let cx = 0;
    let cy = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) ((cx += ring[i][0]), (cy += ring[i][1]));
    cx /= n;
    cy /= n;
    const rs: number[] = [];
    for (let i = 0; i < n; i++) rs.push(Math.hypot(ring[i][0] - cx, ring[i][1] - cy));
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const varr = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length;
    return Math.sqrt(varr) / mean;
  }

  it("japanese pond is an ORGANIC marching-squares shoreline (many vertices, irregular — not a blob circle)", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    const ring = pondExterior(feats);
    // A marching-squares + Chaikin shoreline has many vertices (a harmonic blob
    // circle had ~48); its radius clearly varies (miegakure irregularity).
    expect(ring.length).toBeGreaterThan(40);
    expect(radiusCV(ring), "pond reads as a circle, not an organic shore").toBeGreaterThan(0.06);
    // Shore casing is emitted as its OWN seam-safe LineStrings (never line-on-fill).
    const shores = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-pond-shore");
    expect(shores.length).toBeGreaterThan(0);
    for (const s of shores) expect(s.geometry.type).toBe("LineString");
  });

  it("formal basin stays near-circular (deliberately low irregularity) vs the organic city pond", () => {
    const formal = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "formal-garden", pond: false }), CONSTRAINTS);
    const city = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "city-park", pond: true }), CONSTRAINTS);
    expect(radiusCV(pondExterior(formal))).toBeLessThan(radiusCV(pondExterior(city)));
  });

  it("emits karesansui rake texture inside the court (LineStrings) on a large japanese garden", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    expect(typeCount(feats, "park-court")).toBe(1);
    const rake = feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-court-rake");
    expect(rake.length).toBeGreaterThan(3);
    for (const r of rake) expect(r.geometry.type).toBe("LineString");
  });

  it("bridges carry an arch/zigzag style; rocks + trees carry glyph variant/family props", () => {
    const feats = generatePark(9, regionFor(SQUARE), PARAMS({ variety: "japanese-garden" }), CONSTRAINTS);
    for (const b of feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-bridge")) {
      expect(["arch", "zigzag"]).toContain(String((b.properties as { style?: string }).style));
    }
    for (const r of feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-rock")) {
      const v = (r.properties as { variant?: number }).variant;
      expect(v === 0 || v === 1 || v === 2, `rock variant ${v} out of 0..2`).toBe(true);
    }
    for (const tr of feats.filter((f) => (f.properties as { generatorId?: string }).generatorId === "park-tree")) {
      const p = tr.properties as { treeFamily?: string; variant?: number };
      expect(typeof p.treeFamily).toBe("string");
      expect(p.variant! >= 0 && p.variant! <= 3).toBe(true);
    }
  });

  it("canopy union does not double-count: ONE park-canopy feature even with many clump anchors", () => {
    const feats = generatePark(88, regionFor(SQUARE), PARAMS({ variety: "city-park" }), CONSTRAINTS);
    expect(typeCount(feats, "park-canopy")).toBe(1);
  });
});

describe("park generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const region = regionFor(SQUARE);
    const network = generatePark(21, region, PARAMS(), CONSTRAINTS);
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clipped = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clipped++;
            }
          }
        }
      }
    }
    expect(clipped).toBeGreaterThan(0);
  });
});

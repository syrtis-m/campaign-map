import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateRiver,
  riverMaxOffset,
  BASE_MEANDER_AMP_M,
  MIN_ISLAND_WIDTH_FRAC,
  MEANDER_WAVELENGTH_WIDTHS,
  RC_MIN_WIDTHS,
  DRESS_WINDINESS,
  DELTA_BIAS_THRESHOLD,
  CONFLUENCE_SNAP_M,
  type RiverParams,
} from "./river";
import { makeSpine, makeCorridorRegion, distanceToSpine, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";
import { expectGeneratorInvariants, expectDeterministic } from "./testkit/invariants";
import { computeRiverMetrics, riverBandViolations } from "./riverMetrics";

type Pt = [number, number];

const CONSTRAINTS: GenerationConstraints = {
  worldBounds: { minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 },
};

/** A gently kinked multi-segment river spine in gen-space meters. */
const LINE: Pt[] = [
  [0, 0],
  [300, 40],
  [600, -30],
  [900, 50],
  [1200, 0],
];

const PARAMS = (o: Partial<RiverParams> = {}): RiverParams => ({
  windiness: 0.8,
  braiding: 0,
  width: 20,
  widthGrowth: 0,
  braidBias: 0,
  ...o,
});

function regionFor(line: Pt[], params: RiverParams): ProcgenRegion {
  return makeCorridorRegion("river-test", makeSpine("river-test", line), riverMaxOffset(params));
}

/** Every coordinate of every feature, flattened. */
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

function bucketSet(feats: GeoJSON.Feature[], grid = 6): Set<string> {
  const s = new Set<string>();
  for (const [x, y] of allCoords(feats)) s.add(`${Math.round(x / grid)},${Math.round(y / grid)}`);
  return s;
}

function overlapPct(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return (hit / a.size) * 100;
}

/** Hash + per-type counts (the corridor.test.ts idiom): any numeric drift
 * flips the sha256 without committing megabytes of coordinates. This is the
 * per-generator drift tripwire DECISIONS 2026-07-13 asked of every 022+
 * generator — self-relative determinism tests survive a uniform algorithm
 * change; this snapshot does not. */
function digest(features: GeoJSON.Feature[]): { sha256: string; summary: Record<string, number> } {
  const summary: Record<string, number> = { total: features.length };
  for (const f of features) {
    const type = String((f.properties as Record<string, unknown>)?.type);
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(features)).digest("hex"),
    summary,
  };
}

describe("river generator — determinism", () => {
  it("matches the seeded snapshot fixture (windy + braided — golden drift tripwire)", () => {
    // windiness 0.85 ≥ DRESS_WINDINESS appends point-bar / oxbow / ford
    // dressing; braidBias 0.2 < DELTA_BIAS_THRESHOLD and no partner spine /
    // water polygon in CONSTRAINTS, so NO delta / confluence / estuary.
    const p = PARAMS({ windiness: 0.85, braiding: 0.6, width: 26, widthGrowth: 0.7, braidBias: 0.2 });
    expect(digest(generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("exercises the braid/island/distributary emission path (delta)", () => {
    // The windy+braided golden above carries no braids (its 26 m channel can't
    // afford a legible island — the degradation ladder), so this case pins the
    // braid + island path structurally: braidBias 1 on a LAND mouth appends
    // islands and two bird's-foot distributaries at ≈72°. Kept as a STRUCTURAL
    // assertion, not a second byte-golden — the one river golden is windy+braided;
    // the counts here catch a regression that stops emitting braids/distributaries.
    const p = PARAMS({ windiness: 0.4, braiding: 1, width: 20, widthGrowth: 1, braidBias: 1 });
    const d = digest(generateRiver(8, regionFor(LINE, p), p, CONSTRAINTS));
    expect(d.summary["river-island"]).toBeGreaterThan(0);
    expect(d.summary["river-distributary"]).toBeGreaterThan(0);
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(LINE, PARAMS());
    expectDeterministic(() => generateRiver(1234, region, PARAMS(), CONSTRAINTS));
  });

  it("hashes feature ids on position, not emission order (integer ids)", () => {
    const region = regionFor(LINE, PARAMS());
    const feats = generateRiver(7, region, PARAMS(), CONSTRAINTS);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      expect(Number.isFinite(Number(f.id))).toBe(true);
    }
  });
});

describe("river generator — corridor containment (plan 022 §2)", () => {
  for (const preset of [
    { name: "lazy-lowland", p: PARAMS({ windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2 }) },
    { name: "mountain-torrent", p: PARAMS({ windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2 }) },
    { name: "canal", p: PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 }) },
    { name: "delta", p: PARAMS({ windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1 }) },
  ]) {
    it(`all output within maxOffset of the spine — ${preset.name}`, () => {
      const region = regionFor(LINE, preset.p);
      // Corridor containment is exact by construction, so keep the tight 1e-3 m
      // bound (distanceToBoundary = maxOffset − distanceToSpine); the helper adds
      // closed-ring + mm-lattice on top.
      expectGeneratorInvariants(generateRiver(99, region, preset.p, CONSTRAINTS), region, {
        containmentTolerance: 1e-3,
      });
    });
  }
});

describe("river generator — identity / edit locality (deliverable 4)", () => {
  it("a single end-vertex edit re-meanders far less than a re-roll", () => {
    const region = regionFor(LINE, PARAMS());
    const base = bucketSet(generateRiver(50, region, PARAMS(), CONSTRAINTS));

    // Move ONLY the last vertex (changes just the last segment's endpoints).
    const moved: Pt[] = [...LINE.slice(0, -1), [1230, 30]];
    const movedRegion = regionFor(moved, PARAMS());
    const movedBuckets = bucketSet(generateRiver(50, movedRegion, PARAMS(), CONSTRAINTS));

    // Re-roll: new seed, same spine → every segment re-meanders.
    const rerolled = bucketSet(generateRiver(51, region, PARAMS(), CONSTRAINTS));

    const editOverlap = overlapPct(base, movedBuckets);
    const rerollOverlap = overlapPct(base, rerolled);
    // The edit keeps the untouched segments byte-identical; the re-roll does not.
    expect(editOverlap).toBeGreaterThan(rerollOverlap + 25);
    expect(editOverlap).toBeGreaterThan(55);
  });

  it("segments away from an edit are byte-identical (widthGrowth 0)", () => {
    // With widthGrowth 0 the only global-arc quantity vanishes, so unmoved
    // segments must be EXACTLY identical (not just bucket-stable).
    const region = regionFor(LINE, PARAMS({ widthGrowth: 0 }));
    const feats0 = generateRiver(50, region, PARAMS({ widthGrowth: 0 }), CONSTRAINTS);
    const moved: Pt[] = [...LINE.slice(0, -1), [1230, 30]];
    const feats1 = generateRiver(50, regionFor(moved, PARAMS({ widthGrowth: 0 })), PARAMS({ widthGrowth: 0 }), CONSTRAINTS);
    // Features whose coordinates all sit before x=780 lie on the first three
    // (unmoved) segments AND clear of the corner-fillet window at the [900,50]
    // vertex (the fillet there reads the edited segment, so up to FILLET_MAX_M
    // of segment 2's tail — x ≳ 850 — legitimately moves with the edit); they
    // must appear identically in both runs.
    const early = (fs: GeoJSON.Feature[]): string[] =>
      fs
        .filter((f) => allCoords([f]).every(([x]) => x < 780))
        .map((f) => JSON.stringify(f.geometry))
        .sort();
    const e0 = early(feats0);
    const e1 = early(feats1);
    expect(e0.length).toBeGreaterThan(0);
    expect(e1).toEqual(e0);
  });
});

describe("river generator — preset semantics", () => {
  it("canal (windiness 0, growth 0) hugs the spine within half-width", () => {
    const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
    const region = regionFor(LINE, p);
    const feats = generateRiver(3, region, p, CONSTRAINTS);
    const spine = region.spine!;
    for (const [x, y] of allCoords(feats)) {
      // No meander, no braid: every point is a bank at most width/2 from spine.
      expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(12 / 2 + 1e-3);
    }
  });

  it("delta braids toward the mouth: islands concentrate downstream", () => {
    const p = PARAMS({ windiness: 0.4, braiding: 1, width: 20, widthGrowth: 1, braidBias: 1 });
    const region = regionFor(LINE, p);
    const feats = generateRiver(8, region, p, CONSTRAINTS);
    const islands = feats.filter((f) => (f.properties as { type?: string }).type === "river-island");
    expect(islands.length).toBeGreaterThan(0);
    const totalLen = region.spine!.totalLen;
    // Mean downstream position of island vertices should sit past the midpoint.
    let sx = 0;
    let n = 0;
    for (const [x] of allCoords(islands)) {
      sx += x;
      n++;
    }
    // The spine runs monotonically in +x over [0,1200]; islands weighted to the
    // mouth means a mean x well past the middle of the run.
    expect(sx / n).toBeGreaterThan(totalLen * 0.4);
  });

  it("canal emits no islands", () => {
    const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
    const feats = generateRiver(3, regionFor(LINE, p), p, CONSTRAINTS);
    expect(feats.some((f) => (f.properties as { type?: string }).type === "river-island")).toBe(false);
  });
});

describe("river generator — maxOffset monotonicity (deliverable 5)", () => {
  it("windiness increase widens the corridor and never violates containment", () => {
    const low = PARAMS({ windiness: 0.2 });
    const high = PARAMS({ windiness: 0.9 });
    expect(riverMaxOffset(high)).toBeGreaterThan(riverMaxOffset(low));
    for (const p of [low, high]) {
      const region = regionFor(LINE, p);
      const spine = region.spine!;
      const feats = generateRiver(11, region, p, CONSTRAINTS);
      for (const [x, y] of allCoords(feats)) {
        expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(riverMaxOffset(p) + 1e-3);
      }
    }
  });

  it("maxOffset is monotonic in braiding, width, and widthGrowth", () => {
    const base = PARAMS();
    expect(riverMaxOffset({ ...base, braiding: 1 })).toBeGreaterThan(riverMaxOffset({ ...base, braiding: 0 }));
    expect(riverMaxOffset({ ...base, width: 40 })).toBeGreaterThan(riverMaxOffset({ ...base, width: 10 }));
    expect(riverMaxOffset({ ...base, widthGrowth: 2 })).toBeGreaterThan(riverMaxOffset({ ...base, widthGrowth: 0 }));
    // windiness 0 with a wide channel still has a positive corridor.
    expect(riverMaxOffset(PARAMS({ windiness: 0 }))).toBeGreaterThan(0);
    // Scales with the amplitude constant.
    expect(riverMaxOffset(PARAMS({ windiness: 1, width: 0.001, widthGrowth: 0, braiding: 0 }))).toBeGreaterThan(
      BASE_MEANDER_AMP_M - 1
    );
  });
});

describe("river generator — 2x2 seam via whole-artifact clip", () => {
  it("clips deterministically and keeps every coordinate inside its tile", () => {
    const p = PARAMS({ windiness: 0.6, braiding: 0.4, width: 24, widthGrowth: 0.5, braidBias: 0.3 });
    const region = regionFor(LINE, p);
    const network = generateRiver(21, region, p, CONSTRAINTS);
    // Cover the whole river with the tiles its bbox touches (a 2x2+ grid).
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    let clippedFeatures = 0;
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        const bb = tileBBox(tx, ty);
        const a = clipNetworkToTile(network, bb);
        const b = clipNetworkToTile(network, bb);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic clip
        for (const gid of Object.keys(a)) {
          for (const f of a[gid]) {
            for (const [x, y] of allCoords([f])) {
              // Clipped coords must lie within (a hair of) the tile bbox.
              expect(x).toBeGreaterThanOrEqual(bb.minX - 1e-3);
              expect(x).toBeLessThanOrEqual(bb.maxX + 1e-3);
              expect(y).toBeGreaterThanOrEqual(bb.minY - 1e-3);
              expect(y).toBeLessThanOrEqual(bb.maxY + 1e-3);
              clippedFeatures++;
            }
          }
        }
      }
    }
    expect(clippedFeatures).toBeGreaterThan(0);
  });
});

// ─── channel-merge topology, bank casing, island legibility, canal regression ─

const byType = (feats: GeoJSON.Feature[], type: string): GeoJSON.Feature[] =>
  feats.filter((f) => (f.properties as { type?: string }).type === type);

/** Open (closing vertex dropped) polygon ring of a Feature. */
function openRing(f: GeoJSON.Feature): Pt[] {
  const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as Pt[];
  return ring.slice(0, -1);
}

const key = ([x, y]: Pt): string => `${x},${y}`;
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("river generator — channel-merge topology + bank casing (plan 028 §1.1)", () => {
  // Windy, no braids: emission is exactly [channel, leftBank, rightBank] per
  // ORIGINAL segment, in segment order (emission order is deterministic).
  const p = PARAMS();
  const feats = generateRiver(50, regionFor(LINE, p), p, CONSTRAINTS);
  const channels = byType(feats, "river-channel");
  const banks = byType(feats, "river-bank");
  const nSegs = LINE.length - 1;

  it("merges each original segment's quad chain into ONE ribbon polygon", () => {
    expect(channels.length).toBe(nSegs);
    for (const c of channels) {
      expect(c.geometry.type).toBe("Polygon");
      // A merged ribbon, not a quad: dozens of bank samples per side.
      expect(openRing(c).length).toBeGreaterThan(20);
    }
  });

  it("emits left+right river-bank LineStrings per segment, welded at joints", () => {
    expect(banks.length).toBe(2 * nSegs);
    for (const b of banks) expect(b.geometry.type).toBe("LineString");
    // banks[2k] = left of segment k, banks[2k+1] = right (emission order).
    for (let k = 0; k + 1 < nSegs; k++) {
      for (const side of [0, 1]) {
        const cur = (banks[2 * k + side].geometry as GeoJSON.LineString).coordinates as Pt[];
        const next = (banks[2 * (k + 1) + side].geometry as GeoJSON.LineString).coordinates as Pt[];
        // Shared quantized joint vertex — EXACT, so round line-joins render
        // the casing continuous across spine vertices.
        expect(key(cur[cur.length - 1])).toBe(key(next[0]));
      }
    }
  });

  it("bank casing hugs the channel: every bank vertex lies on its segment's ribbon outline", () => {
    for (let k = 0; k < nSegs; k++) {
      const ringSet = new Set(openRing(channels[k]).map(key));
      for (const side of [0, 1]) {
        const line = (banks[2 * k + side].geometry as GeoJSON.LineString).coordinates as Pt[];
        for (const c of line) expect(ringSet.has(key(c))).toBe(true);
      }
    }
  });

  it("adjacent ribbons OVERLAP by the joint weld (no abutting hairline)", () => {
    for (let k = 1; k < nSegs; k++) {
      const ring = openRing(channels[k]);
      const jointL = ((banks[2 * k].geometry as GeoJSON.LineString).coordinates as Pt[])[0];
      const jointR = ((banks[2 * k + 1].geometry as GeoJSON.LineString).coordinates as Pt[])[0];
      const weldL = ring[0]; // ribbon head, extended upstream past the joint
      const weldR = ring[ring.length - 1];
      for (const [weld, joint] of [
        [weldL, jointL],
        [weldR, jointR],
      ] as [Pt, Pt][]) {
        const d = dist(weld, joint);
        expect(d).toBeGreaterThan(0); // strictly past the joint → overlap
        expect(d).toBeLessThanOrEqual(0.5 + 5e-3); // …by ≤ JOINT_WELD_M
      }
    }
  });
});

describe("river generator — braid islands are legible lozenges (plan 028 §1.3)", () => {
  const p = PARAMS({ windiness: 0.4, braiding: 1, width: 20, widthGrowth: 1, braidBias: 1 });
  const feats = generateRiver(8, regionFor(LINE, p), p, CONSTRAINTS);
  const islands = byType(feats, "river-island");
  const banks = byType(feats, "river-bank");
  const channels = byType(feats, "river-channel");
  const nSegs = LINE.length - 1;

  it("emits islands, one merged lozenge per braid (no sliver quads)", () => {
    expect(islands.length).toBeGreaterThan(0);
    const nBraids = islands.length;
    // One extra channel ribbon + two extra bank lines per braid.
    expect(channels.length).toBe(nSegs + nBraids);
    expect(banks.length).toBe(2 * nSegs + 2 * nBraids);
  });

  it("every island cross-section is ≥ MIN_ISLAND_WIDTH_FRAC × channel width (no-sliver floor)", () => {
    for (const island of islands) {
      const open = openRing(island);
      expect(open.length % 2).toBe(0);
      const n = open.length / 2;
      expect(n).toBeGreaterThanOrEqual(2);
      const main = open.slice(0, n);
      const inner = open.slice(n).reverse(); // back to forward order
      for (let j = 0; j < n; j++) {
        // Paired vertices sit on the same cross-normal, so this distance IS
        // the island's local width. Local channel width ≥ params.width
        // (growth ≥ 0), so the params-only floor is a valid lower bound.
        expect(dist(main[j], inner[j])).toBeGreaterThanOrEqual(MIN_ISLAND_WIDTH_FRAC * p.width - 0.01);
      }
    }
  });

  it("islands taper downstream (widest cross-section in the upstream 60%)", () => {
    for (const island of islands) {
      const open = openRing(island);
      const n = open.length / 2;
      const main = open.slice(0, n);
      const inner = open.slice(n).reverse();
      let argmax = 0;
      let max = -1;
      for (let j = 0; j < n; j++) {
        const w = dist(main[j], inner[j]);
        if (w > max) {
          max = w;
          argmax = j;
        }
      }
      expect(argmax).toBeLessThanOrEqual(Math.ceil(0.6 * n));
    }
  });

  it("island extent respects the braid-unit scale (≈4–5× channel width)", () => {
    const maxW = 2 * (p.width / 2) * (1 + p.widthGrowth); // width at the mouth
    for (const island of islands) {
      const open = openRing(island);
      let extent = 0;
      for (const a of open) for (const b of open) extent = Math.max(extent, dist(a, b));
      expect(extent).toBeLessThanOrEqual(5 * maxW);
    }
  });
});

describe("river generator — canal preset regression (plan 028 §2, 28-A gate)", () => {
  // Pinned fixture: the canal preset's 414 unique bank coordinates over LINE
  // with seed 3. The channel merge must not move a single bank sample — the bank
  // casing lines carry exactly the pinned outline, and the ribbons add ONLY the
  // ≤2 weld vertices per interior joint, each within JOINT_WELD_M of a pinned
  // coordinate.
  const PRE_028_SHA = "63bde42fc912f4d6a1162d68d3bd559d3fae5bc264d6fc42df5acff2cef0e48c";
  const PRE_028_COUNT = 414;
  const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
  const feats = generateRiver(3, regionFor(LINE, p), p, CONSTRAINTS);

  it("bank geometry is byte-identical to the pre-028 channel outline", () => {
    const bankCoords = new Set<string>();
    for (const [x, y] of allCoords(byType(feats, "river-bank"))) bankCoords.add(`${x},${y}`);
    expect(bankCoords.size).toBe(PRE_028_COUNT);
    const sha = createHash("sha256").update(JSON.stringify(Array.from(bankCoords).sort())).digest("hex");
    expect(sha).toBe(PRE_028_SHA);
  });

  it("channel ribbons add only the joint-weld vertices (each ≤ JOINT_WELD_M from the old outline)", () => {
    const bankCoords = new Set<string>();
    const bankPts: Pt[] = [];
    for (const [x, y] of allCoords(byType(feats, "river-bank"))) {
      if (!bankCoords.has(`${x},${y}`)) bankPts.push([x, y]);
      bankCoords.add(`${x},${y}`);
    }
    const extras: Pt[] = [];
    for (const [x, y] of allCoords(byType(feats, "river-channel"))) {
      if (!bankCoords.has(`${x},${y}`)) extras.push([x, y]);
    }
    // ≤ 2 welds per interior spine vertex (dedup: the close vertex repeats).
    const uniqExtras = Array.from(new Set(extras.map(key))).map((s) => s.split(",").map(Number) as Pt);
    expect(uniqExtras.length).toBeLessThanOrEqual(2 * (LINE.length - 2));
    for (const e of uniqExtras) {
      let nearest = Infinity;
      for (const b of bankPts) nearest = Math.min(nearest, dist(e, b));
      expect(nearest).toBeLessThanOrEqual(0.5 + 5e-3);
    }
  });
});

// ─── SGC/Kinoshita meander math — ratio defaults, per-bend jitter, upstream
// skew, R_c ≥ 2W realism clamp ───────────────────────────────────────────────

/** One long straight segment along +x: lateral offset IS the y coordinate,
 * there are no fillets, and the envelope is negligible mid-segment — the
 * cleanest window onto the bend train. */
const STRAIGHT: Pt[] = [
  [0, 0],
  [6600, 0],
];
// slopeSensitivity 1: this fixture drives the slope-coupling tests, which
// require the (now opt-in, river v2 / plan 035) terrain coupling ON. With no
// mountain on the constraints (the meander-shape tests) the value is inert.
const MEANDER_P = PARAMS({ windiness: 0.8, braiding: 0, width: 20, widthGrowth: 0, slopeSensitivity: 1 });

/** Centerline reconstructed as the midpoint of the left/right bank casing
 * lines (emitted from the same samples, so midpoints ARE the meandered
 * centerline samples). */
function centerlineOf(feats: GeoJSON.Feature[]): Pt[] {
  const banks = byType(feats, "river-bank");
  expect(banks.length).toBe(2);
  const left = (banks[0].geometry as GeoJSON.LineString).coordinates as Pt[];
  const right = (banks[1].geometry as GeoJSON.LineString).coordinates as Pt[];
  expect(right.length).toBe(left.length);
  return left.map((p, i) => [(p[0] + right[i][0]) / 2, (p[1] + right[i][1]) / 2]);
}

/** Interior zero crossings of y along the centerline, linearly interpolated
 * to arc positions (x ≈ arc on the straight fixture). Exact zeros (segment
 * endpoints, env = 0) produce no crossing (y[i]·y[i+1] < 0 test). */
function crossingsOf(center: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < center.length; i++) {
    const y0 = center[i][1];
    const y1 = center[i + 1][1];
    if (y0 * y1 < 0) out.push(center[i][0] + (center[i + 1][0] - center[i][0]) * (y0 / (y0 - y1)));
  }
  return out;
}

/** Per-bend records between consecutive crossings: apex position fraction
 * (arc of max |y| within the bend) and apex amplitude. */
function bendsOf(center: Pt[], crossings: number[]): { apexFrac: number; apexAmp: number; span: number }[] {
  const bends: { apexFrac: number; apexAmp: number; span: number }[] = [];
  for (let b = 0; b + 1 < crossings.length; b++) {
    const [s0, s1] = [crossings[b], crossings[b + 1]];
    let apexAmp = -1;
    let apexX = s0;
    for (const [x, y] of center) {
      if (x < s0 || x > s1) continue;
      if (Math.abs(y) > apexAmp) {
        apexAmp = Math.abs(y);
        apexX = x;
      }
    }
    bends.push({ apexFrac: (apexX - s0) / (s1 - s0), apexAmp, span: s1 - s0 });
  }
  return bends;
}

/** Discrete curvature radius by three-point circumradius. */
function circumradius(a: Pt, b: Pt, c: Pt): number {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const area2 = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  if (area2 < 1e-12) return Infinity;
  return (ab * bc * ca) / (2 * area2);
}

describe("river generator — meander math (plan 028 §1.2, box 28-B)", () => {
  const feats = generateRiver(50, regionFor(STRAIGHT, MEANDER_P), MEANDER_P, CONSTRAINTS);
  const center = centerlineOf(feats);
  const crossings = crossingsOf(center);
  const bends = bendsOf(center, crossings);

  it("wavelength defaults to the empirical ratio: λ/W within 10–14 (target 11)", () => {
    // Mean spacing between zero crossings ≈ λ/2; skew shifts every zero by the
    // same phase at first order, so spacings are unbiased.
    expect(crossings.length).toBeGreaterThan(20);
    const spacings: number[] = [];
    for (let i = 0; i + 1 < crossings.length; i++) spacings.push(crossings[i + 1] - crossings[i]);
    const meanLambda = (2 * spacings.reduce((a, b) => a + b, 0)) / spacings.length;
    const ratio = meanLambda / MEANDER_P.width;
    expect(ratio).toBeGreaterThanOrEqual(MEANDER_WAVELENGTH_WIDTHS - 2);
    expect(ratio).toBeLessThanOrEqual(MEANDER_WAVELENGTH_WIDTHS + 2);
  });

  it("bends are quasi-periodic, not metronomic: per-bend wavelength AND amplitude vary", () => {
    const cv = (xs: number[]): number => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
      return Math.sqrt(varc) / mean;
    };
    // Interior bends only (envelope suppresses amplitude near segment ends).
    const interior = bends.filter((b) => b.apexAmp > 3);
    expect(interior.length).toBeGreaterThan(10);
    expect(cv(interior.map((b) => b.span))).toBeGreaterThan(0.05); // ±30% draw
    expect(cv(interior.map((b) => b.apexAmp))).toBeGreaterThan(0.05); // amp jitter + R_c clamp
  });

  it("Kinoshita skew leans every developed bend upstream (apex before the bend midpoint)", () => {
    const interior = bends.filter((b) => b.apexAmp > 3);
    expect(interior.length).toBeGreaterThan(10);
    const meanFrac = interior.reduce((a, b) => a + b.apexFrac, 0) / interior.length;
    // Symmetric bends would sit at 0.5; the third harmonic pulls the apex
    // measurably upstream (analytically ≈ 0.43 at windiness 0.8).
    expect(meanFrac).toBeLessThan(0.48);
    expect(meanFrac).toBeGreaterThan(0.3); // sanity: a lean, not a collapse
    // The lean is systematic, not noise: a clear majority of bends lean.
    const leaning = interior.filter((b) => b.apexFrac < 0.5).length;
    expect(leaning / interior.length).toBeGreaterThan(0.75);
  });

  it("asymmetry is windiness-driven: near-straight rivers are near-symmetric", () => {
    const p = PARAMS({ windiness: 0.15, braiding: 0, width: 20, widthGrowth: 0 });
    const c = centerlineOf(generateRiver(50, regionFor(STRAIGHT, p), p, CONSTRAINTS));
    const b = bendsOf(c, crossingsOf(c)).filter((x) => x.apexAmp > 0.5);
    expect(b.length).toBeGreaterThan(10);
    const meanFrac = b.reduce((a, x) => a + x.apexFrac, 0) / b.length;
    // skew ∝ windiness²: at 0.15 it is ~28× weaker than at 0.8.
    expect(Math.abs(meanFrac - 0.5)).toBeLessThan(0.04);
  });

  it("R_c ≥ 2W realism clamp: no bend tighter than RC_MIN_WIDTHS × width", () => {
    // Discrete three-point circumradius along the reconstructed centerline.
    // The clamp is analytic small-slope; slope only ADDS radius, and the
    // envelope is negligible on this long fixture — tolerance 0.85 absorbs
    // midpoint interpolation between lobes and discretization.
    let minR = Infinity;
    for (let i = 1; i + 1 < center.length; i++) {
      minR = Math.min(minR, circumradius(center[i - 1], center[i], center[i + 1]));
    }
    expect(minR).toBeGreaterThanOrEqual(RC_MIN_WIDTHS * MEANDER_P.width * 0.85);
    // …and the clamp actually engages: the tightest bend sits near the floor,
    // not far above it (the meander uses its curvature budget).
    expect(minR).toBeLessThanOrEqual(RC_MIN_WIDTHS * MEANDER_P.width * 3);
  });

  it("windiness drives amplitude monotonically", () => {
    const ampOf = (windiness: number): number => {
      const p = PARAMS({ windiness, braiding: 0, width: 20, widthGrowth: 0 });
      const c = centerlineOf(generateRiver(50, regionFor(STRAIGHT, p), p, CONSTRAINTS));
      return Math.max(...c.map(([, y]) => Math.abs(y)));
    };
    const hi = ampOf(0.8);
    const lo = ampOf(0.2);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0);
    // And the budget is respected (containment constant unchanged).
    expect(hi).toBeLessThanOrEqual(0.8 * BASE_MEANDER_AMP_M + 1e-6);
  });
});

// ── slope coupling ───────────────────────────────────────────────────────────
// The sketched mountains' elevation field (fields/mountainField.ts, composed
// from constraints.fabricFeatures — the raw sketch layer) damps meander
// amplitude and stretches wavelength on steep ground. These tests pin the
// direction of the modulation, the no-mountain / no-overlap byte-identity, the
// canal regression, and coupled determinism.

/** A sketched procgen MOUNTAIN whose interior covers the middle of STRAIGHT
 * (the single segment's midpoint x=3300 sits deep inside → real slope). */
function mountainAt(x0: number, x1: number, seed = 777): NonNullable<GenerationConstraints["fabricFeatures"]>[number] {
  return {
    type: "Feature",
    id: `mountain-${x0}`,
    geometry: {
      type: "Polygon",
      coordinates: [[[x0, -2000], [x1, -2000], [x1, 2000], [x0, 2000], [x0, -2000]]],
    },
    properties: {
      kind: "mountain",
      procgen: { algorithm: "mountain", seed, version: 1, params: { terrain: "alpine", amplitude: 0.8, roughness: 0.5 } },
    },
  } as NonNullable<GenerationConstraints["fabricFeatures"]>[number];
}

function withMountain(x0: number, x1: number): GenerationConstraints {
  return { worldBounds: CONSTRAINTS.worldBounds, fabricFeatures: [mountainAt(x0, x1)] };
}

describe("river generator — slope coupling (box 23-E)", () => {
  it("steep ground straightens the river: smaller amplitude AND fewer bends than the flat control", () => {
    const p = MEANDER_P; // slopeSensitivity 1 (coupling opted in — river v2 default is OFF)
    const region = regionFor(STRAIGHT, p);
    const flat = centerlineOf(generateRiver(50, region, p, CONSTRAINTS));
    const steep = centerlineOf(generateRiver(50, region, p, withMountain(1000, 5600)));
    const amp = (c: Pt[]): number => Math.max(...c.map(([, y]) => Math.abs(y)));
    // Amplitude damped (direction test: steep < flat, meaningfully).
    expect(amp(steep)).toBeLessThan(amp(flat) * 0.9);
    expect(amp(steep)).toBeGreaterThan(0); // damped, not zeroed
    // Wavelength stretched ⇒ fewer zero crossings (fewer bends).
    expect(crossingsOf(steep).length).toBeLessThan(crossingsOf(flat).length);
  });

  it("slopeSensitivity straightens monotonically — sinuosity drops as sensitivity rises (0 = byte-identical to no coupling)", () => {
    const region = regionFor(STRAIGHT, MEANDER_P);
    // Sinuosity (centerline arc / chord) is THE straightness measure: both
    // coupling mechanisms (amplitude damping AND wavelength stretch) lower it,
    // while max|y| alone can tie when the R_c cap re-binds.
    const sinuosityFor = (slopeSensitivity: number | undefined): number => {
      const p = PARAMS({ windiness: 0.8, width: 20, slopeSensitivity });
      const c = centerlineOf(generateRiver(50, region, p, withMountain(1000, 5600)));
      let arc = 0;
      for (let i = 1; i < c.length; i++) arc += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
      return arc / Math.hypot(c[c.length - 1][0] - c[0][0], c[c.length - 1][1] - c[0][1]);
    };
    const off = sinuosityFor(0);
    const half = sinuosityFor(0.5);
    const full = sinuosityFor(1);
    expect(full).toBeLessThan(half);
    expect(half).toBeLessThan(off);
    expect(off).toBeGreaterThan(1); // the uncoupled river genuinely meanders
    // sensitivity 0 over a mountain = byte-identical to the uncoupled river.
    const p0 = PARAMS({ windiness: 0.8, width: 20, slopeSensitivity: 0 });
    const a = generateRiver(50, region, p0, withMountain(1000, 5600));
    const b = generateRiver(50, region, PARAMS({ windiness: 0.8, width: 20 }), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a mountain that does NOT overlap the river leaves the output byte-identical (exact-zero mask)", () => {
    const p = MEANDER_P;
    const region = regionFor(STRAIGHT, p);
    const bare = generateRiver(50, region, p, CONSTRAINTS);
    const far = generateRiver(50, region, p, withMountain(20000, 24000));
    expect(JSON.stringify(far)).toBe(JSON.stringify(bare));
  });

  it("canal (windiness 0) is byte-identical with or without an overlapping mountain", () => {
    const p = PARAMS({ windiness: 0, braiding: 0, width: 12, widthGrowth: 0 });
    const region = regionFor(STRAIGHT, p);
    const bare = generateRiver(50, region, p, CONSTRAINTS);
    const coupled = generateRiver(50, region, p, withMountain(1000, 5600));
    expect(JSON.stringify(coupled)).toBe(JSON.stringify(bare));
  });

  it("coupled output is deterministic, keys on the mountain's persisted seed, and stays inside the corridor", () => {
    const p = MEANDER_P;
    const region = regionFor(STRAIGHT, p);
    const spine = makeSpine("river-test", STRAIGHT);
    const a = generateRiver(50, region, p, withMountain(1000, 5600));
    const b = generateRiver(50, region, p, withMountain(1000, 5600));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The mountain seed is a durable INPUT: a different seed re-shapes the
    // slope sample → a (deterministically) different meander.
    const other = generateRiver(50, region, p, {
      worldBounds: CONSTRAINTS.worldBounds,
      fabricFeatures: [mountainAt(1000, 5600, 778)],
    });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
    // Containment bound unchanged (amplitude only shrinks under coupling).
    const maxOffset = riverMaxOffset(p);
    for (const [x, y] of allCoords(a)) {
      expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(maxOffset + 1e-3);
    }
  });

  it("multi-segment: only mountain-overlapped segments change; far segments are byte-identical", () => {
    // Two segments: the first crosses the mountain, the second is far away.
    const twoSeg: Pt[] = [
      [0, 0],
      [3000, 0],
      [12000, 0],
    ];
    const p = PARAMS({ windiness: 0.8, width: 20, widthGrowth: 0, slopeSensitivity: 1 });
    const region = regionFor(twoSeg, p);
    const bare = generateRiver(50, region, p, CONSTRAINTS);
    const coupled = generateRiver(50, region, p, withMountain(500, 2500));
    // (segment-1 midpoint 1500 is inside; segment-2 midpoint 7500 samples an
    // exactly-zero gradient → multipliers exactly 1.)
    const seg2 = (feats: GeoJSON.Feature[]): string =>
      JSON.stringify(feats.filter((f) => allCoords([f]).every(([x]) => x >= 3100)));
    expect(seg2(coupled)).toBe(seg2(bare));
    expect(JSON.stringify(coupled)).not.toBe(JSON.stringify(bare));
  });
});

// ─── junctions, mouths, dressing ─────────────────────────────────────────────
// Confluences/deltas/estuaries are RELATIONSHIPS read from the RAW SKETCH LAYER
// (other river spines + water polygons on constraints.fabricFeatures — never
// another generator's output). Everything is APPENDED to the channel/meander
// output and verified inside the EXISTING corridor, so a lone plain river emits
// none of it (additive rule).

type FF = NonNullable<GenerationConstraints["fabricFeatures"]>[number];

/** A sketched partner river spine (a LineString) with a persisted width param. */
function partnerRiver(id: string, line: Pt[], width = 18): FF {
  return {
    type: "Feature",
    id,
    geometry: { type: "LineString", coordinates: line },
    properties: { kind: "river", procgen: { algorithm: "river", seed: 1, version: 1, params: { width } } },
  } as FF;
}

/** A sketched WATER polygon (the estuary mouth signal). */
function waterPoly(id: string, ring: Pt[]): FF {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "water" },
  } as FF;
}

/** A sketched alpine MOUNTAIN for slope-driven glyph classification. */
function steepMountain(id: string, ring: Pt[]): FF {
  return {
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      kind: "mountain",
      procgen: { algorithm: "mountain", seed: 5, version: 1, params: { terrain: "alpine", amplitude: 0.9, roughness: 0.5 } },
    },
  } as FF;
}

const withFabric = (feats: FF[]): GenerationConstraints => ({ worldBounds: CONSTRAINTS.worldBounds, fabricFeatures: feats });

/** Paired cross-section widths of a lozenge/ribbon polygon (main forward,
 * inner reversed) — the island-test idiom, reused for confluence/estuary. */
function crossWidths(f: GeoJSON.Feature): number[] {
  const open = openRing(f);
  const n = open.length / 2;
  const a = open.slice(0, n);
  const b = open.slice(n).reverse();
  const out: number[] = [];
  for (let j = 0; j < n; j++) out.push(dist(a[j], b[j]));
  return out;
}

describe("river generator — 28-C additive byte-identity (lone river == 28-B)", () => {
  // A lone river with windiness below DRESS_WINDINESS and no partner spine /
  // water polygon fires NO junction/dressing code path, so its output is pinned
  // and must stay stable. The canal fixture above pins windiness 0; this pins a
  // MEANDERING lone river.
  const LONE_065_SHA = "2b50749b8aa256a21be901408665915938aabe74962d6941d0983e02a9be9dbf";
  const p = PARAMS({ windiness: 0.65, braiding: 0, width: 20, widthGrowth: 0, braidBias: 0 });

  it("windiness 0.65, no constraints → byte-identical to the pinned 28-B output", () => {
    expect(p.windiness).toBeLessThan(DRESS_WINDINESS); // below the dressing gate
    const feats = generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS);
    expect(createHash("sha256").update(JSON.stringify(feats)).digest("hex")).toBe(LONE_065_SHA);
    // No junction/dressing feature types at all.
    for (const t of ["river-confluence", "river-distributary", "river-estuary", "river-point-bar", "river-oxbow", "river-glyph"]) {
      expect(byType(feats, t).length, `unexpected ${t}`).toBe(0);
    }
  });

  it("an unrelated mountain-only constraint set does not add 28-C features to a below-threshold river", () => {
    const bare = generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS);
    const withM = generateRiver(4242, regionFor(LINE, p), p, withFabric([steepMountain("m", [[400, -300], [800, -300], [800, 300], [400, 300], [400, -300]])]));
    // windiness < DRESS and slope-gated glyphs only where the reach is steep;
    // the reach barely clips the mountain, but any glyph must be slope-driven —
    // assert no dressing polygons appeared (point bars/oxbows are windiness-gated).
    expect(byType(withM, "river-point-bar").length).toBe(0);
    expect(byType(withM, "river-oxbow").length).toBe(0);
    // The channel/bank geometry is unchanged from bare except where slope
    // coupling bends it — but with slopeSensitivity default the meander adapts;
    // that is slope coupling, not dressing. Here just assert no
    // confluence/estuary/delta.
    for (const t of ["river-confluence", "river-distributary", "river-estuary"]) expect(byType(withM, t).length).toBe(0);
    void bare;
  });
});

describe("river generator — 28-C confluence Y-merge (plan 028 §1.4)", () => {
  // A partner river ends AT this river's mouth [1200,0], flowing off to the NE.
  const p = PARAMS({ windiness: 0.5, braiding: 0, width: 26, widthGrowth: 0.7, braidBias: 0 });
  const partner = partnerRiver("other", [[1200, 0], [1500, 300]], 18);
  const feats = generateRiver(4242, regionFor(LINE, p), p, withFabric([partner]));
  const gussets = byType(feats, "river-confluence");

  it("emits a confluence gusset at the shared mouth, and it stays inside the corridor", () => {
    expect(gussets.length).toBe(1);
    const spine = regionFor(LINE, p).spine!;
    const maxOffset = riverMaxOffset(p);
    for (const [x, y] of allCoords(gussets)) expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(maxOffset + 1e-3);
  });

  it("width law: the junction cross-section = √(W₁²+W₂²)", () => {
    const w1 = p.width * (1 + p.widthGrowth); // 2·halfWidthAt(f=1) — width at the mouth
    const w3 = Math.sqrt(w1 * w1 + 18 * 18);
    const widths = crossWidths(gussets[0]);
    // The gusset widens monotonically to W₃ at the junction (the widest pair).
    expect(Math.max(...widths)).toBeCloseTo(w3, 1);
  });

  it("no inland fork: a single merge polygon at the terminal endpoint, no branching channel", () => {
    // A confluence is a MERGE, never a fork: no distributary, and exactly one
    // channel ribbon per ORIGINAL segment (no extra forked channels inland).
    expect(byType(feats, "river-distributary").length).toBe(0);
    expect(byType(feats, "river-channel").length).toBe(LINE.length - 1);
    // Anchored at the terminal junction: the gusset touches the mouth vertex.
    const M: Pt = LINE[LINE.length - 1];
    let nearest = Infinity;
    for (const [x, y] of allCoords(gussets)) nearest = Math.min(nearest, dist([x, y], M));
    expect(nearest).toBeLessThanOrEqual(p.width * (1 + p.widthGrowth)); // ≤ a channel width of the junction
  });

  it("a partner beyond the snap radius is NOT a junction (byte-identical to no partner)", () => {
    const far = partnerRiver("far", [[1200 + CONFLUENCE_SNAP_M + 50, 0], [1500, 300]], 18);
    const a = generateRiver(4242, regionFor(LINE, p), p, withFabric([far]));
    const b = generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("river generator — 28-C delta distributaries (plan 028 §1.4)", () => {
  const p = PARAMS({ windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 1 });
  const feats = generateRiver(8, regionFor(LINE, p), p, CONSTRAINTS);
  const arms = byType(feats, "river-distributary");
  const M: Pt = LINE[LINE.length - 1];

  it("high braidBias on a LAND mouth emits exactly two bird's-foot arms, contained at the mouth", () => {
    expect(p.braidBias).toBeGreaterThanOrEqual(DELTA_BIAS_THRESHOLD);
    expect(arms.length).toBe(2);
    const maxOffset = riverMaxOffset(p);
    for (const [x, y] of allCoords(arms)) expect(dist([x, y], M)).toBeLessThanOrEqual(maxOffset);
  });

  it("distributary bifurcation angle ≈ 72° (Coffey & Rothman)", () => {
    const axisOf = (f: GeoJSON.Feature): number => {
      const open = openRing(f);
      const n = open.length / 2;
      const a = open.slice(0, n);
      const b = open.slice(n).reverse();
      const tip: Pt = [(a[n - 1][0] + b[n - 1][0]) / 2, (a[n - 1][1] + b[n - 1][1]) / 2];
      return Math.atan2(tip[1] - M[1], tip[0] - M[0]);
    };
    let deg = (Math.abs(axisOf(arms[0]) - axisOf(arms[1])) * 180) / Math.PI;
    if (deg > 180) deg = 360 - deg;
    expect(deg).toBeGreaterThanOrEqual(72 - 8);
    expect(deg).toBeLessThanOrEqual(72 + 8);
  });

  it("braidBias below the delta threshold emits no distributaries", () => {
    const q = PARAMS({ windiness: 0.5, braiding: 1, width: 22, widthGrowth: 1.2, braidBias: 0.5 });
    expect(byType(generateRiver(8, regionFor(LINE, q), q, CONSTRAINTS), "river-distributary").length).toBe(0);
  });
});

describe("river generator — 28-C estuary flare (plan 028 §1.4)", () => {
  const p = PARAMS({ windiness: 0.5, braiding: 1, width: 22, widthGrowth: 0.5, braidBias: 1 });
  // A water polygon straddling the mouth [1200,0] is the tidal-mouth signal.
  const sea = waterPoly("sea", [[1180, -220], [1700, -220], [1700, 220], [1180, 220], [1180, -220]]);
  const feats = generateRiver(8, regionFor(LINE, p), p, withFabric([sea]));
  const est = byType(feats, "river-estuary");

  it("a mouth at open water flares (estuary), and REPLACES the delta split", () => {
    expect(est.length).toBe(1);
    expect(byType(feats, "river-distributary").length).toBe(0); // estuary XOR delta
  });

  it("the flare widens monotonically toward the mouth (exponential flare)", () => {
    const widths = crossWidths(est[0]); // emission order: upstream → mouth → lip
    // Monotone non-decreasing; the tolerance absorbs mm-quantization jitter on
    // the flat trumpet lip (a real regression would dip by meters, not ≤2 mm).
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] - 0.01);
    // And the mouth is meaningfully wider than the base channel.
    expect(Math.max(...widths)).toBeGreaterThan(p.width * 1.5);
  });

  it("estuary stays inside the corridor", () => {
    const spine = regionFor(LINE, p).spine!;
    const maxOffset = riverMaxOffset(p);
    for (const [x, y] of allCoords(est)) expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(maxOffset + 1e-3);
  });
});

describe("river generator — 28-C dressing: point bars, oxbows, glyphs (plan 028 §1.4)", () => {
  it("windiness ≥ DRESS_WINDINESS emits point bars, oxbows and ford glyphs; a lowland river's glyphs are fords", () => {
    const p = PARAMS({ windiness: 0.85, braiding: 0, width: 26, widthGrowth: 0.3, braidBias: 0 });
    const feats = generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS);
    expect(byType(feats, "river-point-bar").length).toBeGreaterThan(0);
    expect(byType(feats, "river-oxbow").length).toBeGreaterThan(0);
    const glyphs = byType(feats, "river-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    // No mountains → slope 0 everywhere → every water symbol is a calm ford.
    for (const g of glyphs) expect((g.properties as { glyph?: string }).glyph).toBe("ford");
  });

  it("steep ground classifies the glyphs as rapids/falls (slope-driven), even below DRESS_WINDINESS", () => {
    // mountain-torrent params: slopeSensitivity 1 opts into terrain coupling
    // (default OFF as of river v2 / plan 035), the classifier the glyphs read.
    const p = PARAMS({ windiness: 0.15, braiding: 0, width: 8, widthGrowth: 0.2, braidBias: 0, slopeSensitivity: 1 });
    const mtn = steepMountain("m1", [[-500, -2000], [2000, -2000], [2000, 2000], [-500, 2000], [-500, -2000]]);
    const glyphs = byType(generateRiver(7, regionFor(LINE, p), p, withFabric([mtn])), "river-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    // Steep alpine relief → the whitewater symbols, never a calm ford.
    for (const g of glyphs) expect(["rapids", "falls"]).toContain((g.properties as { glyph?: string }).glyph);
  });

  it("all dressing stays inside the corridor and ids are integers (clip-stable)", () => {
    const p = PARAMS({ windiness: 0.9, braiding: 0, width: 24, widthGrowth: 0.4, braidBias: 0 });
    const feats = generateRiver(99, regionFor(LINE, p), p, CONSTRAINTS);
    const spine = regionFor(LINE, p).spine!;
    const maxOffset = riverMaxOffset(p);
    for (const f of feats) {
      expect(typeof f.id).toBe("number");
      for (const [x, y] of allCoords([f])) expect(distanceToSpine(spine, x, y)).toBeLessThanOrEqual(maxOffset + 1e-3);
    }
  });
});

describe("river generator — 28-C determinism + edit-locality (plan 028 §1.4)", () => {
  const p = PARAMS({ windiness: 0.85, braiding: 1, width: 22, widthGrowth: 0.8, braidBias: 1 });
  const partner = partnerRiver("trib", [[1200, 0], [1450, 260]], 16);
  const cons = withFabric([partner]);

  it("byte-identical across two runs with confluence + delta + dressing all live", () => {
    const region = regionFor(LINE, p);
    const a = generateRiver(321, region, p, cons);
    const b = generateRiver(321, region, p, cons);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // All three junction/dressing surfaces are present in this fixture.
    expect(byType(a, "river-confluence").length).toBe(1);
    expect(byType(a, "river-distributary").length).toBe(2);
    expect(byType(a, "river-point-bar").length + byType(a, "river-oxbow").length + byType(a, "river-glyph").length).toBeGreaterThan(0);
  });

  it("mouth features are keyed on the mouth: an EARLY-vertex edit leaves delta + dressing there byte-identical", () => {
    const base = generateRiver(321, regionFor(LINE, p), p, cons);
    // Move the FIRST vertex only — the mouth [1200,0] and its inflow tangent
    // (from [900,50]) are untouched, so the delta arms are byte-identical.
    const moved: Pt[] = [[20, -20], ...LINE.slice(1)];
    const edited = generateRiver(321, regionFor(moved, p), p, cons);
    const delta = (fs: GeoJSON.Feature[]): string => JSON.stringify(byType(fs, "river-distributary"));
    expect(delta(edited)).toBe(delta(base));
    const conf = (fs: GeoJSON.Feature[]): string => JSON.stringify(byType(fs, "river-confluence"));
    expect(conf(edited)).toBe(conf(base));
  });
});

describe("river generator — 28-C 2×2 seam with junction/dressing present", () => {
  it("clips deterministically and keeps every 28-C coordinate inside its tile", () => {
    const p = PARAMS({ windiness: 0.85, braiding: 1, width: 24, widthGrowth: 0.6, braidBias: 1 });
    const cons = withFabric([partnerRiver("t2", [[1200, 0], [1500, 280]], 18)]);
    const region = regionFor(LINE, p);
    const network = generateRiver(21, region, p, cons);
    // Sanity: the network actually carries junction/dressing features to clip.
    expect(byType(network, "river-distributary").length + byType(network, "river-confluence").length).toBeGreaterThan(0);
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

describe("river generator — metric bands (regression net)", () => {
  // The band is a tunable safety net: it survives a meander/width retune but
  // catches a channel gone dead-straight or a width collapsed/blown up. Measured
  // on the committed golden (seed 4242).
  it("golden fixture (windy + braided) lands inside its metric band", () => {
    const p = PARAMS({ windiness: 0.85, braiding: 0.6, width: 26, widthGrowth: 0.7, braidBias: 0.2 });
    const region = regionFor(LINE, p);
    const v = riverBandViolations(computeRiverMetrics(generateRiver(4242, region, p, CONSTRAINTS), region));
    expect(v, v.join("; ")).toEqual([]);
  });

  it("a wider channel param yields a larger mean channel width (same spine/seed)", () => {
    const wide = PARAMS({ width: 40, widthGrowth: 0 });
    const narrow = PARAMS({ width: 10, widthGrowth: 0 });
    const w = computeRiverMetrics(generateRiver(5, regionFor(LINE, wide), wide, CONSTRAINTS), regionFor(LINE, wide));
    const n = computeRiverMetrics(generateRiver(5, regionFor(LINE, narrow), narrow, CONSTRAINTS), regionFor(LINE, narrow));
    expect(w.meanChannelWidth).toBeGreaterThan(n.meanChannelWidth);
  });
});

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateRiver,
  riverMaxOffset,
  BASE_MEANDER_AMP_M,
  MIN_ISLAND_WIDTH_FRAC,
  MEANDER_WAVELENGTH_WIDTHS,
  RC_MIN_WIDTHS,
  type RiverParams,
} from "./river";
import { makeSpine, makeCorridorRegion, distanceToSpine, type ProcgenRegion } from "./region";
import type { GenerationConstraints } from "./types";
import { clipNetworkToTile } from "./citynet";
import { tileBBox, tileXYForPoint } from "./cache/tileGrid";

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
    const p = PARAMS({ windiness: 0.85, braiding: 0.6, width: 26, widthGrowth: 0.7, braidBias: 0.2 });
    expect(digest(generateRiver(4242, regionFor(LINE, p), p, CONSTRAINTS))).toMatchSnapshot();
  });

  it("matches the seeded snapshot fixture (delta — braid/island drift tripwire)", () => {
    // The windy+braided golden above carries no braids post-028 (its 26 m
    // channel can't afford a legible island — degradation ladder, plan 028
    // §1.3), so this second golden pins the braid + island emission path.
    const p = PARAMS({ windiness: 0.4, braiding: 1, width: 20, widthGrowth: 1, braidBias: 1 });
    const d = digest(generateRiver(8, regionFor(LINE, p), p, CONSTRAINTS));
    expect(d.summary["river-island"]).toBeGreaterThan(0);
    expect(d).toMatchSnapshot();
  });

  it("is byte-identical across two runs (same seed/region/params)", () => {
    const region = regionFor(LINE, PARAMS());
    const a = generateRiver(1234, region, PARAMS(), CONSTRAINTS);
    const b = generateRiver(1234, region, PARAMS(), CONSTRAINTS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
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
      const spine = region.spine!;
      const maxOffset = riverMaxOffset(preset.p);
      const feats = generateRiver(99, region, preset.p, CONSTRAINTS);
      expect(feats.length).toBeGreaterThan(0);
      let worst = 0;
      for (const [x, y] of allCoords(feats)) worst = Math.max(worst, distanceToSpine(spine, x, y));
      expect(worst).toBeLessThanOrEqual(maxOffset + 1e-3);
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

// ─── Plan 028 §1.1/§1.3 (box 28-A): channel-merge topology, bank casing,
// island legibility, canal regression ────────────────────────────────────────

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
  // Pre-028 fixture, captured from the last quad-chain build (commit 5dc9fe6):
  // the canal preset's 414 unique bank coordinates over LINE with seed 3. The
  // merge must not move a single bank sample — the bank casing lines carry
  // exactly the old outline, and the ribbons add ONLY the ≤2 weld vertices per
  // interior joint, each within JOINT_WELD_M of a pre-028 coordinate.
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

// ─── Plan 028 §1.2 (box 28-B): SGC/Kinoshita meander math — ratio defaults,
// per-bend jitter, upstream skew, R_c ≥ 2W realism clamp ─────────────────────

/** One long straight segment along +x: lateral offset IS the y coordinate,
 * there are no fillets, and the envelope is negligible mid-segment — the
 * cleanest window onto the bend train. */
const STRAIGHT: Pt[] = [
  [0, 0],
  [6600, 0],
];
const MEANDER_P = PARAMS({ windiness: 0.8, braiding: 0, width: 20, widthGrowth: 0 });

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

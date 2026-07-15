/**
 * Pure band-ghost geometry + descriptor tests (plan 040 Phase 2). No DOM/map —
 * the offset math, ring inset, grip anchors/normals, edge descriptors, and drag
 * value map are all pure functions verified directly.
 */
import { describe, it, expect } from "vitest";
import {
  offsetPolyline,
  insetRing,
  safeInsetDistance,
  polylineMidNormal,
  ringInsetNormal,
  bandEdges,
  bandValuesFromParams,
  bandParamFromOffset,
  offsetFromBandDrag,
  formatBandReadout,
  type Pt,
} from "./bandGhost";

const approx = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
/** Normalize signed-zero (a horizontal segment's normal is `[-0, 1]`) so the
 * geometry compares cleanly; −0 and 0 are the same point. */
const z = (pts: unknown): unknown =>
  Array.isArray(pts) ? pts.map(z) : typeof pts === "number" ? pts + 0 : pts;

describe("offsetPolyline", () => {
  it("offsets a horizontal line to the LEFT for +d (CCW normal is +y)", () => {
    const out = offsetPolyline([[0, 0], [10, 0]], 2);
    expect(z(out)).toEqual([[0, 2], [10, 2]]);
  });

  it("offsets to the RIGHT (−y) for −d — the mirror edge of a corridor", () => {
    const out = offsetPolyline([[0, 0], [10, 0]], -2);
    expect(z(out)).toEqual([[0, -2], [10, -2]]);
  });

  it("miters an L-corner so the offset stays parallel on both legs", () => {
    // Right angle at (10,0): leg east then north. +d offsets to the outside.
    const out = offsetPolyline([[0, 0], [10, 0], [10, 10]], 2);
    // Endpoints offset by their segment normals; the interior miter point sits
    // at the corner + the bisector at miter length √2.
    expect(z(out[0])).toEqual([0, 2]);
    expect(z(out[out.length - 1])).toEqual([8, 10]);
    const corner = out[1];
    expect(approx(corner[0], 8)).toBe(true);
    expect(approx(corner[1], 2)).toBe(true);
  });

  it("d===0 or a single point returns the input unchanged", () => {
    expect(offsetPolyline([[1, 1], [2, 2]], 0)).toEqual([[1, 1], [2, 2]]);
    expect(offsetPolyline([[1, 1]], 5)).toEqual([[1, 1]]);
  });

  it("is deterministic (same input ⇒ identical output)", () => {
    const line: Pt[] = [[0, 0], [3, 1], [6, -2], [9, 0]];
    expect(offsetPolyline(line, 1.5)).toEqual(offsetPolyline(line, 1.5));
  });
});

describe("insetRing", () => {
  it("insets a CCW square inward by d and returns a closed ring", () => {
    const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]; // CCW
    const out = insetRing(sq, 2);
    expect(out[0]).toEqual(out[out.length - 1]); // closed
    // Inner square corners pulled in by 2 on each axis.
    expect(out.slice(0, 4)).toEqual([[2, 2], [8, 2], [8, 8], [2, 8]]);
  });

  it("insets a CW square inward too (winding-agnostic)", () => {
    const cw: Pt[] = [[0, 0], [0, 10], [10, 10], [10, 0]]; // CW
    const out = insetRing(cw, 2);
    expect(out.slice(0, 4)).toEqual([[2, 2], [2, 8], [8, 8], [8, 2]]);
  });

  it("d<=0 returns the closed input", () => {
    const sq: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(insetRing(sq, 0)).toEqual([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]);
  });
});

describe("safeInsetDistance", () => {
  it("caps the inset at 45% of the smaller bbox half-extent so a ring never inverts", () => {
    const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]; // 10×10
    expect(safeInsetDistance(sq, 100)).toBeCloseTo(4.5, 9);
    expect(safeInsetDistance(sq, 3)).toBe(3); // under the cap ⇒ unchanged
  });
});

describe("polylineMidNormal", () => {
  it("returns the mid-segment midpoint + left normal (matches offsetPolyline's +side)", () => {
    const { anchor, normal } = polylineMidNormal([[0, 0], [10, 0]]);
    expect(anchor).toEqual([5, 0]);
    expect(z(normal)).toEqual([0, 1]); // +d side of a horizontal line
  });
});

describe("ringInsetNormal", () => {
  it("returns edge-0 midpoint + INWARD normal for a CCW ring", () => {
    const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]; // CCW; edge 0 bottom
    const { anchor, normal } = ringInsetNormal(sq);
    expect(anchor).toEqual([5, 0]);
    expect(z(normal)).toEqual([0, 1]); // inward = up, into the square
  });
});

describe("bandEdges", () => {
  it("relief → a halfWidth corridor edge + a fainter halfWidth+apron skirt edge", () => {
    const edges = bandEdges("relief", { halfWidth: 180, apron: 220 });
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ param: "halfWidth", offsetMeters: 180, faint: false });
    expect(edges[1]).toMatchObject({ param: "apron", offsetMeters: 400, faint: true, minOffset: 180 });
  });

  it("relief with no apron ⇒ the skirt edge coincides with the corridor (offset === halfWidth)", () => {
    const edges = bandEdges("relief", { halfWidth: 180 });
    expect(edges[1].offsetMeters).toBe(180);
  });

  it("landform → a single band ring edge", () => {
    const edges = bandEdges("landform", { band: 120 });
    expect(edges).toEqual([{ param: "band", offsetMeters: 120, minOffset: 0, maxOffset: 20000, faint: false }]);
  });

  it("other kinds ⇒ no band", () => {
    expect(bandEdges("district", {})).toEqual([]);
  });
});

describe("bandValuesFromParams", () => {
  it("relief carries halfWidth+apron; landform carries band", () => {
    expect(bandValuesFromParams("relief", { halfWidth: 200, apron: 50 })).toEqual({ halfWidth: 200, apron: 50 });
    expect(bandValuesFromParams("landform", { band: 90 })).toEqual({ band: 90 });
  });
  it("falls back to sane defaults when a param is missing", () => {
    expect(bandValuesFromParams("relief", {})).toEqual({ halfWidth: 180, apron: 0 });
    expect(bandValuesFromParams("landform", {})).toEqual({ band: 120 });
  });
});

describe("bandParamFromOffset", () => {
  it("halfWidth edge → the halfWidth param (min 1)", () => {
    expect(bandParamFromOffset("halfWidth", 250, 180)).toEqual({ key: "halfWidth", value: 250 });
    expect(bandParamFromOffset("halfWidth", 0, 180)).toEqual({ key: "halfWidth", value: 1 });
  });
  it("apron edge → offset − halfWidth (min 0)", () => {
    expect(bandParamFromOffset("apron", 400, 180)).toEqual({ key: "apron", value: 220 });
    expect(bandParamFromOffset("apron", 150, 180)).toEqual({ key: "apron", value: 0 }); // inside halfWidth ⇒ 0
  });
  it("band edge → the band param", () => {
    expect(bandParamFromOffset("band", 90, 0)).toEqual({ key: "band", value: 90 });
  });
});

describe("offsetFromBandDrag", () => {
  it("adds metres/pixel × pixels to the start offset, clamped + rounded", () => {
    expect(offsetFromBandDrag(180, 20, 5, 1, 20000)).toBe(280); // +100 m
    expect(offsetFromBandDrag(180, -100, 5, 1, 20000)).toBe(1); // clamps to min
    expect(offsetFromBandDrag(180, 1e9, 5, 1, 20000)).toBe(20000); // clamps to max
  });
});

describe("formatBandReadout", () => {
  it("labels each param and appends metres", () => {
    expect(formatBandReadout("halfWidth", 180)).toBe("width 180 m");
    expect(formatBandReadout("apron", 220)).toBe("apron 220 m");
    expect(formatBandReadout("band", 120)).toBe("band 120 m");
  });
});

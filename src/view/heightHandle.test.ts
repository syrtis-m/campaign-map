/**
 * Pure math for the drag-to-extrude height handle (plan 040 Phase 1). No map /
 * DOM — the screen-Y→metres map, param round-trip, readout, and type-to-refine
 * parser are all point-testable.
 */
import { describe, it, expect } from "vitest";
import {
  heightHandleDescriptor,
  valueFromDrag,
  heightParamsFromValue,
  formatHeightReadout,
  parseHeightInput,
  clampHeight,
  HEIGHT_HANDLE_LIMIT,
  riverDepthValues,
  clampDepthsMonotone,
  depthFromDrag,
  depthParamsFromValues,
  formatDepthReadout,
  DEPTH_HANDLE_MAX,
} from "./heightHandle";
import { riverCarveDepth } from "../gen/fields/terrain";

describe("heightHandleDescriptor", () => {
  it("relief folds polarity into a signed value (ridge +, valley -)", () => {
    expect(heightHandleDescriptor("relief", { height: 300, polarity: "ridge" })?.value).toBe(300);
    expect(heightHandleDescriptor("relief", { height: 200, polarity: "valley" })?.value).toBe(-200);
  });
  it("landform uses target, or a mode default when target is unset", () => {
    expect(heightHandleDescriptor("landform", { mode: "plateau", target: 450 })?.value).toBe(450);
    expect(heightHandleDescriptor("landform", { mode: "plateau" })?.value).toBe(300);
    expect(heightHandleDescriptor("landform", { mode: "basin" })?.value).toBe(-300);
    expect(heightHandleDescriptor("landform", { mode: "sea" })?.value).toBe(0);
  });
  it("returns null for kinds without a height handle", () => {
    expect(heightHandleDescriptor("road", {})).toBeNull();
    expect(heightHandleDescriptor("district", {})).toBeNull();
  });
});

describe("valueFromDrag", () => {
  it("drag up (positive dyUp) raises, down lowers; rounds to metres", () => {
    expect(valueFromDrag(300, 100, 12, -4000, 4000)).toBe(1500); // 300 + 100*12
    expect(valueFromDrag(300, -50, 12, -4000, 4000)).toBe(-300); // 300 - 600
  });
  it("clamps to bounds", () => {
    expect(valueFromDrag(0, 1000, 12, -4000, 4000)).toBe(4000);
    expect(valueFromDrag(0, -1000, 12, -4000, 4000)).toBe(-4000);
  });
});

describe("heightParamsFromValue", () => {
  it("relief: magnitude→height (>=1), sign→polarity", () => {
    expect(heightParamsFromValue("relief", 300)).toEqual({ height: 300, polarity: "ridge" });
    expect(heightParamsFromValue("relief", -200)).toEqual({ height: 200, polarity: "valley" });
    expect(heightParamsFromValue("relief", 0)).toEqual({ height: 1, polarity: "ridge" }); // never height 0
  });
  it("landform: → signed target", () => {
    expect(heightParamsFromValue("landform", -120)).toEqual({ target: -120 });
  });
});

describe("formatHeightReadout", () => {
  it("shows a sign + unit", () => {
    expect(formatHeightReadout(300)).toBe("+300 m");
    expect(formatHeightReadout(-120)).toBe("−120 m");
    expect(formatHeightReadout(0)).toBe("0 m");
  });
});

describe("parseHeightInput (type-to-refine, Phase 3)", () => {
  it("parses signed numbers, tolerates a trailing m and a unicode minus", () => {
    expect(parseHeightInput("450", -4000, 4000)).toBe(450);
    expect(parseHeightInput("-120 m", -4000, 4000)).toBe(-120);
    expect(parseHeightInput("−80", -4000, 4000)).toBe(-80);
  });
  it("clamps and rejects non-numbers", () => {
    expect(parseHeightInput("99999", -4000, 4000)).toBe(4000);
    expect(parseHeightInput("", -4000, 4000)).toBeNull();
    expect(parseHeightInput("abc", -4000, 4000)).toBeNull();
    expect(parseHeightInput("-", -4000, 4000)).toBeNull();
  });
});

describe("clampHeight / limit", () => {
  it("clamps", () => {
    expect(clampHeight(5000, -HEIGHT_HANDLE_LIMIT, HEIGHT_HANDLE_LIMIT)).toBe(4000);
    expect(clampHeight(-5000, -HEIGHT_HANDLE_LIMIT, HEIGHT_HANDLE_LIMIT)).toBe(-4000);
  });
});

describe("river depth grips (plan 040)", () => {
  it("riverDepthValues seeds each vertex from the uniform width-derived incision", () => {
    const u = riverCarveDepth(20);
    expect(riverDepthValues("river", { width: 20 }, 3)).toEqual([u, u, u]);
  });
  it("riverDepthValues honours a length-matched persisted array (clamped)", () => {
    expect(riverDepthValues("river", { width: 20, depths: [40, 90, 5000] }, 3)).toEqual([40, 90, DEPTH_HANDLE_MAX]);
  });
  it("riverDepthValues ignores a mismatched array (falls back to uniform)", () => {
    const u = riverCarveDepth(12);
    expect(riverDepthValues("river", { depths: [10, 20] }, 3)).toEqual([u, u, u]);
  });
  it("riverDepthValues is null for a non-river kind", () => {
    expect(riverDepthValues("relief", { width: 20 }, 3)).toBeNull();
    expect(riverDepthValues("river", { width: 20 }, 1)).toBeNull(); // needs ≥ 2 vertices
  });
  it("clampDepthsMonotone forces non-decreasing depth downstream (no uphill bed)", () => {
    expect(clampDepthsMonotone([90, 40, 200, 100])).toEqual([90, 90, 200, 200]);
    expect(clampDepthsMonotone([10, 20, 30])).toEqual([10, 20, 30]); // already OK
  });
  it("depthFromDrag deepens on a DOWNWARD drag, clamps to [0, MAX]", () => {
    expect(depthFromDrag(90, 100, 4)).toBe(490); // 90 + 100*4
    expect(depthFromDrag(90, -1000, 4)).toBe(0); // can't cut above ground
    expect(depthFromDrag(0, 100000, 4)).toBe(DEPTH_HANDLE_MAX);
  });
  it("depthParamsFromValues / formatDepthReadout", () => {
    expect(depthParamsFromValues([90, 120])).toEqual({ depths: [90, 120] });
    expect(formatDepthReadout(90)).toBe("↓ 90 m");
  });
});

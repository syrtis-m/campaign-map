/**
 * Unit tests for the elevation noise (plan 023 §1.1): analytic-derivative value
 * noise + gradient-damped fBm. The load-bearing check is the FINITE-DIFFERENCE
 * gradient verification — a snapshot proves the value is stable, only the FD
 * cross-check catches a wrong chain-rule / `1/cell` factor / sign flip in the
 * analytic derivative (the whole reason the derivative lands this phase).
 */
import { describe, expect, it } from "vitest";
import { valueNoise2DWithDeriv, fbmEroded } from "./elevation";

const SEED = 90210;

/** Centered finite difference of a scalar field at (x,y). */
function fd(f: (x: number, y: number) => number, x: number, y: number, e = 0.02): [number, number] {
  return [(f(x + e, y) - f(x - e, y)) / (2 * e), (f(x, y + e) - f(x, y - e)) / (2 * e)];
}

/** Points chosen to avoid the ridged kink (v ≈ 0.5) and lattice corners. */
const PTS: [number, number][] = [
  [12.5, -7.25],
  [133.7, 88.1],
  [-311.2, 47.9],
  [512.4, -623.6],
];

describe("valueNoise2DWithDeriv — analytic gradient matches finite difference", () => {
  const cell = 180;
  it("dx/dy agree with a centered finite difference (tight)", () => {
    for (const [x, y] of PTS) {
      const s = valueNoise2DWithDeriv(SEED, x, y, cell, "t");
      const [gx, gy] = fd((px, py) => valueNoise2DWithDeriv(SEED, px, py, cell, "t").v, x, y);
      expect(s.dx).toBeCloseTo(gx, 4);
      expect(s.dy).toBeCloseTo(gy, 4);
    }
  });

  it("value is in [0,1) and continuous across a cell boundary (quintic ease)", () => {
    for (const [x, y] of PTS) {
      const v = valueNoise2DWithDeriv(SEED, x, y, cell, "t").v;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // Straddle an integer cell boundary: value + derivative are continuous
    // (quintic → C1), so the two one-sided samples nearly coincide.
    const left = valueNoise2DWithDeriv(SEED, cell - 1e-4, 30, cell, "t");
    const right = valueNoise2DWithDeriv(SEED, cell + 1e-4, 30, cell, "t");
    expect(right.v).toBeCloseTo(left.v, 5);
    expect(right.dx).toBeCloseTo(left.dx, 3);
  });

  it("is a pure function of position (seam-safe: identical sample anywhere, any call)", () => {
    for (const [x, y] of PTS) {
      const a = valueNoise2DWithDeriv(SEED, x, y, cell, "t");
      const b = valueNoise2DWithDeriv(SEED, x, y, cell, "t");
      expect(a).toEqual(b);
    }
  });
});

describe("fbmEroded — gradient (exact at damping 0) matches finite difference", () => {
  it("dx/dy agree with a finite difference when damping = 0 (plain fBm, exact)", () => {
    const opts = { octaves: 4, damping: 0, ridged: false, baseCell: 240, salt: "e" };
    for (const [x, y] of PTS) {
      const s = fbmEroded(SEED, x, y, opts);
      const [gx, gy] = fd((px, py) => fbmEroded(SEED, px, py, opts).v, x, y);
      expect(s.dx).toBeCloseTo(gx, 4);
      expect(s.dy).toBeCloseTo(gy, 4);
    }
  });

  it("damped gradient still points roughly downslope (direction agrees with FD)", () => {
    const opts = { octaves: 5, damping: 0.6, ridged: true, baseCell: 240, salt: "e" };
    let agree = 0;
    for (const [x, y] of PTS) {
      const s = fbmEroded(SEED, x, y, opts);
      const [gx, gy] = fd((px, py) => fbmEroded(SEED, px, py, opts).v, x, y);
      const la = Math.hypot(s.dx, s.dy) || 1;
      const lb = Math.hypot(gx, gy) || 1;
      const dot = (s.dx * gx + s.dy * gy) / (la * lb);
      if (dot > 0.6) agree++;
    }
    // The frozen-damp approximation keeps the reported gradient aligned with the
    // true slope direction (adequate for hachure orientation).
    expect(agree).toBeGreaterThanOrEqual(PTS.length - 1);
  });

  it("value stays in ~[0,1]; ridged transform keeps the range bounded", () => {
    for (const ridged of [false, true]) {
      for (const [x, y] of PTS) {
        const v = fbmEroded(SEED, x, y, { octaves: 5, damping: 0.4, ridged, baseCell: 200, salt: "e" }).v;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it("is byte-identical across two calls (determinism, D-rules)", () => {
    const opts = { octaves: 4, damping: 0.5, ridged: true, baseCell: 300, salt: "e" };
    for (const [x, y] of PTS) {
      expect(fbmEroded(SEED, x, y, opts)).toEqual(fbmEroded(SEED, x, y, opts));
    }
    // A different seed changes the field.
    expect(fbmEroded(SEED, PTS[0][0], PTS[0][1], opts).v).not.toBe(
      fbmEroded(SEED + 1, PTS[0][0], PTS[0][1], opts).v
    );
  });
});

/**
 * Wall metrics — a PURE measurement pass over `generateWall` output: how far
 * apart the towers march along the curtain, and how many gates pierce it. Reads
 * features + region only; never generates, never mutates → zero generator bytes
 * touched.
 *
 * `WALL_BAND` is the tunable regression net (versioned-determinism policy): a
 * generous window around the committed golden, catching towers or gates that
 * vanish without pinning exact bytes. A wall region is always a spine corridor,
 * so `region.spine` supplies the run length the tower spacing divides.
 */
import type { ProcgenRegion } from "./region";
import { byGid, inBand } from "./metricsGeom";

export interface WallMetrics {
  /** Mean along-run spacing between towers (m) = spine length ÷ tower count. */
  meanTowerSpacing: number;
  /** Towers (bastions / mural towers). */
  towerCount: number;
  /** Gates where a sketched road crosses the wall. */
  gateCount: number;

  spineLength: number;
}

export interface WallBand {
  meanTowerSpacing: [number, number];
  towerCount: [number, number];
  gateCount: [number, number];
}

/** Band measured on the committed golden (bastioned + moat, towerSpacing 90,
 * one road crossing, seed 4242): spacing ≈ 81 m, towers = 20, gates = 1. */
export const WALL_BAND: WallBand = {
  meanTowerSpacing: [40, 140],
  towerCount: [8, 40],
  gateCount: [1, 3],
};

export function computeWallMetrics(features: GeoJSON.Feature[], region: ProcgenRegion): WallMetrics {
  const towerCount = byGid(features, "wall-tower").length;
  const gateCount = byGid(features, "wall-gate").length;
  const spineLength = region.spine?.totalLen ?? 0;

  return {
    meanTowerSpacing: towerCount > 0 ? spineLength / towerCount : 0,
    towerCount,
    gateCount,
    spineLength,
  };
}

/** Every metric of `m` outside `band` (empty ⇒ all pass). */
export function wallBandViolations(m: WallMetrics, band: WallBand = WALL_BAND): string[] {
  const out: string[] = [];
  const chk = (name: string, v: number, b: [number, number]): void => {
    if (!inBand(v, b)) out.push(`${name} ${v.toFixed(2)} ∉ [${b[0]}, ${b[1]}]`);
  };
  chk("meanTowerSpacing", m.meanTowerSpacing, band.meanTowerSpacing);
  chk("towerCount", m.towerCount, band.towerCount);
  chk("gateCount", m.gateCount, band.gateCount);
  return out;
}

/**
 * Headless twin for the stacked-fabric click resolver (Jonah 2026-07-15 — "I
 * can only select the underlying plateau"). The resolver is pure, so unlike the
 * SketchController tests it needs no mock map at all — it drives the real
 * ordering + cycling functions directly, the same decisions MapView.pickFabric-
 * ForSelect feeds them from a live queryRenderedFeatures box.
 *
 * Fixtures mirror the reported stacks: farmland-on-landform (detail region over
 * a huge terrain stamp) and park-in-district (small polygon inside a big one,
 * neither terrain).
 */
import { describe, it, expect } from "vitest";
import {
  orderFabricCandidates,
  resolveFabricClick,
  isTerrainStamp,
  type FabricCandidate,
  type FabricCycleState,
} from "./fabricSelect";
import type { FabricKind } from "../model/fabric";

function cand(id: string, kind: FabricKind, area: number, rank = 0): FabricCandidate {
  return { id, kind, area, rank };
}

const P = { x: 100, y: 100 };

/** Simulate N select-clicks at the same spot over the same stack, returning the
 * id picked on each click (the farmland → plateau cycle). */
function clickSequence(cands: FabricCandidate[], n: number, point = P): string[] {
  let state: FabricCycleState | null = null;
  const picks: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = resolveFabricClick(cands, point, state);
    state = r.state;
    picks.push(r.id ?? "<none>");
  }
  return picks;
}

describe("fabricSelect — ordering (topmost detail; terrain sinks)", () => {
  it("farmland-on-landform: the small farmland outranks the huge plateau stamp", () => {
    const cands = [cand("plateau", "landform", 100000, 0), cand("farm", "farmland", 400, 1)];
    expect(orderFabricCandidates(cands).map((c) => c.id)).toEqual(["farm", "plateau"]);
  });

  it("park-in-district: smaller ring area wins (both non-terrain)", () => {
    const cands = [cand("district", "district", 50000, 0), cand("park", "park", 900, 1)];
    expect(orderFabricCandidates(cands).map((c) => c.id)).toEqual(["park", "district"]);
  });

  it("kind-tier tiebreak: on an equal area, the terrain stamp sinks below other kinds", () => {
    const cands = [cand("stamp", "landform", 1000, 0), cand("field", "farmland", 1000, 1)];
    expect(orderFabricCandidates(cands).map((c) => c.id)).toEqual(["field", "stamp"]);
  });

  it("line kinds keep their proximity precedence, ahead of every polygon fill", () => {
    const cands = [
      cand("plateau", "landform", 100000, 0),
      cand("road", "road", 0, 1),
      cand("farm", "farmland", 400, 2),
    ];
    // Road first (line, as-is), then farmland (small), then the plateau beneath.
    expect(orderFabricCandidates(cands).map((c) => c.id)).toEqual(["road", "farm", "plateau"]);
  });

  it("isTerrainStamp flags landform / mountain / relief only", () => {
    expect(isTerrainStamp("landform")).toBe(true);
    expect(isTerrainStamp("mountain")).toBe(true);
    expect(isTerrainStamp("relief")).toBe(true);
    expect(isTerrainStamp("farmland")).toBe(false);
    expect(isTerrainStamp("district")).toBe(false);
  });
});

describe("fabricSelect — repeated-click cycling", () => {
  it("farmland-on-landform: first click = farmland, second = plateau, then cycles", () => {
    const cands = [cand("plateau", "landform", 100000, 0), cand("farm", "farmland", 400, 1)];
    expect(clickSequence(cands, 4)).toEqual(["farm", "plateau", "farm", "plateau"]);
  });

  it("park-in-district: first click = park, second = district", () => {
    const cands = [cand("district", "district", 50000, 0), cand("park", "park", 900, 1)];
    expect(clickSequence(cands, 3)).toEqual(["park", "district", "park"]);
  });

  it("a click at a different spot resets the cycle to the topmost detail", () => {
    const cands = [cand("plateau", "landform", 100000, 0), cand("farm", "farmland", 400, 1)];
    const first = resolveFabricClick(cands, P, null);
    expect(first.id).toBe("farm");
    // Move well outside the same-spot tolerance: back to index 0 (farm), not plateau.
    const moved = resolveFabricClick(cands, { x: P.x + 40, y: P.y }, first.state);
    expect(moved.id).toBe("farm");
  });

  it("a click over a DIFFERENT stack at the same spot resets the cycle", () => {
    const stackA = [cand("plateau", "landform", 100000, 0), cand("farm", "farmland", 400, 1)];
    const first = resolveFabricClick(stackA, P, null);
    expect(first.id).toBe("farm");
    const stackB = [cand("lake", "water", 8000, 0), cand("grove", "forest", 300, 1)];
    const second = resolveFabricClick(stackB, P, first.state);
    expect(second.id).toBe("grove"); // topmost detail of the new stack, not index 1
  });
});

describe("fabricSelect — single-feature clicks (no regression)", () => {
  it("a lone candidate is always selected, repeated clicks stay on it", () => {
    const cands = [cand("solo", "district", 5000, 0)];
    expect(clickSequence(cands, 3)).toEqual(["solo", "solo", "solo"]);
  });

  it("no candidates resolves to null (empty ground → caller deselects)", () => {
    const r = resolveFabricClick([], P, null);
    expect(r.id).toBeNull();
    expect(r.state).toBeNull();
  });
});

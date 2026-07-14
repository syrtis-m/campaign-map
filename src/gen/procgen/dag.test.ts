import { describe, it, expect } from "vitest";
import {
  cascadeOrder,
  hasEdge,
  downstreamEdges,
  upstreamEdges,
  downstreamClosure,
  assertAcyclic,
  type DagNode,
} from "./dag";
import type { BBox } from "../spatialHash";

const box = (minX: number, minY: number, maxX: number, maxY: number): BBox => ({ minX, minY, maxX, maxY });

/** A little world: mountain (0) → river (1) → city (3); a forest (2) → city (3).
 * All overlapping a shared region. `farm` (2) consumes elevation, overlaps the
 * mountain; a `far` mountain overlaps nothing. */
function world(): DagNode[] {
  return [
    { id: "mtn", stage: 0, produces: ["elevation"], consumes: [], bbox: box(0, 0, 100, 100) },
    { id: "river", stage: 1, produces: ["water"], consumes: ["elevation"], bbox: box(50, 50, 150, 150) },
    { id: "forest", stage: 2, produces: ["vegetation"], consumes: ["water"], bbox: box(60, 60, 160, 160) },
    { id: "farm", stage: 2, produces: [], consumes: ["elevation"], bbox: box(10, 10, 90, 90) },
    { id: "city", stage: 3, produces: ["settlement"], consumes: ["water", "vegetation"], bbox: box(70, 70, 170, 170) },
    { id: "far", stage: 0, produces: ["elevation"], consumes: [], bbox: box(900, 900, 1000, 1000) },
  ];
}

describe("dag — cascadeOrder", () => {
  it("is (stage, id) lexicographic and order-independent (determinism, D2)", () => {
    const nodes = world();
    const a = cascadeOrder(nodes).map((n) => n.id);
    const b = cascadeOrder([...nodes].reverse()).map((n) => n.id);
    const c = cascadeOrder([...nodes].sort(() => 0.5 - Math.random())).map((n) => n.id);
    // mtn/far are stage 0 (id order: far < mtn), then river(1), farm/forest(2, id order), city(3).
    expect(a).toEqual(["far", "mtn", "river", "farm", "forest", "city"]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("does not mutate its input", () => {
    const nodes = world();
    const snapshot = nodes.map((n) => n.id);
    cascadeOrder(nodes);
    expect(nodes.map((n) => n.id)).toEqual(snapshot);
  });
});

describe("dag — edge rule (§3-refined: stage + produces∩consumes + bbox)", () => {
  const nodes = world();
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const margin = 0;

  it("A→B needs strictly ascending stage", () => {
    expect(hasEdge(byId.river, byId.mtn, margin)).toBe(false); // 1 → 0 rejected
    expect(hasEdge(byId.mtn, byId.river, margin)).toBe(true); // 0 → 1
  });

  it("same-stage regions never edge (no cycle, no ambiguity)", () => {
    expect(hasEdge(byId.forest, byId.farm, margin)).toBe(false);
    expect(hasEdge(byId.farm, byId.forest, margin)).toBe(false);
  });

  it("needs produces(A) ∩ consumes(B) ≠ ∅ — a city is NOT a dependent of a mountain", () => {
    // mountain produces elevation; city consumes water+vegetation (not elevation),
    // even though stage 0<3 and bboxes overlap. This is the crisp non-dependent.
    expect(hasEdge(byId.mtn, byId.city, margin)).toBe(false);
    // river produces water; city consumes water → edge.
    expect(hasEdge(byId.river, byId.city, margin)).toBe(true);
  });

  it("needs bbox overlap (within margin)", () => {
    // far & river couple by field (elevation) but are geographically disjoint.
    expect(hasEdge(byId.far, byId.river, margin)).toBe(false); // disjoint bbox
    expect(hasEdge(byId.far, byId.river, 200)).toBe(false); // 200 margin still doesn't reach ~750m away
  });

  it("margin can bridge a near-miss when the fields couple", () => {
    const a: DagNode = { id: "a", stage: 0, produces: ["elevation"], consumes: [], bbox: box(0, 0, 10, 10) };
    const b: DagNode = { id: "b", stage: 1, produces: ["water"], consumes: ["elevation"], bbox: box(30, 0, 40, 10) };
    expect(hasEdge(a, b, 10)).toBe(false); // gap 20 > margin 10
    expect(hasEdge(a, b, 25)).toBe(true); // margin closes the gap
  });
});

describe("dag — up/downstream adjacency", () => {
  const nodes = world();

  it("downstreamEdges is deterministic + sorted, invariant to input order", () => {
    const d1 = downstreamEdges(nodes, 0);
    const d2 = downstreamEdges([...nodes].reverse(), 0);
    expect([...d1.entries()]).toEqual([...d2.entries()]);
    // Downstream lists are in cascadeOrder (stage, id) — the order the cascade
    // must regenerate them in.
    expect(d1.get("mtn")).toEqual(["river", "farm"]); // river(1) before farm(2)
    expect(d1.get("river")).toEqual(["forest", "city"]); // forest(2) before city(3)
    expect(d1.get("far")).toEqual([]); // disjoint
    expect(d1.get("city")).toEqual([]); // terminal
  });

  it("upstreamEdges mirrors it", () => {
    const u = upstreamEdges(nodes, 0);
    expect(u.get("river")).toEqual(["mtn"]);
    expect(u.get("farm")).toEqual(["mtn"]);
    expect(u.get("city")).toEqual(["river", "forest"]); // sorted
    expect(u.get("mtn")).toEqual([]);
  });
});

describe("dag — downstreamClosure (the cascade worklist)", () => {
  const nodes = world();

  it("is transitive, in cascadeOrder, excludes the roots", () => {
    // Editing the mountain: river (elevation) + farm (elevation) directly; then
    // river's downstream (forest, city) transitively. The city is reached via
    // the river (water), NOT the mountain directly (mountain→city has no edge).
    const closure = downstreamClosure(nodes, 0, ["mtn"]).map((n) => n.id);
    expect(closure).toEqual(["river", "farm", "forest", "city"]); // (stage,id) order
    expect(closure).not.toContain("mtn"); // root excluded
    expect(closure).not.toContain("far");
  });

  it("a stage-3 city edit cascades to nothing lower (no back-edges)", () => {
    expect(downstreamClosure(nodes, 0, ["city"]).map((n) => n.id)).toEqual([]);
  });

  it("multiple roots union without duplication", () => {
    const closure = downstreamClosure(nodes, 0, ["river", "forest"]).map((n) => n.id);
    expect(closure).toEqual(["city"]); // both feed the city; once only
  });
});

describe("dag — cycle prevention + detection", () => {
  it("computeEdges never yields a cycle for any node set (prevention by construction)", () => {
    const nodes = world();
    // assertAcyclic over the real adjacency is a no-op (proves the invariant).
    expect(() => assertAcyclic(downstreamEdges(nodes, 200))).not.toThrow();
  });

  it("assertAcyclic THROWS on a hand-built back edge (detection)", () => {
    const cyclic = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]], // back edge
    ]);
    expect(() => assertAcyclic(cyclic)).toThrow(/cycle/);
  });

  it("assertAcyclic passes a diamond (shared downstream is not a cycle)", () => {
    const diamond = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
      ["d", []],
    ]);
    expect(() => assertAcyclic(diamond)).not.toThrow();
  });
});

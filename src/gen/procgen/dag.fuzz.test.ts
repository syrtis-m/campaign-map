/**
 * Cascade determinism fuzz: the cross-layer cascade order MUST be a pure
 * function of the node SET, never of the order regions were enumerated / edited
 * (cascade order must be deterministic, never Map-iteration order). Randomizes
 * node sets + input permutations +
 * edit-root permutations and asserts the DAG outputs are permutation-invariant,
 * cycle-free, and stage-monotone. Slow tier (`npm run test:fuzz`).
 */
import { describe, it, expect } from "vitest";
import {
  cascadeOrder,
  downstreamEdges,
  upstreamEdges,
  downstreamClosure,
  assertAcyclic,
  type DagNode,
  type Stage,
  type ConstraintKind,
} from "./dag";
import { mulberry32 } from "../rng";
import type { BBox } from "../spatialHash";

const KINDS: ConstraintKind[] = ["elevation", "water", "vegetation", "settlement", "detail"];
// The registry's real stage→field wiring, so fuzz nodes resemble real worlds.
const STAGE_PRODUCES: Record<Stage, ConstraintKind[]> = {
  0: ["elevation"],
  1: ["water"],
  2: ["vegetation"],
  3: ["settlement"],
  4: ["detail"],
};

function shuffle<T>(arr: readonly T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomWorld(seed: number): DagNode[] {
  const rnd = mulberry32(seed);
  const n = 2 + Math.floor(rnd() * 12);
  const nodes: DagNode[] = [];
  for (let i = 0; i < n; i++) {
    const stage = Math.floor(rnd() * 5) as Stage;
    // A node consumes 0–2 random field kinds (may include ones nothing at a
    // lower stage produces — a harmless no-edge).
    const consumeCount = Math.floor(rnd() * 3);
    const consumes: ConstraintKind[] = [];
    for (let c = 0; c < consumeCount; c++) consumes.push(KINDS[Math.floor(rnd() * KINDS.length)]);
    const cx = Math.floor(rnd() * 2000) - 1000;
    const cy = Math.floor(rnd() * 2000) - 1000;
    const r = 50 + Math.floor(rnd() * 300);
    const bbox: BBox = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
    nodes.push({ id: `r${String(i).padStart(2, "0")}`, stage, produces: STAGE_PRODUCES[stage], consumes, bbox });
  }
  return nodes;
}

describe("dag fuzz — cascade order is permutation-invariant + cycle-free", () => {
  it("100 random worlds: order/edges/closure identical under input shuffles; always acyclic + stage-monotone", () => {
    for (let s = 1; s <= 100; s++) {
      const nodes = randomWorld(s * 2654435761);
      const rnd = mulberry32(s);
      const margin = Math.floor(rnd() * 400);

      const orderRef = cascadeOrder(nodes).map((n) => n.id);
      const downRef = [...downstreamEdges(nodes, margin).entries()];
      const upRef = [...upstreamEdges(nodes, margin).entries()];

      // Three independent input permutations must yield byte-identical outputs.
      for (let p = 0; p < 3; p++) {
        const permuted = shuffle(nodes, mulberry32(s * 31 + p + 1));
        expect(cascadeOrder(permuted).map((n) => n.id)).toEqual(orderRef);
        expect([...downstreamEdges(permuted, margin).entries()]).toEqual(downRef);
        expect([...upstreamEdges(permuted, margin).entries()]).toEqual(upRef);
      }

      // Edges are strictly stage-ascending → acyclic + stage-monotone.
      const adjacency = downstreamEdges(nodes, margin);
      expect(() => assertAcyclic(adjacency)).not.toThrow();
      const stageOf = new Map(nodes.map((n) => [n.id, n.stage]));
      for (const [from, tos] of adjacency) {
        for (const to of tos) expect(stageOf.get(from)!).toBeLessThan(stageOf.get(to)!);
      }

      // Downstream closure is invariant to the order the edit roots are given,
      // and always returned in cascadeOrder (the deterministic replay sequence).
      const roots = shuffle(nodes, mulberry32(s * 7 + 3)).slice(0, 1 + Math.floor(rnd() * 2)).map((n) => n.id);
      const closureRef = downstreamClosure(nodes, margin, roots).map((n) => n.id);
      const closurePerm = downstreamClosure(nodes, margin, shuffle(roots, mulberry32(s * 13 + 5))).map((n) => n.id);
      expect(closurePerm).toEqual(closureRef);
      // In cascadeOrder: stage non-decreasing along the worklist.
      const closureStages = closureRef.map((id) => stageOf.get(id)!);
      for (let i = 1; i < closureStages.length; i++) expect(closureStages[i]).toBeGreaterThanOrEqual(closureStages[i - 1]);
      // Roots never appear in their own downstream closure (cycle-free).
      for (const root of roots) expect(closureRef).not.toContain(root);
    }
  });
});

/**
 * Worker-boundary round-trip for line-kind (river/wall) regions (plan 031-D).
 *
 * A real Web Worker can't spin in Vitest, so the worker's reconstruct-and-run
 * core is a pure, exported function (`reconstructJobRegion`) that both
 * `self.onmessage` and this test call. We build a corridor region on the "main
 * thread", serialize its job payload (JSON round-trip = the structured-clone
 * boundary), reconstruct it worker-side from the spine, and assert the generated
 * bytes are IDENTICAL to the retained main-thread fallback — so moving rivers
 * into the worker never changes output.
 */
import { describe, it, expect } from "vitest";
import { reconstructJobRegion, handleWorkerMessage } from "./generationWorker";
import { algorithmById } from "../procgen/registry";
import { makeSpine, makeCorridorRegion, makeRegion } from "../region";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";

const WORLD_BOUNDS: BBox = { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 };
const constraints: GenerationConstraints = { worldBounds: WORLD_BOUNDS, canonFeatures: [] };

// A kinked river spine in gen-space meters, well inside bounds.
const RIVER_SPINE_M: [number, number][] = [
  [300, -1500],
  [900, -900],
  [300, -300],
  [900, 300],
];
const RIVER_PARAMS = { windiness: 0.85, braiding: 0.5, width: 26, widthGrowth: 0.7, braidBias: 0.2 };

describe("generationWorker — line-kind spine crosses the worker boundary (031-D)", () => {
  it("reconstructs a river corridor from its spine and produces byte-identical output vs the main-thread fallback", () => {
    const algorithm = algorithmById("river")!;
    const seed = 987654;

    // Main-thread fallback: build the corridor region directly, run the generator.
    const mainRegion = makeCorridorRegion("river-1", makeSpine("river-1", RIVER_SPINE_M), algorithm.corridorMaxOffset!(RIVER_PARAMS));
    const expected = algorithm.generate(seed, mainRegion, RIVER_PARAMS, constraints);
    expect(expected.length).toBeGreaterThan(0);

    // Worker path: serialize the job payload across the structured-clone boundary
    // (JSON round-trip), then reconstruct from the spine and run the generator.
    const job = JSON.parse(
      JSON.stringify({ ring: mainRegion.ring, spine: mainRegion.spine!.points, params: RIVER_PARAMS })
    ) as { ring: [number, number][]; spine: [number, number][]; params: Record<string, unknown> };
    const workerRegion = reconstructJobRegion(algorithm, "river-1", job.ring, job.spine, job.params);
    const actual = algorithm.generate(seed, workerRegion, job.params, constraints);

    // The reconstructed corridor equals the main-thread one, and so does its output.
    expect(workerRegion.spine?.points).toEqual(mainRegion.spine?.points);
    expect(workerRegion.corridorMaxOffset).toBe(mainRegion.corridorMaxOffset);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));

    // Same result through the FULL worker dispatch (the exact path onmessage runs).
    const response = handleWorkerMessage({
      kind: "procgen-region",
      requestId: 1,
      algorithmId: "river",
      seed,
      regionId: "river-1",
      ring: job.ring,
      spine: job.spine,
      params: job.params,
      constraints,
    });
    expect(response.error).toBeUndefined();
    expect(JSON.stringify(response.features)).toBe(JSON.stringify(expected));
  });

  it("reconstructs a wall corridor from its spine byte-identically (line-kind, second consumer)", () => {
    const algorithm = algorithmById("wall")!;
    const seed = 424242;
    const params = algorithm.defaultParams("obsidian-native");
    const spineM: [number, number][] = [
      [-600, -600],
      [-200, -600],
      [-200, -200],
    ];
    const mainRegion = makeCorridorRegion("wall-1", makeSpine("wall-1", spineM), algorithm.corridorMaxOffset!(params));
    const expected = algorithm.generate(seed, mainRegion, params, constraints);

    const job = JSON.parse(JSON.stringify({ spine: mainRegion.spine!.points, ring: mainRegion.ring, params })) as {
      ring: [number, number][];
      spine: [number, number][];
      params: Record<string, unknown>;
    };
    const workerRegion = reconstructJobRegion(algorithm, "wall-1", job.ring, job.spine, job.params);
    const actual = algorithm.generate(seed, workerRegion, job.params, constraints);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it("a polygon job (no spine) still rebuilds from the ring", () => {
    const algorithm = algorithmById("forest")!;
    const params = { variety: "mixed", density: 0.6, clearings: 0.2, edgeRaggedness: 0.5 };
    const ringM: [number, number][] = [
      [-400, -400],
      [400, -400],
      [400, 400],
      [-400, 400],
      [-400, -400],
    ];
    const seed = 111;
    const direct = algorithm.generate(seed, makeRegion("forest-1", ringM), params, constraints);
    const region = reconstructJobRegion(algorithm, "forest-1", ringM, undefined, params);
    const viaJob = algorithm.generate(seed, region, params, constraints);
    expect(JSON.stringify(viaJob)).toBe(JSON.stringify(direct));
    expect(region.spine).toBeUndefined();
  });

  it("throws if a polygon-kind algorithm is handed a spine (protocol corruption fails loudly)", () => {
    const city = algorithmById("city")!;
    expect(() => reconstructJobRegion(city, "x", [], [[0, 0], [10, 10]], { profile: "euro-medieval" })).toThrow(
      /not a line-kind generator/
    );
  });

  it("rejects a malformed spine payload at the boundary (zod)", () => {
    const river = algorithmById("river")!;
    expect(() =>
      reconstructJobRegion(river, "x", [], [[0, 0], [1] as unknown as [number, number]], RIVER_PARAMS)
    ).toThrow();
  });
});

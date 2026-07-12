/**
 * Web Worker entry point (docs/02 §5: "Generation runs in a Web Worker...
 * so the map tab never stutters"). Dispatches tile-generation requests to
 * the pure generators in src/gen/ — this file is the ONLY thing in src/gen/
 * that isn't itself host-agnostic (it uses postMessage/self), which is why
 * it lives in its own worker/ subfolder rather than alongside the generators.
 */
import { generateWorldRegions, generateSettlements, generateRoutes } from "../world";
import { algorithmById } from "../procgen/registry";
import { makeRegion } from "../region";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";

/** World-tier generators are per-tile; city-tier generation is region-scoped
 * (plan 020) — the whole-region network is the one expensive job that must
 * run off-thread, dispatched via the procgen registry. */
export type GeneratorId = "world-region" | "world-settlement" | "world-route";

const GENERATORS: Record<GeneratorId, (seed: number, bbox: BBox, c: GenerationConstraints) => GeoJSON.Feature[]> = {
  "world-region": generateWorldRegions,
  "world-settlement": generateSettlements,
  "world-route": generateRoutes,
};

type Pt = [number, number];

/** A whole-region procgen job (plan 020 §5). The worker resolves the
 * algorithm from the registry, rebuilds the region from its ring, and runs
 * the pure generator — `seed`/`params` come from the region's persisted
 * procgen block, so identity is durable data, never derived at run time. */
export interface ProcgenRegionJob {
  kind: "procgen-region";
  requestId: number;
  algorithmId: string;
  seed: number;
  regionId: string;
  ring: Pt[];
  params: Record<string, unknown>;
  constraints: GenerationConstraints;
}

export interface TileJob {
  kind?: undefined;
  requestId: number;
  generatorId: GeneratorId;
  seed: number;
  bbox: BBox;
  constraints: GenerationConstraints;
}

export type GenerationRequest = TileJob | ProcgenRegionJob;

export interface GenerationResponse {
  requestId: number;
  features?: GeoJSON.Feature[];
  error?: string;
}

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const req = event.data;
  try {
    let features: GeoJSON.Feature[];
    if (req.kind === "procgen-region") {
      const algorithm = algorithmById(req.algorithmId);
      if (!algorithm) throw new Error(`unknown procgen algorithm: ${req.algorithmId}`);
      const region = makeRegion(req.regionId, req.ring);
      features = algorithm.generate(req.seed, region, req.params, req.constraints);
    } else {
      const generator = GENERATORS[req.generatorId];
      if (!generator) throw new Error(`unknown generatorId: ${req.generatorId}`);
      features = generator(req.seed, req.bbox, req.constraints);
    }
    const response: GenerationResponse = { requestId: req.requestId, features };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: GenerationResponse = {
      requestId: req.requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};

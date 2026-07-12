/**
 * Web Worker entry point (docs/02 §5: "Generation runs in a Web Worker...
 * so the map tab never stutters"). Dispatches tile-generation requests to
 * the pure generators in src/gen/ — this file is the ONLY thing in src/gen/
 * that isn't itself host-agnostic (it uses postMessage/self), which is why
 * it lives in its own worker/ subfolder rather than alongside the generators.
 */
import { generateWorldRegions, generateSettlements, generateRoutes } from "../world";
import { generateCityNetworkForDomain, citySeedFor, type CityDomain } from "../citynet";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";

/** City-tier generation is domain-scoped since procgen v3.4 — the legacy
 * per-tile city generators (streamline fur, Voronoi districts, bisection
 * blocks) are deleted; `city-network` is the only city job. World tier is
 * untouched by the v3 rewrite. */
export type GeneratorId = "world-region" | "world-settlement" | "world-route";

const GENERATORS: Record<GeneratorId, (seed: number, bbox: BBox, c: GenerationConstraints) => GeoJSON.Feature[]> = {
  "world-region": generateWorldRegions,
  "world-settlement": generateSettlements,
  "world-route": generateRoutes,
};

export interface GenerationRequest {
  requestId: number;
  generatorId: GeneratorId | "city-network";
  seed: number;
  bbox: BBox;
  constraints: GenerationConstraints;
  /** Procgen v3: present only for `city-network` jobs — the whole-domain
   * network is the expensive computation, so it's the one that must run
   * off-thread (design §7.4). `seed` stays the campaign seed; the worker
   * derives the position-keyed citySeed itself. */
  domain?: CityDomain;
}

export interface GenerationResponse {
  requestId: number;
  features?: GeoJSON.Feature[];
  error?: string;
}

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const { requestId, generatorId, seed, bbox, constraints, domain } = event.data;
  try {
    let features: GeoJSON.Feature[];
    if (generatorId === "city-network") {
      if (!domain) throw new Error("city-network job missing domain");
      features = generateCityNetworkForDomain(citySeedFor(seed, domain), domain, constraints);
    } else {
      const generator = GENERATORS[generatorId];
      if (!generator) throw new Error(`unknown generatorId: ${generatorId}`);
      features = generator(seed, bbox, constraints);
    }
    const response: GenerationResponse = { requestId, features };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: GenerationResponse = { requestId, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};

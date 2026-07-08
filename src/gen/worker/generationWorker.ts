/**
 * Web Worker entry point (docs/02 §5: "Generation runs in a Web Worker...
 * so the map tab never stutters"). Dispatches tile-generation requests to
 * the pure generators in src/gen/ — this file is the ONLY thing in src/gen/
 * that isn't itself host-agnostic (it uses postMessage/self), which is why
 * it lives in its own worker/ subfolder rather than alongside the generators.
 */
import { generateCityStreets, generateDistricts, generateCityBlocks } from "../city";
import { generateWorldRegions, generateSettlements, generateRoutes } from "../world";
import type { GenerationConstraints } from "../types";
import type { BBox } from "../spatialHash";

export type GeneratorId =
  | "city-street"
  | "city-district"
  | "city-block"
  | "world-region"
  | "world-settlement"
  | "world-route";

const GENERATORS: Record<GeneratorId, (seed: number, bbox: BBox, c: GenerationConstraints) => GeoJSON.Feature[]> = {
  "city-street": generateCityStreets,
  "city-district": generateDistricts,
  "city-block": generateCityBlocks,
  "world-region": generateWorldRegions,
  "world-settlement": generateSettlements,
  "world-route": generateRoutes,
};

export interface GenerationRequest {
  requestId: number;
  generatorId: GeneratorId;
  seed: number;
  bbox: BBox;
  constraints: GenerationConstraints;
}

export interface GenerationResponse {
  requestId: number;
  features?: GeoJSON.Feature[];
  error?: string;
}

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const { requestId, generatorId, seed, bbox, constraints } = event.data;
  try {
    const generator = GENERATORS[generatorId];
    if (!generator) throw new Error(`unknown generatorId: ${generatorId}`);
    const features = generator(seed, bbox, constraints);
    const response: GenerationResponse = { requestId, features };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: GenerationResponse = { requestId, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(response);
  }
};

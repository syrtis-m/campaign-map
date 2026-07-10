import type { ParsedLocation } from "./locationNote";
import { hashStringToId } from "./locationNote";

function normalizeRef(ref: string): string {
  // strip [[ ]] and any |alias or #heading, keep the target
  const m = ref.match(/^\[\[([^\]|#]+)/);
  return (m ? m[1] : ref).trim();
}

function resolveTarget(
  ref: string,
  byPath: Map<string, ParsedLocation>,
  byName: Map<string, ParsedLocation>
): ParsedLocation | null {
  const raw = ref.trim();
  if (byPath.has(raw)) return byPath.get(raw)!;
  const n = normalizeRef(raw);
  return byName.get(n) ?? byPath.get(n) ?? null;
}

/** Straight undirected line features for every resolvable connection between
 * two point locations. Deduped by unordered id pair (A→B and B→A collapse). */
export function buildConnectionFeatures(locations: ParsedLocation[]): GeoJSON.Feature[] {
  const byPath = new Map(locations.map((l) => [l.path, l]));
  const byName = new Map<string, ParsedLocation>();
  for (const l of locations) {
    byName.set(l.name, l);
    for (const a of l.aliases) byName.set(a, l);
  }
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const src of locations) {
    if (!src.point) continue;
    for (const conn of src.connections) {
      const tgt = resolveTarget(conn.to, byPath, byName);
      if (!tgt || !tgt.point || tgt.path === src.path) continue;
      const key = [src.path, tgt.path].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({
        type: "Feature",
        id: hashStringToId(key),
        geometry: { type: "LineString", coordinates: [src.point, tgt.point] },
        properties: { id: key, from: src.path, to: tgt.path, type: conn.type, label: conn.label },
      });
    }
  }
  return features;
}

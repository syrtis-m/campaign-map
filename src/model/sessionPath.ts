import type { ParsedLocation } from "./locationNote";

/**
 * Per-session travel paths (Phase 5, the original roadmap): session notes already
 * wikilink the locations a party visited, in the order the GM typed them —
 * so a session's route is just those links resolved to points, in
 * appearance order. Pure parser: no vault/DOM access, easy to snapshot-test
 * (mirrors `buildConnectionFeatures` in `./connections`).
 */

/** Ordered wikilink targets in a note body → resolved location points, in
 * appearance order, deduped consecutively. Returns [] if <2 resolve. */
export function parseSessionPath(
  body: string,
  locations: ParsedLocation[]
): { name: string; point: [number, number] }[] {
  const byName = new Map<string, ParsedLocation>();
  for (const l of locations) {
    byName.set(l.name, l);
    for (const a of l.aliases) byName.set(a, l);
  }
  const refs: { name: string; point: [number, number] }[] = [];
  const re = /\[\[([^\]|#]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const loc = byName.get(m[1].trim());
    if (loc?.point) {
      const last = refs[refs.length - 1];
      if (!last || last.name !== loc.name) refs.push({ name: loc.name, point: loc.point });
    }
  }
  return refs.length >= 2 ? refs : [];
}

/** A single LineString feature through the resolved path points, in order.
 * `null` (not an empty FeatureCollection) when there's nothing to draw — the
 * caller decides how to clear the `session-path` source. */
export function sessionPathFeature(pts: { point: [number, number] }[]): GeoJSON.Feature | null {
  if (pts.length < 2) return null;
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: pts.map((p) => p.point) },
    properties: { kind: "session-path" },
  };
}

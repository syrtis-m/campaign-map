/**
 * Generic GeoJSON importer (plan 011): Azgaar's Fantasy Map Generator and
 * Watabou's generators both export GeoJSON, and a generic importer covers
 * both plus anything else that speaks the format. Point features become
 * point-note specs (reusing the quick-add write path); Line/Polygon
 * features become sidecar-geojson note specs ("complex geometry → sidecar
 * .geojson", CLAUDE.md conventions).
 *
 * Out of scope (see plan 011): Azgaar's native `.map` binary format and
 * coordinate reprojection — this assumes the GeoJSON's coordinates are
 * already in the campaign's own space (fictional units or lng/lat).
 */
export interface ImportedNote {
  name: string;
  type: string;
  point: [number, number] | null;
  geojson: GeoJSON.Feature | null;
}

/** Map a FeatureCollection to note specs. Point → point note; Line/Polygon →
 * sidecar-geojson note. Name from properties.name/title/id (fallback "Imported N").
 * type from properties.type if it's a known type, else a default per geometry. */
export function importGeojson(fc: unknown, knownTypes: string[]): ImportedNote[] {
  const out: ImportedNote[] = [];
  const feats =
    (fc as any)?.type === "FeatureCollection" && Array.isArray((fc as any).features) ? (fc as any).features : [];
  let n = 0;
  for (const f of feats) {
    n++;
    const props = f?.properties ?? {};
    const name = String(props.name ?? props.title ?? props.id ?? `Imported ${n}`).trim() || `Imported ${n}`;
    const g = f?.geometry;
    if (!g) continue;
    const rawType = typeof props.type === "string" ? props.type : "";
    if (g.type === "Point") {
      out.push({
        name,
        type: knownTypes.includes(rawType) ? rawType : "landmark",
        point: g.coordinates as [number, number],
        geojson: null,
      });
    } else if (g.type === "LineString" || g.type === "MultiLineString") {
      out.push({ name, type: knownTypes.includes(rawType) ? rawType : "route", point: null, geojson: f });
    } else if (g.type === "Polygon" || g.type === "MultiPolygon") {
      out.push({ name, type: knownTypes.includes(rawType) ? rawType : "district", point: null, geojson: f });
    }
  }
  return out;
}

export function sanitizeNoteName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Imported"
  );
}

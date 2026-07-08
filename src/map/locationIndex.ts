import Flatbush from "flatbush";
import type { ParsedLocation } from "../model/locationNote";
import { locationToFeature } from "../model/locationNote";

/**
 * In-memory spatial index for one campaign's canon locations (architecture §3:
 * "vault watches map: frontmatter → in-memory flatbush index → GeoJSON sources").
 * Flatbush is a static structure, so the index is rebuilt lazily on first query
 * after any mutation — fine at yes-and campaign scale (tens-hundreds of notes).
 */
export class LocationIndex {
  private locations = new Map<string, ParsedLocation>();
  private flatbush: Flatbush | null = null;
  private orderedIds: string[] = [];

  constructor(public readonly campaignId: string) {}

  upsert(loc: ParsedLocation): void {
    this.locations.set(loc.id, loc);
    this.flatbush = null;
  }

  remove(id: string): boolean {
    const had = this.locations.delete(id);
    if (had) this.flatbush = null;
    return had;
  }

  has(id: string): boolean {
    return this.locations.has(id);
  }

  get(id: string): ParsedLocation | undefined {
    return this.locations.get(id);
  }

  get size(): number {
    return this.locations.size;
  }

  all(): ParsedLocation[] {
    return [...this.locations.values()];
  }

  private ensureBuilt(): void {
    if (this.flatbush) return;
    const pts = this.all().filter((l) => l.point);
    if (pts.length === 0) return;
    this.orderedIds = pts.map((l) => l.id);
    const fb = new Flatbush(pts.length);
    for (const l of pts) {
      const [x, y] = l.point!;
      fb.add(x, y, x, y);
    }
    fb.finish();
    this.flatbush = fb;
  }

  /** Nearest canon locations to a point, e.g. for the "dropped pin near X" tooltip. */
  nearest(point: [number, number], maxResults = 1): ParsedLocation[] {
    this.ensureBuilt();
    if (!this.flatbush || this.orderedIds.length === 0) return [];
    const idxs: number[] = this.flatbush.neighbors(point[0], point[1], maxResults);
    return idxs.map((i) => this.locations.get(this.orderedIds[i])).filter((l): l is ParsedLocation => !!l);
  }

  toFeatureCollection(): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (const loc of this.locations.values()) {
      const f = locationToFeature(loc);
      if (f) features.push(f);
    }
    return { type: "FeatureCollection", features };
  }
}

/**
 * Terrain-refresh chokepoint — converge every terrain-affecting fabric mutation
 * onto ONE DEM + contour refresh.
 *
 * THE BUG THIS FIXES (Jonah 2026-07-15: "after deleting a landform it takes a
 * long time for the 3D area to go back to 2D"). A durable terrain-affecting
 * change — a landform / relief / mountain stamp DELETE, a stamp create /
 * first-generate, an undo/redo, an adopt, a re-roll, a base-terrain edit — moves
 * the composed elevation field, so the DEM digest changes. But MapLibre KEEPS
 * rendering its retained decoded DEM tiles (the raster-dem URL is stable, so
 * nothing forces a refetch; `maxTileCacheSize` + the PNG-byte LRU make stale
 * tiles stick harder) until some unrelated pan refetches them. Param edits went
 * through `refreshTerrainIfEnabled` (re-register provider + bust the source tile
 * cache + refresh contours) — but delete / create / undo / adopt did NOT, so the
 * 3D mesh lagged while the manager-hooked contours refreshed promptly (exactly
 * the report).
 *
 * The fix: observe the controller's composed-elevation digest at the single
 * point the controller signals a repaint back to the view (the `repaintGenerated`
 * / `repaintFabric` render callbacks). Whenever that digest MOVES, run the same
 * refresh a param edit runs. Because the digest is a pure function of every
 * terrain-affecting input (each stamp's id/kind/algorithm/seed/params/geometry,
 * river spines, base params, campaign seed, grade-enable, vertical scale K —
 * NOT the region's generator-version pin, which the terrain field is independent
 * of), this fires exactly when the elevation surface actually changed and never
 * for a pure city-fabric repaint or a version-only adopt. No per-path
 * enumeration: every mutation that reaches a repaint is covered.
 *
 * Kept host-agnostic (no Obsidian / MapLibre imports) so the gate can drive it
 * headlessly with spy deps + a mock digest source.
 */

export interface TerrainRefreshDeps {
  /** The current composed-elevation digest (`campaignElevationDigest`), or
   * `null` when no campaign is loaded. */
  readDigest: () => string | null;
  /** Is the 3D-mesh / hillshade terrain toggle on? Contours refresh regardless;
   * the DEM provider re-register + tile-cache bust only matter when relief is
   * actually rendering. */
  terrainEnabled: () => boolean;
  /** Re-point the `campaigndem` provider at the live elevation field. */
  registerProvider: () => void;
  /** Force MapLibre to drop + refetch its retained DEM tiles (the retained-tile
   * bust — the actual mechanism that was missing on delete/create/undo). */
  bustTileCache: () => void;
  /** Re-derive the global contour surface for the current viewport. */
  refreshContours: () => void;
}

export class TerrainRefresh {
  private last: string | null = null;

  constructor(private readonly deps: TerrainRefreshDeps) {}

  /** Seed the baseline digest WITHOUT refreshing — call on campaign load/switch
   * so the FIRST real mutation is what triggers a refresh, not the initial paint
   * of an already-consistent map. */
  seedBaseline(): void {
    this.last = this.deps.readDigest();
  }

  /** An explicit terrain-affecting edit whose repaint does NOT flow back through
   * the render chokepoint (e.g. a base-terrain apply that repaints the style
   * directly): always refresh, and re-baseline so a later chokepoint observation
   * of the same digest doesn't double-fire. */
  refreshNow(): void {
    this.last = this.deps.readDigest();
    this.apply();
  }

  /** The mutation-signal chokepoint — called from every `repaintGenerated` /
   * `repaintFabric` render callback. Refresh IFF the elevation digest actually
   * moved since the last observation; a pure city repaint or an unchanged
   * regenerate is a cheap no-op. */
  refreshIfElevationChanged(): void {
    const cur = this.deps.readDigest();
    if (cur === this.last) return;
    this.last = cur;
    this.apply();
  }

  private apply(): void {
    // Contours render regardless of the 3D/hillshade toggle, so refresh them
    // unconditionally; the DEM provider + tile-cache bust only matter when relief
    // is actually being drawn.
    this.deps.refreshContours();
    if (!this.deps.terrainEnabled()) return;
    this.deps.registerProvider();
    this.deps.bustTileCache();
  }
}

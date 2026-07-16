/**
 * Terrain-toggle lifecycle — the host-agnostic brain behind the "show 3D" button.
 *
 * THE BUGS THIS FIXES (Jonah 2026-07-15: "toggling the show-3d button causes a
 * massive performance hit and is unreliable in getting things back up";
 * 2026-07-16: "looking straight down pops the 3D away and it takes a while to
 * pop back in").
 *
 *  1. MASSIVE HIT — every enable unconditionally `setTiles`'d the raster-DEM
 *     source, which drops MapLibre's whole tile cache and reloads every viewport
 *     tile (re-fetch → re-decode PNG→texture → REBUILD the 3D mesh), even when the
 *     elevation field never moved. A plain on/off/on paid a full viewport
 *     refetch+decode+mesh-rebuild each time. Fix: bust ONLY when the composed-
 *     elevation digest moved while terrain was off (the terrainRefresh baseline
 *     pattern) — a plain re-enable reuses the retained decoded tiles + the PNG
 *     memo and just flips visibility / re-shows the retained mesh (a pure serve).
 *
 *  2. UNRELIABLE ("sometimes doesn't come back") — `setTerrain` throws if the DEM
 *     source isn't loaded yet; the old code swallowed the throw and never retried,
 *     so terrain stayed off silently while the button read active. Fix: on a
 *     throw, retry ONCE when the source signals ready (bounded, self-removing),
 *     and re-derive relief state idempotently so it converges deterministically
 *     from `enabled` + pitch.
 *
 *  3. TOP-DOWN POP + SLOW RE-RAISE — the pitch-adaptive swap used to TEAR DOWN
 *     the mesh (`setTerrain(null)`) at top-down and rebuild it from scratch on
 *     the next tilt: MapLibre drops the terrain tile/render caches with the
 *     terrain object, so tilting again refetched + re-decoded + re-meshed the
 *     whole viewport (seconds). Fix: while 3D is ENABLED the mesh stays
 *     RESIDENT at every pitch — top-down just sets `exaggeration: 0` (a
 *     render-time uniform: measured 2–3 ms, zero tile refetches). The drape
 *     surface is flat at exaggeration 0, so the hillshade renders clean (the
 *     4.7.1 smear needs actual relief under the drape); tilting back restores
 *     the exaggeration instantly.
 *
 * Kept free of Obsidian / MapLibre imports (a thin `TerrainTogglePort` is the
 * seam) so the gate drives the full lifecycle — digest-gated bust, pitch-adaptive
 * relief, source-ready retry, listener symmetry across N cycles — headlessly with
 * a fake port. Mirrors `terrainRefresh.ts`.
 */

/** The mesh's lifecycle state: `on` = raised (pitched view), `flat` = resident
 * but exaggeration 0 (top-down — caches stay warm so a tilt re-raises in ms),
 * `off` = torn down (3D disabled). */
export type MeshMode = "on" | "flat" | "off";

/** The host seam: every method is a live read/act against the current map, so the
 * port can be built before the map exists (lazy closures, as MapView wires it). */
export interface TerrainTogglePort {
  /** The hillshade layer is present — false ⇒ no map / non-fictional style, and
   * the whole toggle no-ops (returns false). */
  hasHillshadeLayer: () => boolean;
  setHillshadeVisible: (visible: boolean) => void;
  /** Current camera pitch, degrees. Relief is pitch-adaptive: top-down → 2D
   * hillshade over the FLAT resident mesh, pitched → the raised mesh with
   * hillshade hidden (a raised mesh under the draped hillshade smears —
   * maplibre-gl 4.7.1; a flat one doesn't). */
  getPitch: () => number;
  /** The CURRENT mesh mode read from the live map (`getTerrain()` null → "off";
   * exaggeration > 0 → "on"; else "flat") — truth, never cached, so convergence
   * survives a `setStyle` wiping the terrain behind our back. */
  meshMode: () => MeshMode;
  /** Apply a mesh mode. MAY THROW for "on"/"flat" when the DEM source isn't
   * loaded yet — the caller catches and schedules a source-ready retry. */
  setMesh: (mode: MeshMode) => void;
  /** Force MapLibre to drop + refetch retained DEM tiles (`setTiles` → reload).
   * The expensive op — gated behind a digest move. */
  bustDemTiles: () => void;
  /** Re-point the DEM provider at the live field (idempotent). */
  registerProvider: () => void;
  /** Current composed-elevation digest (`campaignElevationDigest`), null when no
   * field is loaded. */
  readDigest: () => string | null;
  /** Subscribe / unsubscribe the pitch handler that re-applies relief mode. */
  addPitchHandler: (fn: () => void) => void;
  removePitchHandler: (fn: () => void) => void;
  /** Register a ONE-SHOT "DEM source became ready" callback; returns an
   * unsubscribe. Backs the bounded mesh retry. */
  onceSourceReady: (fn: () => void) => () => void;
}

/** Hard ceiling on source-ready mesh retries so a genuinely wedged source can
 * never spin an unbounded re-subscribe loop. Source-ready normally succeeds on
 * the first retry; this is pure insurance. */
const MAX_MESH_RETRIES = 5;

export class TerrainToggle {
  private enabled = false;
  /** The elevation digest the currently-retained DEM tiles were built for. A
   * plain re-enable whose digest matches reuses those tiles (no `setTiles`
   * reload); a mismatch (a field edit landed while terrain was off) busts once. */
  private demTilesDigest: string | null = null;
  private pitchHandler: (() => void) | null = null;
  private retryUnsub: (() => void) | null = null;
  private retryCount = 0;

  constructor(private readonly port: TerrainTogglePort) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Observability for the leak assertions: live listener count (pitch handler +
   * a pending source-ready retry). Must not grow across on/off cycles. */
  get listenerCount(): number {
    return (this.pitchHandler ? 1 : 0) + (this.retryUnsub ? 1 : 0);
  }

  /** The single toggle. Returns false (no-op) when relief isn't available (no
   * map / non-fictional). VISIBILITY + mesh only — never generation. */
  setEnabled(on: boolean): boolean {
    if (!this.port.hasHillshadeLayer()) return false;
    this.enabled = on;
    if (on) {
      // Re-point the provider (idempotent) so a field edit made while off is
      // served, then bust the retained tiles ONLY if that field actually moved —
      // otherwise reuse the decoded tiles + PNG memo (the "massive hit" fix).
      this.port.registerProvider();
      const cur = this.port.readDigest();
      if (cur !== this.demTilesDigest) {
        this.port.bustDemTiles();
        this.demTilesDigest = cur;
      }
      if (!this.pitchHandler) {
        this.pitchHandler = () => this.applyReliefMode();
        this.port.addPitchHandler(this.pitchHandler);
      }
    } else if (this.pitchHandler) {
      this.port.removePitchHandler(this.pitchHandler);
      this.pitchHandler = null;
    }
    this.applyReliefMode();
    return true;
  }

  /** The render-chokepoint bust path (terrainRefresh) busted the DEM after an
   * on-terrain field edit — record the new digest so a later plain toggle doesn't
   * bust the very tiles that edit just refreshed. Shared source of truth for
   * "what the retained tiles reflect". */
  markDemTilesFresh(): void {
    this.demTilesDigest = this.port.readDigest();
  }

  /**
   * Converge relief to the current state — idempotent, safe to call on every
   * pitch/settle and after a restyle. OFF ⇒ no hillshade, mesh torn down.
   * ON + top-down ⇒ hillshade over the FLAT resident mesh (exaggeration 0 —
   * caches stay warm, no smear on a flat drape). ON + pitched ⇒ the raised
   * mesh, hillshade hidden (a raised mesh under the draped hillshade smears —
   * maplibre-gl 4.7.1). Pitch crossings are exaggeration flips on the SAME
   * resident terrain: ~2 ms, zero refetches (bug 3 above).
   */
  applyReliefMode(): void {
    if (!this.port.hasHillshadeLayer()) return;
    const pitched = this.port.getPitch() > 0.5;
    const wantHillshade = this.enabled && !pitched;
    this.port.setHillshadeVisible(wantHillshade);
    const want: MeshMode = !this.enabled ? "off" : pitched ? "on" : "flat";
    const actual = this.port.meshMode();
    if (want === actual) {
      // Already converged — cancel any stale pending retry (a toggle-off while
      // a retry was queued must not resurrect the mesh; a satisfied raise must
      // not re-fire).
      this.cancelRetry();
      return;
    }
    if (want === "off") {
      try {
        this.port.setMesh("off");
      } catch {
        /* clearing never depends on source readiness */
      }
      this.cancelRetry();
    } else {
      this.trySetMesh(want);
    }
  }

  /** Try to apply a live mesh mode; on the source-not-ready throw, schedule a
   * bounded one-shot retry instead of silently leaving terrain off. */
  private trySetMesh(mode: "on" | "flat"): void {
    try {
      this.port.setMesh(mode);
      this.retryCount = 0;
      this.cancelRetry();
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryUnsub) return; // one pending retry at a time
    if (this.retryCount >= MAX_MESH_RETRIES) return; // wedged source — give up quietly
    this.retryCount++;
    this.retryUnsub = this.port.onceSourceReady(() => {
      this.retryUnsub = null;
      // Re-derive from CURRENT state — honors a toggle-off / pitch change that
      // happened while we waited (idempotent convergence).
      this.applyReliefMode();
    });
  }

  private cancelRetry(): void {
    if (this.retryUnsub) {
      this.retryUnsub();
      this.retryUnsub = null;
    }
  }

  /** Campaign switch: terrain is per-session, so force off and drop the retained-
   * tile digest (the next campaign's field is unrelated). Listeners are dropped
   * symmetrically. */
  reset(): void {
    this.dispose();
    this.enabled = false;
    this.demTilesDigest = null;
    this.retryCount = 0;
  }

  /** Teardown (onClose): drop every listener symmetrically. */
  dispose(): void {
    if (this.pitchHandler) {
      this.port.removePitchHandler(this.pitchHandler);
      this.pitchHandler = null;
    }
    this.cancelRetry();
  }
}

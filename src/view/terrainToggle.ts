/**
 * Terrain-toggle lifecycle — the host-agnostic brain behind the "show 3D" button.
 *
 * THE BUGS THIS FIXES (Jonah 2026-07-15: "toggling the show-3d button causes a
 * massive performance hit and is unreliable in getting things back up").
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
 * Kept free of Obsidian / MapLibre imports (a thin `TerrainTogglePort` is the
 * seam) so the gate drives the full lifecycle — digest-gated bust, pitch-adaptive
 * relief, source-ready retry, listener symmetry across N cycles — headlessly with
 * a fake port. Mirrors `terrainRefresh.ts`.
 */

/** The host seam: every method is a live read/act against the current map, so the
 * port can be built before the map exists (lazy closures, as MapView wires it). */
export interface TerrainTogglePort {
  /** The hillshade layer is present — false ⇒ no map / non-fictional style, and
   * the whole toggle no-ops (returns false). */
  hasHillshadeLayer: () => boolean;
  setHillshadeVisible: (visible: boolean) => void;
  /** Current camera pitch, degrees. Relief is pitch-adaptive: top-down → 2D
   * hillshade, pitched → 3D mesh (they never render together — see MapView). */
  getPitch: () => number;
  /** Is a 3D terrain mesh currently active (`map.getTerrain() != null`)? */
  isMeshActive: () => boolean;
  /** Set (true) / clear (false) the 3D mesh. MAY THROW on set when the DEM source
   * isn't loaded yet — the caller catches and schedules a source-ready retry. */
  setMesh: (on: boolean) => void;
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
   * pitch/settle and after a restyle. OFF ⇒ no hillshade, no mesh. ON + top-down
   * ⇒ hillshade, no mesh. ON + pitched ⇒ mesh, hillshade hidden. The two relief
   * layers never render together (maplibre-gl 4.7.1 smears a draped hillshade
   * over an active mesh — see MapView).
   */
  applyReliefMode(): void {
    if (!this.port.hasHillshadeLayer()) return;
    const pitched = this.port.getPitch() > 0.5;
    const wantMesh = this.enabled && pitched;
    const wantHillshade = this.enabled && !pitched;
    this.port.setHillshadeVisible(wantHillshade);
    const active = this.port.isMeshActive();
    if (wantMesh && !active) {
      this.trySetMesh();
    } else if (!wantMesh && active) {
      try {
        this.port.setMesh(false);
      } catch {
        /* clearing never depends on source readiness */
      }
      this.cancelRetry();
    } else {
      // Already in the wanted mesh state — cancel any stale pending retry (a
      // toggle-off while a retry was queued must not resurrect the mesh).
      if (!wantMesh) this.cancelRetry();
    }
  }

  /** Try to raise the mesh; on the source-not-ready throw, schedule a bounded
   * one-shot retry instead of silently leaving terrain off. */
  private trySetMesh(): void {
    try {
      this.port.setMesh(true);
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

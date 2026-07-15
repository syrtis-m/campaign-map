/**
 * MapController — the host-agnostic lifecycle brain. Owns generation / regen /
 * clear / undo / replay / migration / region-procgen / sketch-commit
 * orchestration and the state those touch (render store, manifest, fabric
 * collection, gate counters). It talks to the outside world ONLY through the
 * narrow interfaces below (vault gateway, gen gateway, canon gateway, note-ops,
 * notice sink, render sink, viewport) — so it has NO DOM / MapLibre / Obsidian
 * imports and is fully testable against a FakeHost with an in-memory vault
 * (same purity rule as src/gen/, CLAUDE.md).
 *
 * MapView constructs one of these with Obsidian-backed gateways and becomes
 * wiring + paint; every gate-facing test API method on MapView forwards here.
 */
import { z } from "zod";
import type { ParsedCampaign } from "../model/campaignConfig";
import {
  FabricFeatureSchema,
  ProcgenBlockSchema,
  canDeleteVertex,
  emptyFabric,
  isPolygonKind,
  isProcgenRegion,
  makeFabricId,
  sketchUndoTarget,
  withFeature,
  withoutFeature,
  withProcgen,
  withoutProcgen,
  withVertexMoved,
  withVertexInserted,
  withVertexDeleted,
  type FabricCollection,
  type FabricFeature,
  type FabricGeometry,
  type FabricKind,
  type ProcgenBlock,
} from "../model/fabric";
import { fabricPath } from "../vault/fabricStore";
import {
  emptyManifest,
  entriesForDomain,
  entriesForTile,
  manifestEntryId,
  withEntry,
  withoutDomain,
  withoutEntry,
  ManifestEntrySchema,
  type GeneratedManifest,
  type ManifestEntry,
} from "../model/generatedManifest";
import { generatedManifestPath } from "../vault/generatedManifestStore";
import type { CachedTile } from "../model/tileCache";
import type { UpstreamArtifacts } from "../gen/types";
import { campaignFolderFromConfigPath, type LogEntry } from "../model/mutationLog";
import { defaultFictionalBounds } from "../map/fictionalCRS";
import {
  tileXYForPoint,
  tileBBox,
  bandForZoom,
  generatorIdsForBand,
  tileKey,
  GENERATION_ZOOM,
  type ZoomBand,
} from "../gen/cache/tileGrid";
import type { BBox } from "../gen/spatialHash";
import {
  regionNetworkKey,
  regionTileKey,
  type GenerationContext,
  type RegionNetworkCompute,
  type TileGenerator,
} from "../map/generation/generationService";
import {
  anchorCellForPoint,
  citySeedFor,
  discToRing,
  DISC_TO_RING_SEGMENTS,
  DOMAIN_TILE_GENERATOR_IDS,
  type CityDomain,
} from "../gen/citynet";
import {
  makeRegion,
  makeSpine,
  makeCorridorRegion,
  regionContains,
  generationCenter,
  segmentCrossesBoundary,
  validateRegionRing,
  validateSpineLine,
  distanceToBoundary,
  type ProcgenRegion,
  type RingValidation,
} from "../gen/region";
import {
  algorithmById,
  algorithmForKind,
  migrateParamsForAdoption,
  presetById,
  type ProcgenAlgorithm,
} from "../gen/procgen/registry";
import { cascadeOrder, downstreamClosure, upstreamEdges, type DagNode } from "../gen/procgen/dag";
import { isCacheRecordFresh, regionFingerprint } from "../gen/cache/fingerprint";
import { mountainHeightField, type MountainTerrain } from "../gen/mountain";
import { unionFields, demVerticalScale, type ElevationField } from "../gen/fields";
import type { GeneratorId } from "../gen/worker/generationWorker";
import type { GenerationWorkerClient } from "../map/generation/workerClient";
import { hashSeed } from "../gen/rng";
import {
  boundsToBBox,
  bboxUnitsToMeters,
  unitsToMeters,
  metersToUnits,
  transformFeatureUnits,
  featureTouchesBBox,
} from "./units";
import { generateWorldRegions, generateRoutes } from "../gen/world";

/** Data shape of a `sketch-procgen-set` / `sketch-procgen-clear` log entry:
 * the region's before/after procgen block + the post-op feature, so undo can
 * strip a block (dropping its cache) or re-attach one (regenerating). Parsed at
 * the undo IO boundary. */
const ProcgenLogDataSchema = z.object({
  featureId: z.string(),
  before: ProcgenBlockSchema.nullable(),
  after: ProcgenBlockSchema.nullable(),
  feature: FabricFeatureSchema,
});

/** Data shape of a `sketch-edit` log entry: the full FabricFeature before and
 * after a geometry/property edit. Zod-validated at the undo IO boundary (bad
 * entry → Notice, never a crash). */
const SketchEditDataSchema = z.object({
  featureId: z.string(),
  before: FabricFeatureSchema,
  after: FabricFeatureSchema,
});

// ─── Narrow host interfaces the controller owns ───────────────────────────

/** Vault-side operations, at the granularity the controller needs. The host
 * (MapView) forwards these to the App-based store functions; FakeHost backs
 * them with an in-memory adapter calling the SAME unchanged store functions.
 * Cache/log folders are computed by the controller (pure string math) and
 * passed through, matching the underlying store signatures. */
export interface VaultGateway {
  loadFabric(campaign: ParsedCampaign): Promise<{ fabric: FabricCollection; invalidCount: number }>;
  saveFabric(campaign: ParsedCampaign, fabric: FabricCollection): Promise<void>;
  loadManifest(campaign: ParsedCampaign): Promise<{ manifest: GeneratedManifest; invalidCount: number }>;
  saveManifest(campaign: ParsedCampaign, manifest: GeneratedManifest): Promise<void>;
  appendLog(campaignFolder: string, entry: LogEntry): Promise<void>;
  readLog(campaignId: string): Promise<LogEntry[]>;
  readCached(campaignFolder: string): Promise<Map<string, CachedTile>>;
  removeCached(campaignFolder: string, keys: string[]): Promise<void>;
}

/** GenerationContext minus the Obsidian `app` — the host adds `.app` when it
 * forwards to the generation service (keeps `App` out of the controller). */
export type ControllerGenContext = Omit<GenerationContext, "app">;

/** The two batch-shared views threaded through a flush/cascade so a multi-region
 * pass hashes ONCE and reads the cache ONCE (031-B): the precomputed
 * `(stage,id)`-ordered fingerprint map + the single mutable cache view every
 * region regen reads fresh upstream from and writes its records into. */
type RegionBatchOpts = { fingerprints?: Map<string, string>; preloadedCache?: Map<string, CachedTile> };

/** The generation service, host-injected so the controller never imports the
 * App-typed `generateTile`/`generateRegionTile` directly. */
export interface GenGateway {
  getWorker(): Promise<GenerationWorkerClient | null>;
  generateTile(
    ctx: ControllerGenContext,
    tileX: number,
    tileY: number,
    generatorId: string,
    generator: TileGenerator,
    opts?: { force?: boolean }
  ): Promise<GeoJSON.Feature[]>;
  generateRegionTile(
    ctx: ControllerGenContext,
    region: ProcgenRegion,
    tileGeneratorIds: readonly string[],
    tileX: number,
    tileY: number,
    computeNetwork: RegionNetworkCompute,
    opts?: { force?: boolean; preloadedCache?: Map<string, CachedTile>; fingerprint?: string }
  ): Promise<GeoJSON.Feature[]>;
}

/** Read-only canon (location index) access — the generators take canon pins as
 * constraints. */
export interface CanonGateway {
  canonFeatureCollection(campaignId: string): GeoJSON.FeatureCollection;
}

/** Note-file undo (create/move log entries) — Obsidian TFile ops in MapView,
 * a no-op headless (those flows need the vault's note layer, not the
 * lifecycle the controller owns). */
export interface NoteOps {
  undoNoteEntry(entry: LogEntry): Promise<void>;
}

/** Where user-facing messages go — `new Notice` in MapView, an array headless. */
export interface NoticeSink {
  notify(message: string, timeoutMs?: number): void;
}

/** Blocking yes/no consent — a modal in MapView, scripted headless. Used for
 * the version-adoption prompt: resolves true to proceed, false to cancel. */
export interface ConfirmSink {
  confirm(message: string): Promise<boolean>;
}

/**
 * The paint/selection side effects the controller triggers. MapView reads the
 * controller's current state to repaint; a no-op sink is a valid headless
 * implementation. `featureChanged`/`selectionInvalidated` carry only a feature
 * id so selection state (which the controller must not know) stays in MapView.
 */
export interface RenderSink {
  /** Repaint the `generated` source from the controller's render store. */
  repaintGenerated(): void;
  /** Repaint the `fabric` source from the controller's fabric collection. */
  repaintFabric(): void;
  /** The pending-generation count changed (loading indicator). */
  loadingChanged(): void;
  /** A selected feature changed in place — refresh its panel; `reselect`
   * re-syncs the edit handles, `panel` (default true) rebuilds the panel. */
  featureChanged(featureId: string, opts?: { reselect?: boolean; panel?: boolean }): void;
  /** A feature was removed/restored — clear any selection pointing at it.
   * `keepPanel` clears the selection + edit handles but leaves the panel up
   * (sketch-mode undo did exactly this; delete / sketch-remove-undo full-deselect). */
  selectionInvalidated(featureId: string, opts?: { keepPanel?: boolean }): void;
  /** Arm the debounced constraint-regen flush (MapView owns the timer). */
  armRegenFlush(): void;
}

/** The live camera the "…here" actions read when no explicit point is given. */
export interface Viewport {
  zoom(): number;
  centerUnits(): [number, number];
}

export interface ControllerHost {
  vault: VaultGateway;
  gen: GenGateway;
  canon: CanonGateway;
  notes: NoteOps;
  notices: NoticeSink;
  confirm: ConfirmSink;
  render: RenderSink;
  viewport: Viewport;
}

export class MapController {
  campaign: ParsedCampaign | null = null;

  /**
   * Render store for generated fabric, keyed `${tier}:${tileX}:${tileY}` —
   * generation-space (meters), same as `.mapcache/` itself. Fed ONLY by
   * (a) manifest replay on campaign open and (b) explicit generate actions
   * (no viewport dispatch, no generate-on-pan, ever). Sketch-corridor
   * elaborations live under their own `sketch:<id>:` key namespace.
   */
  private loadedTiles = new Map<string, GeoJSON.Feature[]>();
  /** In-memory mirror of `<campaign>/Generated.json`. */
  private manifest: GeneratedManifest = emptyManifest();
  private manifestLoadedFor: string | null = null;
  /** Guards manifest replay so it runs once per campaign open. */
  private manifestReplayedFor: string | null = null;
  /** In-memory mirror of `<campaign>/Fabric.geojson`. */
  private fabricCollection: FabricCollection = emptyFabric();
  private fabricLoadedFor: string | null = null;
  /**
   * Persistent in-memory cache view (plan 032-B): the campaign's generated
   * cache read from disk ONCE per open (all shards, via the gateway), then kept
   * live — every region append `.set()`s into it and every drop `.delete()`s
   * from it, so no batch (flush/cascade/replay) re-reads a shard it already
   * holds (research P7 read-amplification). Threaded as `preloadedCache` into
   * every region regen. Owned per-controller (not a module global) so a fresh
   * controller — `reopen()` / a campaign switch — starts with an empty view and
   * reads disk fresh: that is what keeps the delete-`.mapcache`-then-reopen
   * pinned-old test blanking instead of serving a stale in-memory record.
   * World-tier tile records stay on the direct `getCachedTile` disk path
   * (per-shard, cheap, out of the batch hot path) — they are not threaded here.
   * Null until first access. Lost writes are harmless: determinism means a
   * missing record is a fingerprint MISS that regenerates byte-identically. */
  private sessionCache: Map<string, CachedTile> | null = null;
  /** Explicit generate/replay runs in flight — drives the loading badge. */
  private pendingGenerations = 0;
  /** Gate counter: actual generator EXECUTIONS. */
  private generatorRunCounter = 0;
  /** Gate counter (031-B): how many `computeRegionFingerprints` passes ran —
   * a batch (flush/cascade/replay) must do exactly ONE, threading the result. */
  private fingerprintPassCounter = 0;
  /** Repaint coalescing (031-B): while >0, `repaintGenerated` is deferred to a
   * single paint at the end of the batch — a 10-region cascade fires one
   * `setData`, not ten (research P7). */
  private repaintBatchDepth = 0;
  private repaintPending = false;
  /** Sketch edits accumulated while the regen debounce is pending. */
  private pendingConstraintFeatures: FabricFeature[] = [];
  /** Region ids whose OWN geometry changed and need a force-regen next flush. */
  private pendingRegionRegen = new Set<string>();

  /** World tier only — city fabric is domain-scoped (citynet). */
  private readonly directGenerators: Record<string, TileGenerator> = {
    "world-region": generateWorldRegions,
    "world-route": generateRoutes,
  };

  constructor(private readonly host: ControllerHost) {}

  // ─── Campaign lifecycle ────────────────────────────────────────────────

  /** Point the controller at a campaign. On a genuine switch it drops all
   * per-campaign state (render store, manifest, fabric) so the next open
   * starts clean; returns whether it switched so MapView can reset its own
   * (selection / session-path / sketch-mode) state to match. */
  beginCampaign(campaign: ParsedCampaign): { switched: boolean } {
    const switched = this.campaign != null && this.campaign.id !== campaign.id;
    if (switched) {
      this.loadedTiles.clear();
      this.manifest = emptyManifest();
      this.manifestLoadedFor = null;
      this.manifestReplayedFor = null;
      this.fabricCollection = emptyFabric();
      this.fabricLoadedFor = null;
      this.sessionCache = null; // drop the previous campaign's cache view
    }
    this.campaign = campaign;
    return { switched };
  }

  // ─── Gate / test / paint surface ───────────────────────────────────────

  /** Test/perf-gate surface: how many tile entries the render store holds. */
  get loadedTileCount(): number {
    return this.loadedTiles.size;
  }

  /** Gate surface: actual generator executions this session. */
  get generatorRunCount(): number {
    return this.generatorRunCounter;
  }

  /** Gate surface (031-B): fingerprint passes this session — one per batch. */
  get fingerprintPassCount(): number {
    return this.fingerprintPassCounter;
  }

  /** Repaint the generated layer, coalescing to ONE paint per open batch
   * (flush/cascade/replay). Outside a batch it paints immediately, unchanged. */
  private repaintGenerated(): void {
    if (this.repaintBatchDepth > 0) {
      this.repaintPending = true;
      return;
    }
    this.host.render.repaintGenerated();
  }

  /** Run `fn` as one repaint batch: every `repaintGenerated` inside collapses
   * into a single paint on exit (only if something asked to paint). Reentrant
   * (nested batches coalesce into the outermost). */
  private async withRepaintBatch<T>(fn: () => Promise<T>): Promise<T> {
    this.repaintBatchDepth++;
    try {
      return await fn();
    } finally {
      this.repaintBatchDepth--;
      if (this.repaintBatchDepth === 0 && this.repaintPending) {
        this.repaintPending = false;
        this.host.render.repaintGenerated();
      }
    }
  }

  /** The persistent cache view (plan 032-B), read from disk ONCE per campaign
   * open and served from memory thereafter. Callers thread the returned map as
   * `preloadedCache`; region appends `.set()` into it and drops (`dropCached`)
   * `.delete()` from it, so the view stays == disk without any re-read. */
  private async cacheView(folder: string): Promise<Map<string, CachedTile>> {
    if (!this.sessionCache) {
      this.sessionCache = await this.host.vault.readCached(folder);
    }
    return this.sessionCache;
  }

  /** Drop cache records from BOTH disk and the live session view (plan 032-B),
   * so a later `cacheView` never serves a dropped key. The single write-through
   * path for every generated-cache removal. */
  private async dropCached(folder: string, keys: string[]): Promise<void> {
    await this.host.vault.removeCached(folder, keys);
    if (this.sessionCache) for (const k of keys) this.sessionCache.delete(k);
  }

  /** Gate surface (032-B): how many records the persistent cache view holds
   * (0 when it has never been read this session). */
  get cacheViewSize(): number {
    return this.sessionCache?.size ?? 0;
  }

  /** Pending explicit generations (MapView reads this for the loading badge). */
  get pendingGenerationCount(): number {
    return this.pendingGenerations;
  }

  /** The live render store, generation-space (meters), keyed
   * `${tier|region:<id>}:${x}:${y}`. Exposed so MapView can re-surface it as
   * `view.loadedTiles` for the CLI eval-testing surface — gate scripts
   * (procgen41, phase3) iterate it directly (docs/05). Read-only by contract. */
  get renderStore(): Map<string, GeoJSON.Feature[]> {
    return this.loadedTiles;
  }

  /** The live fabric collection (MapView reads it to paint / hit-test). */
  get fabric(): FabricCollection {
    return this.fabricCollection;
  }

  /** Look up a fabric feature by id (MapView selection paths). */
  fabricFeature(id: string): FabricFeature | undefined {
    return this.fabricCollection.features.find((f) => f.id === id);
  }

  /** Display-space (fictional units) generated features — matches what's
   * rendered/queryable on the map (MapView paints these, main.ts exposes them). */
  displayGenerated(): GeoJSON.Feature[] {
    const all = this.allLoadedFeatures();
    if (!this.campaign) return all;
    const scale = this.campaign.config.scaleMetersPerUnit;
    return all.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  // ─── "Generate fabric here" and world/region generation ────────────────

  /**
   * "Generate fabric here". World tier: paints the clicked tile and appends a
   * durable manifest entry. City tier: a click inside a region
   * re-clips/repaints it (cache path); outside any region points the GM at the
   * district tool.
   */
  async generateFabricHere(
    point?: [number, number],
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<GeoJSON.Feature[]> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return [];
    const campaign = this.campaign;
    await this.loadManifest();
    if (this.campaign?.id !== campaign.id) return [];
    const tier = bandForZoom(this.host.viewport.zoom());
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.host.viewport.centerUnits();
    const px = unitsToMeters(centerUnits[0], scale);
    const py = unitsToMeters(centerUnits[1], scale);

    if (tier === "city") {
      await this.loadFabric();
      if (this.campaign?.id !== campaign.id) return [];
      const regionFeature = this.regionFeatureAt(px, py);
      if (!regionFeature) {
        if (!opts.silent) {
          this.host.notices.notify("Campaign Map: sketch a district to generate a city (pencil → district)");
        }
        return [];
      }
      const feats = await this.generateRegion(regionFeature, { force: opts.force === true });
      if (this.campaign?.id !== campaign.id) return [];
      if (!opts.silent) {
        this.host.notices.notify(`Campaign Map: generated ${feats.length} city feature${feats.length === 1 ? "" : "s"}`);
      }
      return feats.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
    }

    // World tier — unchanged: paint the clicked tile, record the request.
    const { tileX, tileY } = tileXYForPoint(px, py);
    const features = [...(await this.generateTierAt(tier, tileX, tileY, opts.force === true))];
    if (this.campaign?.id !== campaign.id) return [];
    const id = manifestEntryId(tier, tileX, tileY);
    if (!this.manifest.entries.find((e) => e.id === id)) {
      const entry: ManifestEntry = { id, tier, tileX, tileY, createdAt: Date.now() };
      this.manifest = withEntry(this.manifest, entry);
      await this.host.vault.saveManifest(campaign, this.manifest);
      await this.host.vault.appendLog(campaignFolderFromConfigPath(campaign.path), {
        ts: Date.now(),
        type: "generate-area",
        campaignId: campaign.id,
        path: generatedManifestPath(campaign),
        data: entry,
      });
    }
    if (!opts.silent) {
      this.host.notices.notify(`Campaign Map: generated ${features.length} ${tier} feature${features.length === 1 ? "" : "s"}`);
    }
    return features.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  // ─── Procgen regions ───────────────────────────────────────────────────

  /** Fabric features that carry a procgen block. */
  private regionFeatures(): FabricFeature[] {
    return this.fabricCollection.features.filter(isProcgenRegion);
  }

  /** Build a ProcgenRegion (generation-space meters) from a fabric feature
   * (display units). Polygon → a sketched region. LineString WITH a procgen
   * block → a spine CORRIDOR: the corridor half-width is the algorithm's pure
   * `corridorMaxOffset(params)`, so the generator reads
   * `region.spine` and containment is spine-aware. A block-less line is not a
   * region (a plain inert river) → null. */
  buildRegionFromFeature(feature: FabricFeature): ProcgenRegion | null {
    if (!this.campaign) return null;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const g = feature.geometry;
    if (g.type === "Polygon") {
      const ring = g.coordinates[0].map(
        ([x, y]) => [unitsToMeters(x, scale), unitsToMeters(y, scale)] as [number, number]
      );
      return makeRegion(feature.id, ring);
    }
    if (g.type === "LineString") {
      const block = feature.properties.procgen;
      const algorithm = block ? algorithmById(block.algorithm) : undefined;
      if (!block || !algorithm || !algorithm.corridorMaxOffset) return null;
      const line = g.coordinates.map(
        ([x, y]) => [unitsToMeters(x, scale), unitsToMeters(y, scale)] as [number, number]
      );
      const spine = makeSpine(feature.id, line);
      return makeCorridorRegion(feature.id, spine, algorithm.corridorMaxOffset(block.params));
    }
    return null;
  }

  /** The region feature whose polygon contains the generation-space point. */
  private regionFeatureAt(px: number, py: number): FabricFeature | undefined {
    for (const feature of this.regionFeatures()) {
      const region = this.buildRegionFromFeature(feature);
      if (region && regionContains(region, px, py)) return feature;
    }
    return undefined;
  }

  /** Selection fallback for spine (line-kind) regions: the sketch line paints
   * invisible once its generated channel exists (fabricLayers), so a click on
   * the channel may miss the 6px line hit-test. Returns the id of the spine
   * region whose CORRIDOR (exact `distanceToBoundary`) contains the
   * display-units point. Line kinds only — clicking generated city fabric has
   * never selected its district, and that stays true. */
  spineRegionIdAtDisplayPoint(unitsX: number, unitsY: number): string | null {
    if (!this.campaign) return null;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const px = unitsToMeters(unitsX, scale);
    const py = unitsToMeters(unitsY, scale);
    for (const feature of this.regionFeatures()) {
      const region = this.buildRegionFromFeature(feature);
      if (region?.spine && distanceToBoundary(region, px, py) >= 0) return feature.id;
    }
    return null;
  }

  /** Render-store key for a region-clipped tile. */
  private regionRenderKey(regionId: string, tileX: number, tileY: number): string {
    return `region:${regionId}:${tileX}:${tileY}`;
  }

  /** Every generation tile whose bbox overlaps the region polygon, in
   * deterministic (y, x) order. */
  private regionTileRange(region: ProcgenRegion): { tileX: number; tileY: number }[] {
    const min = tileXYForPoint(region.bbox.minX, region.bbox.minY);
    const max = tileXYForPoint(region.bbox.maxX, region.bbox.maxY);
    const out: { tileX: number; tileY: number }[] = [];
    for (let ty = min.tileY; ty <= max.tileY; ty++) {
      for (let tx = min.tileX; tx <= max.tileX; tx++) {
        if (this.tileOverlapsRegion(region, tileBBox(tx, ty))) out.push({ tileX: tx, tileY: ty });
      }
    }
    return out;
  }

  /** Robust rectangle/polygon overlap. */
  private tileOverlapsRegion(region: ProcgenRegion, tb: BBox): boolean {
    for (const [x, y] of region.ring) {
      if (x >= tb.minX && x <= tb.maxX && y >= tb.minY && y <= tb.maxY) return true;
    }
    const corners: [number, number][] = [
      [tb.minX, tb.minY],
      [tb.maxX, tb.minY],
      [tb.maxX, tb.maxY],
      [tb.minX, tb.maxY],
    ];
    for (const [x, y] of corners) if (regionContains(region, x, y)) return true;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      if (segmentCrossesBoundary(region, ax, ay, bx, by)) return true;
    }
    return false;
  }

  /** Do two regions overlap? (Same-algorithm regions may not overlap.) */
  private regionsOverlap(a: ProcgenRegion, b: ProcgenRegion): boolean {
    if (a.bbox.maxX < b.bbox.minX || b.bbox.maxX < a.bbox.minX) return false;
    if (a.bbox.maxY < b.bbox.minY || b.bbox.maxY < a.bbox.minY) return false;
    for (const [x, y] of a.ring) if (regionContains(b, x, y)) return true;
    for (const [x, y] of b.ring) if (regionContains(a, x, y)) return true;
    for (let i = 0; i < a.ring.length - 1; i++) {
      if (segmentCrossesBoundary(b, a.ring[i][0], a.ring[i][1], a.ring[i + 1][0], a.ring[i + 1][1])) return true;
    }
    return false;
  }

  /** The first existing same-algorithm region that overlaps `feature`'s
   * polygon (excluding itself). Public so MapView's `maybeOfferProcgen` modal
   * path can reject an overlapping district before opening the modal. */
  overlappingRegion(feature: FabricFeature, algorithmId: string): FabricFeature | undefined {
    const region = this.buildRegionFromFeature(feature);
    if (!region) return undefined;
    for (const other of this.regionFeatures()) {
      if (other.id === feature.id) continue;
      if (other.properties.procgen?.algorithm !== algorithmId) continue;
      const otherRegion = this.buildRegionFromFeature(other);
      if (otherRegion && this.regionsOverlap(region, otherRegion)) return other;
    }
    return undefined;
  }

  /** The effective generation center of a procgen region in DISPLAY units. */
  effectiveRegionCenterDisplay(feature: FabricFeature): [number, number] | null {
    const block = feature.properties.procgen;
    if (!block || !this.campaign || !algorithmById(block.algorithm)) return null;
    const region = this.buildRegionFromFeature(feature);
    if (!region) return null;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const stored = block.params.center as [number, number] | undefined;
    const centerMeters =
      Array.isArray(stored) &&
      stored.length === 2 &&
      typeof stored[0] === "number" &&
      typeof stored[1] === "number" &&
      regionContains(region, stored[0], stored[1])
        ? (stored as [number, number])
        : generationCenter(region);
    return [metersToUnits(centerMeters[0], scale), metersToUnits(centerMeters[1], scale)];
  }

  /** Whole-region network computation closure. */
  private regionCompute(worker: GenerationWorkerClient | null, feature: FabricFeature): RegionNetworkCompute {
    const block = feature.properties.procgen!;
    const algorithm = algorithmById(block.algorithm);
    return (region, constraints) => {
      this.generatorRunCounter++;
      // Both polygon AND line-kind (river/wall) regions run in the worker when
      // one is available: the job now carries `region.spine` as plain data
      // (plan 031-D), so the worker rebuilds the corridor region and river/wall
      // regen leaves the main thread. The main-thread `algorithm.generate` path
      // is retained as the fallback when no worker is up (headless tests, worker
      // load failure) — byte-identical to the worker output by construction.
      if (worker) {
        return worker.generateRegion(
          block.algorithm,
          block.seed,
          region.id,
          region.ring,
          block.params,
          constraints,
          region.spine?.points
        );
      }
      if (!algorithm) throw new Error(`unknown procgen algorithm: ${block.algorithm}`);
      return algorithm.generate(block.seed, region, block.params, constraints);
    };
  }

  /**
   * Generate a whole procgen region: ONE network compute (worker job), clip
   * to every overlapping tile, store per-tile in the render store, paint.
   */
  private async generateRegion(
    feature: FabricFeature,
    opts: { force?: boolean; preloadedCache?: Map<string, CachedTile>; fingerprints?: Map<string, string> } = {}
  ): Promise<GeoJSON.Feature[]> {
    if (!this.campaign) return [];
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return [];
    const region = this.buildRegionFromFeature(feature);
    const block = feature.properties.procgen;
    if (!region || !block) return [];
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return [];
    const folder = campaignFolderFromConfigPath(campaign.path);
    const tiles = this.regionTileRange(region);
    // A pinned-old region may only be SERVED from its cache, never recomputed
    // — the code implements the current contract, so a recompute here would
    // silently substitute different bytes under the old pin. Force-drops are
    // suppressed too (indirect demands like a constraint-edit flush land here;
    // direct GM edits were already consent-gated upstream).
    const pinnedOld = this.isPinnedOld(block, algorithm);
    const force = (opts.force ?? false) && !pinnedOld;
    // The working cache is always the persistent session view (032-B) unless a
    // batch threaded one (which IS the session view) — never a fresh disk read.
    const preloaded = opts.preloadedCache ?? (await this.cacheView(folder));
    if (force) {
      const keys = [
        regionNetworkKey(region.id),
        ...tiles.flatMap((t) => algorithm.tileGeneratorIds.map((gid) => regionTileKey(region.id, t.tileX, t.tileY, gid))),
      ];
      // Write-through drop from disk AND the session view, so the forced pass
      // recomputes fresh bytes instead of reading this region's PRE-edit records
      // back out of the view (would defeat 031-A's network-once read).
      await this.dropCached(folder, keys);
      const renderPrefix = `region:${region.id}:`;
      for (const k of [...this.loadedTiles.keys()]) if (k.startsWith(renderPrefix)) this.loadedTiles.delete(k);
      for (const k of keys) preloaded.delete(k); // covers a caller-supplied map too
    }
    if (this.campaign?.id !== campaign.id) return [];
    const ctx = this.generationContext();
    // Thread this region's fresh lower-stage upstream (the meandered river
    // channel the city consumes) as DATA. Built from the shared cache when
    // present (replay/flush) or a one-shot vault read (cascade).
    ctx.upstream = await this.buildRegionUpstream(feature, region, algorithm, preloaded, folder);
    const worker = await this.host.gen.getWorker();
    const compute = this.regionCompute(worker, feature);
    // The durable-input fingerprint stamped on every record this run writes,
    // compared on replay to catch an external edit. DAG-aware — it folds in
    // this region's strictly-lower-stage upstream fingerprints
    // (`computeRegionFingerprints`), so an upstream edit (e.g. a mountain a
    // river's slope reads) invalidates this region on replay too. Fallback to a
    // no-upstream fingerprint if the region isn't in the current collection yet
    // (a just-built feature mid-attach).
    const fingerprint =
      (opts.fingerprints ?? this.computeRegionFingerprints(ctx)).get(feature.id) ??
      regionFingerprint({
        algorithm: block.algorithm,
        seed: block.seed,
        version: block.version,
        params: block.params,
        region,
        fabricFeatures: ctx.fabricFeatures,
      });
    if (pinnedOld) {
      // Cache-only replay: a fresh network record proves the pinned bytes
      // exist (per-tile misses re-clip from it without a generator run). No
      // record ⇒ nothing renders for this region until the GM adopts —
      // visible state instead of wrong bytes.
      const net = preloaded.get(regionNetworkKey(region.id));
      if (!net || !isCacheRecordFresh(net.fingerprint, fingerprint)) {
        const renderPrefix = `region:${region.id}:`;
        for (const k of [...this.loadedTiles.keys()]) if (k.startsWith(renderPrefix)) this.loadedTiles.delete(k);
        if (!this.needsAdoption.has(feature.id)) {
          this.needsAdoption.add(feature.id);
          const name = feature.properties.name ?? `a ${algorithm.label.toLowerCase()} region`;
          this.host.notices.notify(
            `Campaign Map: ${name} needs adoption — it was generated by an older ${algorithm.label} generator and has no cached output. Select it and adopt, or run "Update all regions to current generators".`,
            10000
          );
        }
        this.repaintGenerated();
        return [];
      }
      this.needsAdoption.delete(feature.id);
    }
    this.pendingGenerations++;
    this.host.render.loadingChanged();
    const all: GeoJSON.Feature[] = [];
    try {
      for (const t of tiles) {
        if (this.campaign?.id !== campaign.id) return all;
        const feats = (
          await this.host.gen.generateRegionTile(ctx, region, algorithm.tileGeneratorIds, t.tileX, t.tileY, compute, {
            force,
            preloadedCache: preloaded,
            fingerprint,
          })
        ).filter((f) => featureTouchesBBox(f, ctx.worldBounds));
        this.loadedTiles.set(this.regionRenderKey(region.id, t.tileX, t.tileY), feats);
        all.push(...feats);
      }
    } finally {
      this.pendingGenerations--;
      this.host.render.loadingChanged();
    }
    this.repaintGenerated();
    return all;
  }

  // ─── Cross-layer regen cascade ─────────────────────────────────────────

  /**
   * Build this region's UPSTREAM artifacts: the fresh GENERATED output of
   * strictly-lower-stage regions whose `produces` this region `consumes` and
   * whose bbox (grown by the influence reach) overlaps it. Today the sole WIRED
   * consumption is `water` — the meandered river channel (`river-channel`
   * polygons) the city bridges/quays track (`indexConstraints` folds it in).
   * Vegetation stays declared-but-inert (a forest edit still recomputes the
   * city byte-identically — an accepted over-invalidation).
   *
   * The channel is read from the upstream region's NETWORK cache record: in the
   * replay/flush path it is already in the shared `cache` map (no extra IO); in
   * the cascade path (each region regenerated in `(stage, regionId)` order,
   * upstream before downstream) the upstream network was just written to the
   * vault, so a one-shot read backfills it. Returns `undefined` when there is no
   * upstream water — the generator then runs with no upstream water folded in.
   *
   * Determinism/replay: a city cache HIT returns cached bytes without ever
   * calling the generator, so this upstream is built but unused on a hit (the
   * bytes are already right); only a MISS consumes it, and by then the lower
   * stage has landed. Feature order is `(stage, id)`-deterministic.
   */
  private async buildRegionUpstream(
    feature: FabricFeature,
    region: ProcgenRegion,
    algorithm: ProcgenAlgorithm,
    cache: Map<string, CachedTile> | undefined,
    folder: string
  ): Promise<UpstreamArtifacts | undefined> {
    if (!algorithm.consumes.includes("water")) return undefined;
    const reach = MapController.CONSTRAINT_REACH;
    const rb = region.bbox;
    // Lower-stage water producers overlapping this region (computed directly so
    // it holds even for a just-attached feature not yet in the DAG node set).
    // Sorted by id for deterministic feature order.
    const upstreamFeatures = this.regionFeatures()
      .filter((f) => {
        const b = f.properties.procgen;
        const a = b ? algorithmById(b.algorithm) : undefined;
        if (!a || a.stage >= algorithm.stage || !a.produces.includes("water")) return false;
        const r = this.buildRegionFromFeature(f);
        if (!r) return false;
        const e = r.bbox;
        return !(e.maxX + reach < rb.minX || rb.maxX < e.minX - reach || e.maxY + reach < rb.minY || rb.maxY < e.minY - reach);
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (upstreamFeatures.length === 0) return undefined;
    let full: Map<string, CachedTile> | null = null;
    const water: GeoJSON.Feature[] = [];
    for (const up of upstreamFeatures) {
      const key = regionNetworkKey(up.id);
      let rec = cache?.get(key);
      if (!rec) {
        full = full ?? (await this.cacheView(folder));
        rec = full.get(key);
      }
      if (!rec) continue;
      for (const f of rec.features as unknown as GeoJSON.Feature[]) {
        const gid = (f.properties as { generatorId?: string } | null)?.generatorId;
        if (gid === "river-channel") water.push(f);
      }
    }
    return water.length > 0 ? { water } : undefined;
  }

  /** Build a `DagNode` per procgen region from the registry (stage + the
   * produces/consumes constraint kinds) and its gen-space bbox. The pure
   * `dag.ts` graph math runs over these — the controller is the only place
   * that reaches the registry, keeping `dag.ts` a host-agnostic leaf. */
  private regionDagNodes(): DagNode[] {
    const nodes: DagNode[] = [];
    for (const f of this.regionFeatures()) {
      const block = f.properties.procgen;
      const algo = block ? algorithmById(block.algorithm) : undefined;
      const region = this.buildRegionFromFeature(f);
      if (!block || !algo || !region) continue;
      nodes.push({ id: f.id, stage: algo.stage, produces: algo.produces, consumes: algo.consumes, bbox: region.bbox });
    }
    return nodes;
  }

  /**
   * Every region's staleness fingerprint, computed in `(stage, regionId)`
   * order so an upstream's fingerprint is in hand before a downstream folds it
   * in (`upstreamFingerprints`). A pure function of the durable data (blocks +
   * geometry + raw constraints + the DAG), independent of feature enumeration
   * order. Callers doing a batch (replay, cascade,
   * flush) compute it once and thread it through `generateRegion` to avoid the
   * O(n²) recompute.
   */
  private computeRegionFingerprints(ctx: ControllerGenContext): Map<string, string> {
    this.fingerprintPassCounter++;
    const nodes = this.regionDagNodes();
    const regionById = new Map<string, ProcgenRegion>();
    const blockById = new Map<string, ProcgenBlock>();
    for (const f of this.regionFeatures()) {
      const block = f.properties.procgen;
      const region = this.buildRegionFromFeature(f);
      if (block && region) {
        regionById.set(f.id, region);
        blockById.set(f.id, block);
      }
    }
    const upstream = upstreamEdges(nodes, MapController.CONSTRAINT_REACH);
    const fpMap = new Map<string, string>();
    for (const node of cascadeOrder(nodes)) {
      const region = regionById.get(node.id);
      const block = blockById.get(node.id);
      if (!region || !block) continue;
      const upFps = (upstream.get(node.id) ?? [])
        .map((id) => fpMap.get(id))
        .filter((x): x is string => x !== undefined);
      fpMap.set(
        node.id,
        regionFingerprint({
          algorithm: block.algorithm,
          seed: block.seed,
          version: block.version,
          params: block.params,
          region,
          fabricFeatures: ctx.fabricFeatures,
          upstreamFingerprints: upFps,
        })
      );
    }
    return fpMap;
  }

  /** Threshold above which a cascade asks before regenerating (cost control —
   * a continental river's knob must not silently redraw 100 cities).
   * Non-modal: a Notice + the `applyPendingCascade` command/test-API (no modal —
   * they hang CLI automation, docs/05). */
  private static readonly CASCADE_CONFIRM_THRESHOLD = 10;
  private pendingCascadeRoots: string[] | null = null;
  /** The downstream region ids the MOST RECENT cascade regenerated (excludes
   * the edited root), in cascade order. A DAG-deterministic, seed-INDEPENDENT
   * signal for gates/tests: "editing an upstream regenerated exactly these
   * dependents" holds regardless of the (feature-id-derived) region seed, where
   * an output-byte-diff would be seed-flaky (mm quantization can round a small
   * meander shift away). Reset at the start of every cascade. */
  private lastCascadeRegenerated: string[] = [];
  /** Test/gate observability for the last cascade's regenerated dependents. */
  get cascadeRegeneratedIds(): readonly string[] {
    return this.lastCascadeRegenerated;
  }
  /** The ids the MOST RECENT raw-sketch force-regen walk touched, IN THE ORDER
   * executed. The walk is `(stage, id)`-sorted (031-C), so an upstream always
   * regenerates before a downstream that reads its fresh network — this getter
   * is the seed-independent proof of that ordering (P2/P3 regression). */
  private lastForceRegenOrder: string[] = [];
  get forceRegenOrder(): readonly string[] {
    return this.lastForceRegenOrder;
  }
  /** Test/command bypass for the confirm cap — set true to auto-apply large
   * cascades (headless gates run the FULL commit path; modals hang CLI). */
  cascadeAutoConfirm = false;

  /**
   * The cascade proper: after the edited region(s) `rootIds` are regenerated,
   * regenerate their transitive DOWNSTREAM closure in
   * `(stage, regionId)` order — upstream before downstream, each once. `done`
   * carries the roots (and anything already regenerated this pass) so nothing
   * runs twice. Returns the ids it regenerated (for the summary Notice). A
   * cascade is the COMPLETION of an explicit edit — never a new trigger class
   * (explicit-only stands): it only ever RE-generates regions the GM already
   * requested, never first-time-generates.
   */
  private async cascadeDownstream(rootIds: string[], done: Set<string>, opts: RegionBatchOpts = {}): Promise<string[]> {
    this.lastCascadeRegenerated = [];
    if (!this.campaign) return [];
    const campaign = this.campaign;
    const nodes = this.regionDagNodes();
    const closure = downstreamClosure(nodes, MapController.CONSTRAINT_REACH, rootIds).filter((n) => !done.has(n.id));
    if (closure.length === 0) return [];
    if (closure.length > MapController.CASCADE_CONFIRM_THRESHOLD && !this.cascadeAutoConfirm) {
      this.pendingCascadeRoots = [...rootIds];
      this.host.notices.notify(
        `Campaign Map: that edit affects ${closure.length} downstream regions — run "Apply pending cross-layer cascade" to regenerate them`,
        8000
      );
      return [];
    }
    const regenerated: string[] = [];
    for (const node of closure) {
      if (this.campaign?.id !== campaign.id) break;
      const feature = this.regionFeatures().find((f) => f.id === node.id);
      if (!feature) continue;
      await this.generateRegion(feature, { force: true, ...opts });
      done.add(node.id);
      regenerated.push(node.id);
    }
    this.lastCascadeRegenerated = regenerated;
    if (regenerated.length > 0) this.notifyCascade(regenerated);
    return regenerated;
  }

  /** One summary Notice for a cascade ("River updated — regenerated 1 city,
   * 2 forests"). Counts by algorithm label. */
  private notifyCascade(regeneratedIds: string[]): void {
    const counts = new Map<string, number>();
    for (const id of regeneratedIds) {
      const f = this.regionFeatures().find((x) => x.id === id);
      const algo = f?.properties.procgen ? algorithmById(f.properties.procgen.algorithm) : undefined;
      const label = algo?.label ?? "region";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([label, n]) => `${n} ${label.toLowerCase()}${n === 1 ? "" : "s"}`);
    this.host.notices.notify(`Campaign Map: cascade regenerated ${parts.join(", ")}`);
  }

  /** Apply a cascade the confirm cap deferred. Command + test API (the
   * non-modal "confirm above N" affordance). */
  async applyPendingCascade(): Promise<void> {
    if (!this.pendingCascadeRoots) {
      this.host.notices.notify("Campaign Map: no pending cascade to apply");
      return;
    }
    const roots = this.pendingCascadeRoots;
    this.pendingCascadeRoots = null;
    const prev = this.cascadeAutoConfirm;
    this.cascadeAutoConfirm = true;
    try {
      await this.loadFabric();
      await this.withRepaintBatch(async () => {
        const ctx = this.generationContext();
        const opts: RegionBatchOpts = {
          fingerprints: this.computeRegionFingerprints(ctx),
          preloadedCache: await this.cacheView(campaignFolderFromConfigPath(this.campaign!.path)),
        };
        const done = new Set<string>(roots);
        for (const id of roots) {
          const feature = this.regionFeatures().find((f) => f.id === id);
          if (feature) await this.generateRegion(feature, { force: true, ...opts });
        }
        await this.cascadeDownstream(roots, done, opts);
      });
    } finally {
      this.cascadeAutoConfirm = prev;
    }
  }

  /**
   * "Regenerate fabric here": re-runs generation at this spot against CURRENT
   * constraints.
   */
  async regenerateFabricHere(point?: [number, number]): Promise<GeoJSON.Feature[]> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return [];
    const campaign = this.campaign;
    await this.loadManifest();
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return [];
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.host.viewport.centerUnits();
    const px = unitsToMeters(centerUnits[0], scale);
    const py = unitsToMeters(centerUnits[1], scale);
    const { tileX, tileY } = tileXYForPoint(px, py);

    const regionFeature = this.regionFeatureAt(px, py);
    const worldEntries = entriesForTile(this.manifest, tileX, tileY).filter((e) => e.tier !== "city");
    if (!regionFeature && worldEntries.length === 0) {
      return this.generateFabricHere(point, { force: true });
    }
    const all: GeoJSON.Feature[] = [];
    if (regionFeature) {
      all.push(...(await this.generateRegion(regionFeature, { force: true })));
      if (this.campaign?.id !== campaign.id) return [];
    }
    for (const entry of worldEntries) {
      all.push(...(await this.generateTierAt(entry.tier, tileX, tileY, true)));
      if (this.campaign?.id !== campaign.id) return [];
    }
    this.host.notices.notify(`Campaign Map: regenerated ${all.length} feature${all.length === 1 ? "" : "s"}`);
    return all.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /** "Clear generated fabric here". */
  async clearGeneratedHere(point?: [number, number]): Promise<number> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return 0;
    const campaign = this.campaign;
    await this.loadManifest();
    if (this.campaign?.id !== campaign.id) return 0;
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.host.viewport.centerUnits();
    const { tileX, tileY } = tileXYForPoint(
      unitsToMeters(centerUnits[0], scale),
      unitsToMeters(centerUnits[1], scale)
    );
    const entries = entriesForTile(this.manifest, tileX, tileY);
    if (entries.length === 0) {
      this.host.notices.notify("Campaign Map: nothing generated at this tile to clear");
      return 0;
    }
    await this.clearManifestEntries(entries);
    return entries.length;
  }

  /** "Clear all generated fabric". */
  async clearAllGenerated(): Promise<number> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return 0;
    const campaign = this.campaign;
    await this.loadManifest();
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return 0;
    const entries = [...this.manifest.entries];
    const regions = this.regionFeatures();
    if (entries.length === 0 && regions.length === 0) {
      this.host.notices.notify("Campaign Map: nothing generated to clear");
      return 0;
    }
    if (entries.length > 0) await this.clearManifestEntries(entries);
    if (this.campaign?.id !== campaign.id) return entries.length + regions.length;
    for (const feature of regions) {
      await this.stripRegionProcgen(feature, true);
      if (this.campaign?.id !== campaign.id) return entries.length + regions.length;
    }
    return entries.length + regions.length;
  }

  /** Shared clear path (world tier). */
  private async clearManifestEntries(entries: ManifestEntry[]): Promise<void> {
    if (!this.campaign || entries.length === 0) return;
    const campaign = this.campaign;
    const folder = campaignFolderFromConfigPath(campaign.path);
    const seed = campaign.config.seed;
    const keys = entries.flatMap((e) =>
      generatorIdsForBand(e.tier).map((gid) => tileKey(seed, e.tileX, e.tileY, GENERATION_ZOOM, gid))
    );
    await this.dropCached(folder, keys);
    for (const e of entries) {
      this.manifest = withoutEntry(this.manifest, e.id);
      this.loadedTiles.delete(this.tileKeyFor(e.tier, e.tileX, e.tileY));
    }
    await this.host.vault.saveManifest(campaign, this.manifest);
    this.repaintGenerated();
    await this.host.vault.appendLog(folder, {
      ts: Date.now(),
      type: "clear-area",
      campaignId: campaign.id,
      path: generatedManifestPath(campaign),
      data: { entries } as unknown as Record<string, unknown>,
    });
    this.host.notices.notify(`Campaign Map: cleared ${entries.length} generated area${entries.length === 1 ? "" : "s"}`);
  }

  // ─── Generation context + tier helpers ─────────────────────────────────

  /** Generators work in meters; a fictional campaign's own coordinates are
   * fake units. Callers must have awaited loadFabric() first. */
  private generationContext(): ControllerGenContext {
    const config = this.campaign!.config;
    const scale = config.scaleMetersPerUnit;
    const worldBounds = bboxUnitsToMeters(boundsToBBox(config.bounds ?? defaultFictionalBounds()), scale);
    const canonFeatures = this.host.canon
      .canonFeatureCollection(this.campaign!.id)
      .features.map((f) => transformFeatureUnits(f, (n) => unitsToMeters(n, scale)));
    const fabricFeatures = this.fabricCollection.features.map(
      (f) => transformFeatureUnits(f, (n) => unitsToMeters(n, scale)) as FabricFeature
    );
    return { campaign: this.campaign!, worldBounds, canonFeatures, fabricFeatures };
  }

  private tileKeyFor(band: ZoomBand, tileX: number, tileY: number): string {
    return `${band}:${tileX}:${tileY}`;
  }

  private allLoadedFeatures(): GeoJSON.Feature[] {
    return [...this.loadedTiles.values()].flat();
  }

  /** Wraps a tier generator so the worker path is used when available and
   * every actual EXECUTION bumps the gate counter. */
  private tierGenerator(worker: GenerationWorkerClient | null, id: string): TileGenerator {
    const inner: TileGenerator = worker
      ? (seed, bbox, constraints) => worker.generate(id as GeneratorId, seed, bbox, constraints)
      : this.directGenerators[id];
    return (seed, bbox, constraints) => {
      this.generatorRunCounter++;
      return inner(seed, bbox, constraints);
    };
  }

  /** Runs every generator of `tier` for one tile through the cache path. */
  private async generateTierAt(tier: ZoomBand, tileX: number, tileY: number, force: boolean): Promise<GeoJSON.Feature[]> {
    await this.loadFabric(); // sketched constraints must be in memory
    const ctx = this.generationContext();
    const worker = await this.host.gen.getWorker();
    this.pendingGenerations++;
    this.host.render.loadingChanged();
    let features: GeoJSON.Feature[];
    try {
      const results = await Promise.all(
        this.legacyIdsFor(tier).map((id) =>
          this.host.gen.generateTile(ctx, tileX, tileY, id, this.tierGenerator(worker, id), { force })
        )
      );
      features = results.flat().filter((f) => featureTouchesBBox(f, ctx.worldBounds));
    } finally {
      this.pendingGenerations--;
      this.host.render.loadingChanged();
    }
    this.loadedTiles.set(this.tileKeyFor(tier, tileX, tileY), features);
    this.repaintGenerated();
    return features;
  }

  /** Per-tile generator ids that RUN for a tier. */
  private legacyIdsFor(tier: ZoomBand): readonly string[] {
    if (tier === "city") return [];
    return generatorIdsForBand(tier);
  }

  // ─── Version adoption (consent gate for pinned-old regions) ────────────
  // A region pins the generator contract version it was created under; the
  // code implements only the current version. A pinned-old region renders
  // from its cache untouched; any action that demands regeneration first
  // needs explicit GM consent (adoption), which raises the pin, migrates
  // params, and regenerates under the current contract.

  /** Test-only simulated version bumps, keyed by algorithm id. Lets gates
   * exercise the adoption lifecycle without a real generator change. */
  private versionOverrides = new Map<string, number>();
  /** Regions whose pinned-version bytes could not be served from cache —
   * they render nothing until adopted ("needs adoption" badge). */
  private needsAdoption = new Set<string>();
  /** Scripted answers consumed before the host confirm modal is shown —
   * modals hang the CLI, so gates queue their responses here. */
  private confirmQueue: boolean[] = [];

  overrideCurrentVersionForTest(algorithmId: string, version: number | null): void {
    if (version === null) this.versionOverrides.delete(algorithmId);
    else this.versionOverrides.set(algorithmId, version);
  }

  queueConfirmResponseForTest(response: boolean): void {
    this.confirmQueue.push(response);
  }

  /** Feature ids currently flagged "needs adoption" (pinned-old, no cache). */
  needsAdoptionIds(): string[] {
    return [...this.needsAdoption].sort();
  }

  /** True when `featureId` is a procgen region pinned below its algorithm's
   * current version (override-aware) — drives the panel badge. */
  isRegionPinnedOld(featureId: string): boolean {
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    const algorithm = block ? algorithmById(block.algorithm) : undefined;
    return block !== undefined && algorithm !== undefined && this.isPinnedOld(block, algorithm);
  }

  private currentVersionOf(algorithm: ProcgenAlgorithm): number {
    return this.versionOverrides.get(algorithm.id) ?? algorithm.currentVersion;
  }

  private isPinnedOld(block: ProcgenBlock, algorithm: ProcgenAlgorithm): boolean {
    return block.version < this.currentVersionOf(algorithm);
  }

  private async confirmAdoption(message: string): Promise<boolean> {
    const queued = this.confirmQueue.shift();
    if (queued !== undefined) return queued;
    return this.host.confirm.confirm(message);
  }

  /** The adopted form of a pinned-old block: version raised to current,
   * params migrated. Pure — the caller persists and regenerates. */
  private adoptedBlock(block: ProcgenBlock, algorithm: ProcgenAlgorithm): ProcgenBlock {
    return {
      ...block,
      version: this.currentVersionOf(algorithm),
      params: migrateParamsForAdoption(algorithm, block.version, block.params),
    };
  }

  /** Consent gate for a direct GM edit that demands regenerating `feature`.
   * Returns the block the edit should build on: the block itself when the pin
   * is current, the adopted block after the GM consents, or null when the GM
   * declined — the caller must cancel the edit entirely. */
  private async consentToRegenerate(
    feature: FabricFeature,
    block: ProcgenBlock,
    algorithm: ProcgenAlgorithm
  ): Promise<ProcgenBlock | null> {
    if (!this.isPinnedOld(block, algorithm)) return block;
    const name = feature.properties.name ?? `this ${algorithm.label.toLowerCase()}`;
    const ok = await this.confirmAdoption(
      `${name} was generated by an older version of the ${algorithm.label} generator ` +
        `(v${block.version} → v${this.currentVersionOf(algorithm)}). ` +
        `Editing it will re-render it under the current version. Proceed?`
    );
    if (!ok) return null;
    this.needsAdoption.delete(feature.id);
    return this.adoptedBlock(block, algorithm);
  }

  /** Explicit adoption of one region (panel "Adopt" / adopt-all / test twin):
   * raises the pin, migrates params, regenerates, cascades, and logs a
   * `sketch-procgen-set` with before/after. No prompt — calling this IS the
   * consent. Returns false when the region is already current (no-op). */
  async adoptRegion(featureId: string): Promise<boolean> {
    if (!this.campaign) return false;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return false;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm || !this.isPinnedOld(block, algorithm)) return false;
    this.needsAdoption.delete(featureId);
    await this.setRegionProcgen(feature, this.adoptedBlock(block, algorithm), block, true, true);
    this.host.render.featureChanged(featureId);
    return true;
  }

  /** Campaign-wide adoption ("Update all regions to current generators") —
   * walks regions in (stage, id) order so upstreams adopt before dependents.
   * Returns how many regions were adopted. */
  async adoptAllRegions(): Promise<number> {
    if (!this.campaign) return 0;
    await this.loadFabric();
    const stageOf = (f: FabricFeature): number =>
      algorithmById(f.properties.procgen?.algorithm ?? "")?.stage ?? 99;
    const ordered = this.regionFeatures()
      .filter((f) => {
        const b = f.properties.procgen;
        const a = b ? algorithmById(b.algorithm) : undefined;
        return b !== undefined && a !== undefined && this.isPinnedOld(b, a);
      })
      .sort((a, b) => (stageOf(a) !== stageOf(b) ? stageOf(a) - stageOf(b) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let adopted = 0;
    for (const f of ordered) {
      if (await this.adoptRegion(f.id)) adopted++;
    }
    if (adopted > 0) {
      this.host.notices.notify(
        `Campaign Map: updated ${adopted} region${adopted === 1 ? "" : "s"} to current generators`
      );
    }
    return adopted;
  }

  /** Test twins (gates drive these headlessly — modals hang the CLI). */
  adoptRegionForTest(featureId: string): Promise<boolean> {
    return this.adoptRegion(featureId);
  }
  adoptAllForTest(): Promise<number> {
    return this.adoptAllRegions();
  }

  // ─── Region procgen lifecycle ──────────────────────────────────────────

  /** Attach a procgen block to a district shape and generate it. */
  private async setRegionProcgen(
    feature: FabricFeature,
    block: ProcgenBlock,
    before: ProcgenBlock | null,
    log: boolean,
    force = false
  ): Promise<GeoJSON.Feature[]> {
    if (!this.campaign) return [];
    const campaign = this.campaign;
    await this.loadFabric();
    const updated = withProcgen(feature, block);
    this.fabricCollection = withFeature(this.fabricCollection, updated);
    await this.host.vault.saveFabric(campaign, this.fabricCollection);
    this.host.render.repaintFabric();
    if (log) {
      await this.host.vault.appendLog(campaignFolderFromConfigPath(campaign.path), {
        ts: Date.now(),
        type: "sketch-procgen-set",
        campaignId: campaign.id,
        path: fabricPath(campaign),
        data: { featureId: feature.id, before, after: block, feature: updated } as unknown as Record<string, unknown>,
      });
    }
    const feats = await this.generateRegion(updated, { force });
    // Cross-layer cascade: a param/re-roll/center/attach edit to an UPSTREAM
    // region regenerates its downstream dependents. `force` marks a
    // GM-driven edit (setRegionParams/rerollRegion/setRegionCenter/undo pass
    // true) vs. a first-attach on create — but creating a new upstream over an
    // existing downstream should also adapt it, so cascade in both cases (a
    // no-edge region set makes this a no-op).
    await this.cascadeFromRoot(updated.id);
    return feats;
  }

  /** Regenerate the transitive downstream DAG closure of one just-regenerated
   * region root (the immediate, non-debounced edit paths). */
  private async cascadeFromRoot(rootId: string): Promise<void> {
    if (!this.campaign) return;
    // One batch: hash once + read the cache once, thread both through the
    // downstream walk, and coalesce every dependent's repaint into one (031-B).
    await this.withRepaintBatch(async () => {
      const ctx = this.generationContext();
      const fingerprints = this.computeRegionFingerprints(ctx);
      const preloadedCache = await this.cacheView(campaignFolderFromConfigPath(this.campaign!.path));
      await this.cascadeDownstream([rootId], new Set([rootId]), { fingerprints, preloadedCache });
    });
  }

  /** Strip a region's procgen block (drop its cache records + unpaint). */
  private async stripRegionProcgen(feature: FabricFeature, log: boolean): Promise<void> {
    if (!this.campaign) return;
    const campaign = this.campaign;
    const block = feature.properties.procgen;
    if (!block) return;
    await this.loadFabric();
    await this.dropRegionCacheAndUnpaint(feature);
    const stripped = withoutProcgen(feature);
    this.fabricCollection = withFeature(this.fabricCollection, stripped);
    await this.host.vault.saveFabric(campaign, this.fabricCollection);
    this.host.render.repaintFabric();
    if (log) {
      await this.host.vault.appendLog(campaignFolderFromConfigPath(campaign.path), {
        ts: Date.now(),
        type: "sketch-procgen-clear",
        campaignId: campaign.id,
        path: fabricPath(campaign),
        data: { featureId: feature.id, before: block, after: null, feature: stripped } as unknown as Record<
          string,
          unknown
        >,
      });
    }
  }

  /** Drop every cache record + render-store tile for a region and repaint. */
  private async dropRegionCacheAndUnpaint(feature: FabricFeature): Promise<void> {
    if (!this.campaign) return;
    const folder = campaignFolderFromConfigPath(this.campaign.path);
    const region = this.buildRegionFromFeature(feature);
    const block = feature.properties.procgen;
    const algorithm = block ? algorithmById(block.algorithm) : undefined;
    if (region && algorithm) {
      const tiles = this.regionTileRange(region);
      const keys = [
        regionNetworkKey(region.id),
        ...tiles.flatMap((t) => algorithm.tileGeneratorIds.map((gid) => regionTileKey(region.id, t.tileX, t.tileY, gid))),
      ];
      await this.dropCached(folder, keys);
    }
    const prefix = `region:${feature.id}:`;
    for (const k of [...this.loadedTiles.keys()]) if (k.startsWith(prefix)) this.loadedTiles.delete(k);
    this.repaintGenerated();
  }

  /** "Remove generated city here". */
  async removeGeneratedCityHere(point?: [number, number]): Promise<number> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return 0;
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return 0;
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.host.viewport.centerUnits();
    const feature = this.regionFeatureAt(unitsToMeters(centerUnits[0], scale), unitsToMeters(centerUnits[1], scale));
    if (!feature) {
      this.host.notices.notify("Campaign Map: no generated city here to remove");
      return 0;
    }
    await this.stripRegionProcgen(feature, true);
    this.host.notices.notify("Campaign Map: removed generated city (the shape stays)");
    return 1;
  }

  /** Validate params at the IO boundary, mint the persisted seed, attach the
   * block, and generate. */
  async attachProcgenAndGenerate(
    feature: FabricFeature,
    algorithm: ProcgenAlgorithm,
    params: Record<string, unknown>
  ): Promise<GeoJSON.Feature[]> {
    if (!this.campaign) return [];
    const parsedParams = algorithm.paramsSchema.parse(params);
    const block: ProcgenBlock = {
      algorithm: algorithm.id,
      seed: hashSeed(this.campaign.config.seed, feature.id),
      version: this.currentVersionOf(algorithm),
      params: parsedParams,
    };
    return this.setRegionProcgen(feature, block, null, true);
  }

  /** Headless region creation (gate/test path). `kind` defaults to `district`
   * (city) but a polygon algorithm on another kind (forest) passes its own —
   * the overlap check keys on the ALGORITHM id, so a forest overlapping a city
   * is legal (only same-algorithm regions clash). */
  async createRegionForTest(
    ringUnits: [number, number][],
    algorithmId: string,
    params: Record<string, unknown>,
    name?: string,
    kind: FabricKind = "district"
  ): Promise<{ featureId: string; count: number; outside: number }> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") throw new Error("fictional campaigns only");
    const algorithm = algorithmById(algorithmId);
    if (!algorithm) throw new Error(`unknown algorithm: ${algorithmId}`);
    await this.loadFabric();
    const closed =
      ringUnits.length >= 1 &&
      (ringUnits[0][0] !== ringUnits[ringUnits.length - 1][0] ||
        ringUnits[0][1] !== ringUnits[ringUnits.length - 1][1])
        ? [...ringUnits, ringUnits[0]]
        : [...ringUnits];
    const feature: FabricFeature = {
      type: "Feature",
      id: makeFabricId(),
      geometry: { type: "Polygon", coordinates: [closed] },
      properties: name ? { kind, name } : { kind },
    };
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.host.render.repaintFabric();
    await this.persistFabric("sketch-add", feature);
    const region = this.buildRegionFromFeature(feature);
    if (!region) throw new Error("non-polygon region");
    const validation = validateRegionRing(region.ring);
    if (!validation.ok) throw new Error(validation.reason);
    const feats = await this.attachProcgenAndGenerate(feature, algorithm, params);
    let outside = 0;
    const scan = (coords: unknown): void => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        if (distanceToBoundary(region, coords[0] as number, coords[1] as number) < -1.0) outside++;
        return;
      }
      for (const c of coords) scan(c);
    };
    for (const f of feats) scan((f.geometry as unknown as { coordinates: unknown }).coordinates);
    return { featureId: feature.id, count: feats.length, outside };
  }

  /** Kind-aware pre-generate validation for the modal path — keeps all
   * display→meters unit math on the controller. A polygon must be a valid ring
   * and not overlap a same-algorithm region; a spine (line) must be a valid
   * polyline. Spines MAY cross (tributaries are legal) so a line NEVER fails on
   * overlap. `overlap` marks the
   * polygon-clash case so the host can word its Notice. */
  validateForProcgen(feature: FabricFeature, algorithmId: string): RingValidation & { overlap?: boolean } {
    if (!this.campaign) return { ok: false, reason: "no campaign" };
    const scale = this.campaign.config.scaleMetersPerUnit;
    const g = feature.geometry;
    if (g.type === "Polygon") {
      const region = this.buildRegionFromFeature(feature);
      const v = region ? validateRegionRing(region.ring) : ({ ok: false, reason: "not a polygon" } as const);
      if (!v.ok) return v;
      if (this.overlappingRegion(feature, algorithmId)) return { ok: false, reason: "overlaps an existing shape", overlap: true };
      return { ok: true };
    }
    if (g.type === "LineString") {
      const line = g.coordinates.map(([x, y]) => [unitsToMeters(x, scale), unitsToMeters(y, scale)] as [number, number]);
      return validateSpineLine(line);
    }
    return { ok: false, reason: "unsupported geometry" };
  }

  /** Headless spine (line-kind) creation — the gate/test twin of
   * `createRegionForTest` for rivers. Sketches a line of `kind`,
   * attaches a procgen block, generates, and returns the corridor containment
   * summary (all output within `corridorMaxOffset` of the spine). Runs the FULL
   * commit path (validate, log, persist, regen) — modals hang CLI. */
  async createSpineForTest(
    coordsUnits: [number, number][],
    kind: FabricKind,
    algorithmId: string,
    params: Record<string, unknown>,
    name?: string
  ): Promise<{ featureId: string; count: number; outside: number }> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") throw new Error("fictional campaigns only");
    const algorithm = algorithmById(algorithmId);
    if (!algorithm) throw new Error(`unknown algorithm: ${algorithmId}`);
    await this.loadFabric();
    const feature: FabricFeature = {
      type: "Feature",
      id: makeFabricId(),
      geometry: { type: "LineString", coordinates: coordsUnits },
      properties: name ? { kind, name } : { kind },
    };
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.host.render.repaintFabric();
    await this.persistFabric("sketch-add", feature);
    const scale = this.campaign.config.scaleMetersPerUnit;
    const lineMeters = coordsUnits.map(([x, y]) => [unitsToMeters(x, scale), unitsToMeters(y, scale)] as [number, number]);
    const validation = validateSpineLine(lineMeters);
    if (!validation.ok) throw new Error(validation.reason);
    const feats = await this.attachProcgenAndGenerate(feature, algorithm, params);
    const updated = this.fabricCollection.features.find((f) => f.id === feature.id) ?? feature;
    const region = this.buildRegionFromFeature(updated);
    if (!region) throw new Error("could not build spine corridor");
    let outside = 0;
    const scan = (coords: unknown): void => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        if (distanceToBoundary(region, coords[0] as number, coords[1] as number) < -1.0) outside++;
        return;
      }
      for (const c of coords) scan(c);
    };
    for (const f of feats) scan((f.geometry as unknown as { coordinates: unknown }).coordinates);
    return { featureId: feature.id, count: feats.length, outside };
  }

  /** One-way migration: legacy disc domains become sketched district features
   * carrying the city procgen block. */
  private async migrateDomainsIfNeeded(): Promise<void> {
    if (!this.campaign) return;
    const campaign = this.campaign;
    await this.loadManifest();
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return;
    const domains = [...this.manifest.domains];
    if (domains.length === 0) return;
    const folder = campaignFolderFromConfigPath(campaign.path);
    const seed = campaign.config.seed;
    const scale = campaign.config.scaleMetersPerUnit;
    const oldKeys: string[] = [];
    for (const domain of domains) {
      const ringMeters = discToRing(domain as CityDomain, DISC_TO_RING_SEGMENTS);
      const ringUnits = ringMeters.map(
        ([x, y]) => [metersToUnits(x, scale), metersToUnits(y, scale)] as [number, number]
      );
      const block: ProcgenBlock = {
        algorithm: "city",
        seed: citySeedFor(seed, domain as CityDomain),
        version: 1,
        params: { profile: domain.profile },
      };
      const bare: FabricFeature = {
        type: "Feature",
        id: makeFabricId(),
        geometry: { type: "Polygon", coordinates: [ringUnits] },
        properties: { kind: "district" },
      };
      const full = withProcgen(bare, block);
      this.fabricCollection = withFeature(this.fabricCollection, full);
      await this.host.vault.appendLog(folder, {
        ts: Date.now(),
        type: "sketch-add",
        campaignId: campaign.id,
        path: fabricPath(campaign),
        data: bare as unknown as Record<string, unknown>,
      });
      await this.host.vault.appendLog(folder, {
        ts: Date.now(),
        type: "sketch-procgen-set",
        campaignId: campaign.id,
        path: fabricPath(campaign),
        data: { featureId: bare.id, before: null, after: block, feature: full } as unknown as Record<string, unknown>,
      });
      const { cellX, cellY } = anchorCellForPoint(domain.cx, domain.cy);
      oldKeys.push(tileKey(seed, cellX, cellY, GENERATION_ZOOM, "city-network"));
      for (const entry of entriesForDomain(this.manifest, domain.id)) {
        for (const gid of DOMAIN_TILE_GENERATOR_IDS) {
          oldKeys.push(tileKey(seed, entry.tileX, entry.tileY, GENERATION_ZOOM, gid));
        }
        this.manifest = withoutEntry(this.manifest, entry.id);
      }
      this.manifest = withoutDomain(this.manifest, domain.id);
    }
    await this.host.vault.saveFabric(campaign, this.fabricCollection);
    await this.host.vault.saveManifest(campaign, this.manifest);
    await this.dropCached(folder, oldKeys);
    this.host.render.repaintFabric();
    this.host.notices.notify(
      `Campaign Map: ${domains.length} city domain${domains.length === 1 ? "" : "s"} migrated to sketched district${
        domains.length === 1 ? "" : "s"
      }`
    );
  }

  /** Loads `<campaign>/Generated.json` into memory once per campaign. */
  private async loadManifest(): Promise<void> {
    if (!this.campaign) return;
    const target = this.campaign.id;
    if (this.manifestLoadedFor === target) return;
    const { manifest, invalidCount } = await this.host.vault.loadManifest(this.campaign);
    if (this.campaign?.id !== target) return; // switched campaigns mid-load
    this.manifest = manifest;
    this.manifestLoadedFor = target;
    if (invalidCount > 0) {
      this.host.notices.notify(
        `Campaign Map: skipped ${invalidCount} invalid generation request${invalidCount === 1 ? "" : "s"} in Generated.json`
      );
    }
  }

  /** Replay on campaign open. */
  async replayGeneratedManifest(): Promise<void> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return;
    const campaign = this.campaign;
    if (this.manifestReplayedFor === campaign.id) return;
    this.manifestReplayedFor = campaign.id;
    await this.loadManifest();
    await this.loadFabric(); // constraints for any cache-miss regenerate
    if (this.campaign?.id !== campaign.id) return;
    await this.migrateDomainsIfNeeded(); // mutates fabric + manifest, one-time
    if (this.campaign?.id !== campaign.id) return;

    const regions = this.regionFeatures();
    const worldEntries = this.manifest.entries.filter((e) => e.tier === "world");
    if (worldEntries.length === 0 && regions.length === 0) return;

    const ctx = this.generationContext();
    const worker = await this.host.gen.getWorker();
    const folder = campaignFolderFromConfigPath(campaign.path);
    const cached = await this.cacheView(folder);
    const seed = campaign.config.seed;
    this.pendingGenerations++;
    this.host.render.loadingChanged();
    try {
      // World-tier entries: cache hit or deterministic regenerate.
      for (const entry of worldEntries) {
        if (this.campaign?.id !== campaign.id) return; // switched mid-replay
        const perGenerator = await Promise.all(
          this.legacyIdsFor(entry.tier).map((gid) => {
            const hit = cached.get(tileKey(seed, entry.tileX, entry.tileY, GENERATION_ZOOM, gid));
            if (hit) return Promise.resolve(hit.features as unknown as GeoJSON.Feature[]);
            return this.host.gen.generateTile(ctx, entry.tileX, entry.tileY, gid, this.tierGenerator(worker, gid));
          })
        );
        const features = perGenerator.flat().filter((f) => featureTouchesBBox(f, ctx.worldBounds));
        this.loadedTiles.set(this.tileKeyFor(entry.tier, entry.tileX, entry.tileY), features);
      }
      // Region tier: regenerate each region from the sketch layer, sharing the
      // one cache read (cache-hit per-tile clips, else recompute network once).
      // Walk in `(stage, regionId)` order — one fixed, data-independent
      // sequence — so a stage-1 recompute lands before a stage-3 read of its
      // output. Fingerprints (incl. upstream DAG deps) precomputed ONCE and
      // threaded, avoiding an O(n²) recompute.
      const fpMap = this.computeRegionFingerprints(ctx);
      const stageOf = (f: FabricFeature): number =>
        algorithmById(f.properties.procgen?.algorithm ?? "")?.stage ?? 99;
      const orderedRegions = [...regions].sort((a, b) =>
        stageOf(a) !== stageOf(b) ? stageOf(a) - stageOf(b) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      );
      for (const feature of orderedRegions) {
        if (this.campaign?.id !== campaign.id) return;
        await this.generateRegion(feature, { preloadedCache: cached, fingerprints: fpMap });
      }
    } finally {
      this.pendingGenerations--;
      this.host.render.loadingChanged();
    }
    this.repaintGenerated();
  }

  /** Loads `<campaign>/Fabric.geojson` into memory once per campaign. */
  async loadFabric(): Promise<void> {
    if (!this.campaign) return;
    const target = this.campaign.id;
    if (this.fabricLoadedFor === target) return;
    const { fabric, invalidCount } = await this.host.vault.loadFabric(this.campaign);
    if (this.campaign?.id !== target) return; // switched campaigns mid-load
    this.fabricCollection = fabric;
    this.fabricLoadedFor = target;
    if (invalidCount > 0) {
      this.host.notices.notify(
        `Campaign Map: skipped ${invalidCount} invalid fabric feature${invalidCount === 1 ? "" : "s"} in Fabric.geojson`
      );
    }
    this.host.render.repaintFabric();
  }

  // ─── Constraint / region regen debounce ────────────────────────────────

  queueConstraintRegen(feature: FabricFeature): void {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return;
    this.pendingConstraintFeatures.push(feature);
    this.host.render.armRegenFlush();
  }

  queueRegionRegen(featureId: string): void {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return;
    this.pendingRegionRegen.add(featureId);
    this.host.render.armRegenFlush();
  }

  /** How far (in meters) a sketched feature can influence generated output. */
  private static readonly CONSTRAINT_REACH = 200;

  /** One debounce flush. Called by the host's regen timer. */
  async flushSketchRegen(): Promise<void> {
    const regionIds = [...this.pendingRegionRegen];
    this.pendingRegionRegen.clear();
    const edited = this.pendingConstraintFeatures;
    this.pendingConstraintFeatures = [];
    if (!this.campaign) return;
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return;
    // ONE batch for the whole flush: hash once, read the cache once, coalesce
    // every region's repaint into a single paint (031-B). Both views are
    // threaded through the roots regen, the raw-sketch reach, and the cascade so
    // the pass never re-hashes O(R²) or re-reads the `.mapcache` per region.
    await this.withRepaintBatch(async () => {
      const ctx = this.generationContext();
      const opts: RegionBatchOpts = {
        fingerprints: this.computeRegionFingerprints(ctx),
        preloadedCache: await this.cacheView(campaignFolderFromConfigPath(campaign.path)),
      };
      const done = new Set<string>();
      // Merge the queued region-edit roots with the raw-sketch bbox reach into
      // ONE `(stage, id)`-sorted worklist and force-regen them in a single walk
      // (031-C). A downstream (city) can no longer be regenerated before an
      // upstream (river) it reads just because it sorts earlier in the fabric
      // file — an upstream's fresh network always lands first (fixes P2/P3).
      const roots = regionIds.filter((id) => this.regionFeatures().some((f) => f.id === id));
      const worklist = new Set<string>([...roots, ...this.affectedRegionIds(edited)]);
      await this.forceRegenInStageOrder(worklist, done, opts);
      if (this.campaign?.id !== campaign.id) return;
      // Cross-layer cascade: ONE coalesced walk downstream of every region
      // regenerated by a queued procgen-region edit this flush (a drag storm
      // coalesced into one cascade). Scope is unchanged from before 031-C —
      // only the region-edit roots seed the DAG closure; the raw-sketch reach
      // already regenerated its direct consumers in the stage-ordered walk
      // above (consumption-aware fan-out downstream of a raw edit is plan 033).
      if (roots.length > 0 && this.campaign?.id === campaign.id) {
        await this.cascadeDownstream(roots, done, opts);
      }
    });
  }

  /** The procgen-region ids whose bbox (in gen-space meters) comes within
   * `CONSTRAINT_REACH` of any edited raw-sketch feature — the blanket bbox
   * reach a sketch edit fans out to (kind-blind for now; consumption-aware
   * scoping is plan 033). Pure geometry, no regen. */
  private affectedRegionIds(edited: FabricFeature[]): string[] {
    if (!this.campaign || edited.length === 0) return [];
    const scale = this.campaign.config.scaleMetersPerUnit;
    const regions = new Map<string, ProcgenRegion>();
    for (const rf of this.regionFeatures()) {
      const region = this.buildRegionFromFeature(rf);
      if (region) regions.set(rf.id, region);
    }
    const affected = new Set<string>();
    const reach = MapController.CONSTRAINT_REACH;
    for (const f of edited) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const scan = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === "number" && typeof coords[1] === "number") {
          const x = unitsToMeters(coords[0] as number, scale);
          const y = unitsToMeters(coords[1] as number, scale);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          return;
        }
        for (const c of coords) scan(c);
      };
      scan(f.geometry.coordinates);
      if (!Number.isFinite(minX)) continue;
      for (const [id, d] of [...regions].map(([id, r]) => [id, r.bbox] as const)) {
        const intersects =
          minX - reach <= d.maxX && maxX + reach >= d.minX && minY - reach <= d.maxY && maxY + reach >= d.minY;
        if (intersects) affected.add(id);
      }
    }
    return [...affected];
  }

  /**
   * Force-regenerate a set of regions in ONE `(stage, id)`-sorted walk (031-C):
   * an upstream (lower stage) always regenerates — and writes its fresh network
   * to the shared cache view — BEFORE a downstream (higher stage) reads it, so
   * the raw-sketch channel can never leave a downstream stamped-fresh over
   * stale-upstream bytes (research P2/P3). Records the executed order (reset per
   * call) for the regression test. Skips ids already in `done`.
   */
  private async forceRegenInStageOrder(ids: Iterable<string>, done: Set<string>, opts: RegionBatchOpts): Promise<void> {
    this.lastForceRegenOrder = [];
    if (!this.campaign) return;
    const campaign = this.campaign;
    const seen = new Set<string>();
    const features: FabricFeature[] = [];
    for (const id of ids) {
      if (done.has(id) || seen.has(id)) continue;
      seen.add(id);
      const f = this.regionFeatures().find((x) => x.id === id);
      if (f) features.push(f);
    }
    const stageOf = (f: FabricFeature): number => algorithmById(f.properties.procgen?.algorithm ?? "")?.stage ?? 99;
    features.sort((a, b) => (stageOf(a) !== stageOf(b) ? stageOf(a) - stageOf(b) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const feature of features) {
      if (this.campaign?.id !== campaign.id) return;
      await this.generateRegion(feature, { force: true, ...opts });
      done.add(feature.id);
      this.lastForceRegenOrder.push(feature.id);
    }
  }

  private async regenerateAffectedTiles(edited: FabricFeature[], done: Set<string>, opts: RegionBatchOpts = {}): Promise<void> {
    if (!this.campaign || edited.length === 0) return;
    await this.forceRegenInStageOrder(this.affectedRegionIds(edited), done, opts);
  }

  // ─── Sketch persistence + edit commit ──────────────────────────────────

  private async persistFabric(logType: "sketch-add" | "sketch-remove", feature: FabricFeature): Promise<void> {
    if (!this.campaign) return;
    try {
      await this.host.vault.saveFabric(this.campaign, this.fabricCollection);
      await this.host.vault.appendLog(campaignFolderFromConfigPath(this.campaign.path), {
        ts: Date.now(),
        type: logType,
        campaignId: this.campaign.id,
        path: fabricPath(this.campaign),
        data: feature as unknown as Record<string, unknown>,
      });
    } catch (err) {
      this.host.notices.notify(`Campaign Map: saving sketch failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  /** Add a just-finished sketch draft: stash it in the collection, repaint,
   * persist (`sketch-add` log), and queue the constraint regen a new shape
   * triggers. The host handles the toast + any procgen offer. Sync (the persist
   * fires-and-forgets). */
  addSketchedFeature(feature: FabricFeature): void {
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.host.render.repaintFabric();
    void this.persistFabric("sketch-add", feature);
    this.queueConstraintRegen(feature);
  }

  /** Remove a fabric feature (select→delete lifecycle) — a region takes its
   * generated city + cache records with it. */
  deleteFabricFeature(id: string): void {
    if (!this.campaign) return;
    const feature = this.fabricCollection.features.find((f) => f.id === id);
    if (!feature) return;
    this.fabricCollection = withoutFeature(this.fabricCollection, feature.id);
    this.host.render.selectionInvalidated(feature.id);
    this.host.render.repaintFabric();
    if (isProcgenRegion(feature)) void this.dropRegionCacheAndUnpaint(feature);
    void this.persistFabric("sketch-remove", feature);
    this.host.notices.notify(`Campaign Map: deleted sketched ${feature.properties.kind} (⌘Z / ↶ undo to restore)`);
    this.queueConstraintRegen(feature);
  }

  /** Build the after-feature from a geometry replacement and run the full
   * commit path (validate, log, persist, regen). */
  async commitGeometryEdit(featureId: string, geometry: FabricGeometry, opts: { debounce: boolean }): Promise<boolean> {
    if (!this.campaign) return false;
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return false;
    const before = this.fabricCollection.features.find((f) => f.id === featureId);
    if (!before) return false;
    const after: FabricFeature = { ...before, geometry };
    return this.commitSketchEdit(before, after, opts);
  }

  /** The one commit path for a whole-feature sketch edit (geometry OR name). */
  async commitSketchEdit(before: FabricFeature, after: FabricFeature, opts: { debounce: boolean }): Promise<boolean> {
    if (!this.campaign) return false;
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return false;
    const geomChanged = JSON.stringify(before.geometry) !== JSON.stringify(after.geometry);
    const propsChanged = JSON.stringify(before.properties) !== JSON.stringify(after.properties);
    if (!geomChanged && !propsChanged) return true;

    let adoptionBefore: ProcgenBlock | null = null;
    if (geomChanged && isProcgenRegion(after)) {
      const algoId = after.properties.procgen!.algorithm;
      if (after.geometry.type === "LineString") {
        // Spine (line-kind) region: validate the reshaped line; spines MAY
        // cross (tributaries are legal) so there is NO overlap
        // rejection — do not treat a crossing like an overlapping polygon.
        const scale = this.campaign.config.scaleMetersPerUnit;
        const line = after.geometry.coordinates.map(
          ([x, y]) => [unitsToMeters(x, scale), unitsToMeters(y, scale)] as [number, number]
        );
        const validation = validateSpineLine(line);
        if (!validation.ok) {
          this.host.notices.notify(`Campaign Map: can't reshape the river — ${validation.reason}. Reverted.`, 7000);
          this.revertSketchEdit(before);
          return false;
        }
      } else {
        const region = this.buildRegionFromFeature(after);
        const validation = region ? validateRegionRing(region.ring) : ({ ok: false, reason: "not a polygon" } as const);
        if (!validation.ok) {
          this.host.notices.notify(`Campaign Map: can't reshape the city — ${validation.reason}. Reverted.`, 7000);
          this.revertSketchEdit(before);
          return false;
        }
        if (this.overlappingRegion(after, algoId)) {
          this.host.notices.notify("Campaign Map: that edit would overlap another city — they can't overlap. Reverted.", 7000);
          this.revertSketchEdit(before);
          return false;
        }
      }
      // Consent gate: reshaping a pinned-old region regenerates it, so it
      // needs adoption first; a decline cancels the whole edit.
      const block = after.properties.procgen!;
      const algorithm = algorithmById(block.algorithm);
      if (algorithm) {
        const base = await this.consentToRegenerate(after, block, algorithm);
        if (!base) {
          this.revertSketchEdit(before);
          return false;
        }
        if (base !== block) {
          adoptionBefore = block;
          after = withProcgen(after, base);
        }
      }
    }

    this.fabricCollection = withFeature(this.fabricCollection, after);
    this.host.render.repaintFabric();
    await this.host.vault.saveFabric(campaign, this.fabricCollection);
    if (adoptionBefore) {
      // The adoption itself is its own undoable step, logged before the edit.
      await this.host.vault.appendLog(campaignFolderFromConfigPath(campaign.path), {
        ts: Date.now(),
        type: "sketch-procgen-set",
        campaignId: campaign.id,
        path: fabricPath(campaign),
        data: {
          featureId: after.id,
          before: adoptionBefore,
          after: after.properties.procgen,
          feature: after,
        } as unknown as Record<string, unknown>,
      });
    }
    await this.host.vault.appendLog(campaignFolderFromConfigPath(campaign.path), {
      ts: Date.now(),
      type: "sketch-edit",
      campaignId: campaign.id,
      path: fabricPath(campaign),
      data: { featureId: before.id, before, after } as unknown as Record<string, unknown>,
    });
    // Reset the controller's edit baseline + the panel to the persisted state.
    this.host.render.featureChanged(after.id, { reselect: true });
    if (!geomChanged) return true; // property-only (name) — no regen

    if (isProcgenRegion(after)) {
      const stored = after.properties.procgen!.params.center as [number, number] | undefined;
      const region = this.buildRegionFromFeature(after);
      if (Array.isArray(stored) && region && !regionContains(region, stored[0], stored[1])) {
        this.host.notices.notify("Campaign Map: city center is outside the district — using automatic center", 6000);
      }
      if (opts.debounce) this.queueRegionRegen(after.id);
      else {
        await this.generateRegion(after, { force: true });
        await this.cascadeFromRoot(after.id); // geometry edit → cascade
      }
    } else {
      if (opts.debounce) this.queueConstraintRegen(after);
      else await this.regenerateAffectedTiles([after], new Set());
    }
    return true;
  }

  /** Undo an optimistic (uncommitted) geometry edit. */
  private revertSketchEdit(before: FabricFeature): void {
    this.fabricCollection = withFeature(this.fabricCollection, before);
    this.host.render.repaintFabric();
    this.host.render.featureChanged(before.id, { reselect: true });
  }

  // ─── Region param actions (panel + test API) ───────────────────────────

  /** Change a region's procgen params (v1: profile). */
  async setRegionParams(featureId: string, params: Record<string, unknown>): Promise<void> {
    if (!this.campaign) return;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return;
    const base = await this.consentToRegenerate(feature, block, algorithm);
    if (!base) return; // GM declined adoption — the edit is cancelled
    const parsedParams = algorithm.paramsSchema.parse(params);
    const newBlock: ProcgenBlock = { ...base, params: parsedParams };
    await this.setRegionProcgen(feature, newBlock, block, true, true);
    this.host.render.featureChanged(featureId);
  }

  /** Apply a template (preset) to a region: resolve the preset → params
   * (merged over the existing params so orthogonal keys like `center`
   * survive a template change) and run the setRegionParams commit path. City
   * presets carry no `presetId`, so the block stays `{ profile }`-shaped. */
  async setRegionPreset(featureId: string, presetId: string): Promise<void> {
    if (!this.campaign) return;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return;
    const preset = presetById(algorithm, presetId);
    if (!preset) return;
    await this.setRegionParams(featureId, { ...block.params, ...preset.params });
  }

  /** Re-roll a region: a NEW seed. */
  async rerollRegion(featureId: string): Promise<void> {
    if (!this.campaign) return;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return;
    const base = await this.consentToRegenerate(feature, block, algorithm);
    if (!base) return; // GM declined adoption — the re-roll is cancelled
    const newBlock: ProcgenBlock = { ...base, seed: hashSeed(block.seed, "reroll") };
    await this.setRegionProcgen(feature, newBlock, block, true, true);
    this.host.render.featureChanged(featureId);
  }

  /** Regenerate a region against CURRENT constraints (no block change, no log). */
  async regenerateRegionById(featureId: string): Promise<GeoJSON.Feature[]> {
    if (!this.campaign) return [];
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    if (!feature || !isProcgenRegion(feature)) return [];
    return this.generateRegion(feature, { force: true });
  }

  /** Remove a region's generated city (strip the block; shape stays inert). */
  async removeRegionById(featureId: string): Promise<void> {
    if (!this.campaign) return;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    if (!feature) return;
    await this.stripRegionProcgen(feature, true);
    this.host.render.featureChanged(featureId);
  }

  /** Create a plain (non-procgen) fabric feature headlessly (gate path). */
  async createFabricForTest(kind: FabricKind, coordsUnits: [number, number][], name?: string): Promise<string> {
    if (!this.campaign) throw new Error("no campaign");
    await this.loadFabric();
    const geometry: FabricGeometry = isPolygonKind(kind)
      ? { type: "Polygon", coordinates: [[...coordsUnits, coordsUnits[0]]] }
      : { type: "LineString", coordinates: coordsUnits };
    const feature: FabricFeature = {
      type: "Feature",
      id: makeFabricId(),
      geometry,
      properties: name ? { kind, name } : { kind },
    };
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.host.render.repaintFabric();
    await this.persistFabric("sketch-add", feature);
    return feature.id;
  }

  /** Move open-list vertex `index` to `pt` (display units). */
  async moveVertex(id: string, index: number, pt: [number, number]): Promise<boolean> {
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === id);
    if (!feature) return false;
    return this.commitGeometryEdit(id, withVertexMoved(feature.geometry, index, pt), { debounce: false });
  }

  /** Insert a vertex on edge `edgeIndex` at `pt` (display units). */
  async insertVertex(id: string, edgeIndex: number, pt: [number, number]): Promise<boolean> {
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === id);
    if (!feature) return false;
    return this.commitGeometryEdit(id, withVertexInserted(feature.geometry, edgeIndex, pt), { debounce: false });
  }

  /** Delete open-list vertex `index` (min-vertex floored — false if refused). */
  async deleteVertex(id: string, index: number): Promise<boolean> {
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === id);
    if (!feature || !canDeleteVertex(feature.geometry)) return false;
    return this.commitGeometryEdit(id, withVertexDeleted(feature.geometry, index), { debounce: false });
  }

  /** Snapshot the generated feature ids currently painted for a region. */
  regionFeatureIds(regionId: string, generatorId?: string): string[] {
    const prefix = `region:${regionId}:`;
    const ids: string[] = [];
    for (const [k, feats] of this.loadedTiles) {
      if (!k.startsWith(prefix)) continue;
      for (const f of feats) {
        if (f.id === undefined || f.id === null) continue;
        if (generatorId && (f.properties as Record<string, unknown> | null)?.generatorId !== generatorId) continue;
        ids.push(String(f.id));
      }
    }
    return ids;
  }

  /** Containment report for a region's currently-painted output (gate a/b). */
  regionContainmentReport(regionId: string): { count: number; outside: number } {
    const feature = this.fabricCollection.features.find((f) => f.id === regionId);
    const region = feature ? this.buildRegionFromFeature(feature) : null;
    if (!region) return { count: 0, outside: 0 };
    const prefix = `region:${regionId}:`;
    let count = 0;
    let outside = 0;
    const scan = (coords: unknown): void => {
      if (!Array.isArray(coords)) return;
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        if (distanceToBoundary(region, coords[0] as number, coords[1] as number) < -1.0) outside++;
        return;
      }
      for (const c of coords) scan(c);
    };
    for (const [k, feats] of this.loadedTiles) {
      if (!k.startsWith(prefix)) continue;
      for (const f of feats) {
        count++;
        scan((f.geometry as unknown as { coordinates: unknown }).coordinates);
      }
    }
    return { count, outside };
  }

  /**
   * Numeric elevation samples for a mountain region — the point-evaluable
   * height field rebuilt from the persisted seed + params, then sampled at a
   * deterministic set of gen-space points derived from the region bbox. Returns
   * `{h, dx, dy}` per contained sample (mm/rounded), NEVER rendered bytes
   * (compare heights, not PNGs). Two calls across a regenerate MUST be
   * identical — the field is a pure
   * function of (seed, position), so this proves the elevation model is
   * deterministic and correctly wired. Empty for a non-mountain region.
   */
  regionElevationReport(regionId: string): { x: number; y: number; h: number; dx: number; dy: number }[] {
    const feature = this.fabricCollection.features.find((f) => f.id === regionId);
    const block = feature?.properties.procgen;
    if (!feature || !block || block.algorithm !== "mountain") return [];
    const region = this.buildRegionFromFeature(feature);
    if (!region) return [];
    const p = block.params as Record<string, unknown>;
    const terrain = (typeof p.terrain === "string" ? p.terrain : "alpine") as MountainTerrain;
    const amplitude = typeof p.amplitude === "number" ? p.amplitude : 0.6;
    const roughness = typeof p.roughness === "number" ? p.roughness : 0.5;
    const field = mountainHeightField(block.seed, region, { terrain, amplitude, roughness });
    const b = region.bbox;
    const round = (v: number): number => Math.round(v * 1e6) / 1e6;
    const out: { x: number; y: number; h: number; dx: number; dy: number }[] = [];
    // Fixed 5×5 grid across the bbox interior; keep only contained samples so
    // the point set is a pure function of the (deterministic) region geometry.
    for (let i = 1; i <= 5; i++) {
      for (let j = 1; j <= 5; j++) {
        const x = b.minX + ((b.maxX - b.minX) * i) / 6;
        const y = b.minY + ((b.maxY - b.minY) * j) / 6;
        if (distanceToBoundary(region, x, y) <= 0) continue;
        const s = field(x, y);
        out.push({ x: round(x), y: round(y), h: round(s.v), dx: round(s.dx), dy: round(s.dy) });
      }
    }
    return out;
  }

  /**
   * Per-campaign DEM vertical scale K (encoded-terrarium-meters per campaign-
   * meter) — the fictional-CRS reconciliation for hillshade. A pure function of
   * `scaleMetersPerUnit`, so it is constant across tiles
   * (seam-safe). 0 when no campaign is loaded.
   */
  demVerticalScale(): number {
    if (!this.campaign) return 0;
    return demVerticalScale(this.campaign.config.scaleMetersPerUnit);
  }

  /**
   * Campaign-wide elevation field for the DEM: the UNION of every sketched
   * mountain region's height field (masked to its ring), rebuilt from persisted
   * seeds/params — so it is a pure function of the durable sketch layer
   * (point-evaluable, deterministic). Base continental terrain + water carve are
   * out of scope here; `heightAt` stays untouched. Returns
   * the field plus a `digest` fingerprinting the mountain set (id + seed + params
   * + ring geometry): the DEM cache treats a record with a different digest as a
   * stale miss, so a mountain edit/re-roll is picked up without reactive tile
   * invalidation. `null` when no campaign is loaded.
   */
  campaignElevationSnapshot(): { field: ElevationField; digest: string } | null {
    if (!this.campaign) return null;
    const fields: ElevationField[] = [];
    const parts: string[] = [];
    // Deterministic order (feature id) so the digest is stable across enumerations.
    const mountains = this.regionFeatures()
      .filter((f) => f.properties.procgen?.algorithm === "mountain")
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const feature of mountains) {
      const block = feature.properties.procgen!;
      const region = this.buildRegionFromFeature(feature);
      if (!region) continue;
      const p = block.params as Record<string, unknown>;
      const terrain = (typeof p.terrain === "string" ? p.terrain : "alpine") as MountainTerrain;
      const amplitude = typeof p.amplitude === "number" ? p.amplitude : 0.6;
      const roughness = typeof p.roughness === "number" ? p.roughness : 0.5;
      fields.push(mountainHeightField(block.seed, region, { terrain, amplitude, roughness }));
      parts.push(
        JSON.stringify({ id: feature.id, seed: block.seed, terrain, amplitude, roughness, ring: region.ring })
      );
    }
    const digest = `k${this.demVerticalScale()}|${parts.join("|")}`;
    return { field: unionFields(fields), digest };
  }

  /** Set (or clear, with `null`) a region's persisted generation center. */
  async setRegionCenter(featureId: string, centerDisplay: [number, number] | null): Promise<boolean> {
    if (!this.campaign) return false;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return false;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return false;
    if (centerDisplay === null && !("center" in block.params)) return false; // already automatic — no-op
    const base = await this.consentToRegenerate(feature, block, algorithm);
    if (!base) {
      this.host.render.featureChanged(featureId, { reselect: true, panel: false }); // snap the handle back
      return false;
    }
    const nextParams = { ...base.params };
    if (centerDisplay === null) {
      delete nextParams.center;
    } else {
      const scale = this.campaign.config.scaleMetersPerUnit;
      const centerMeters: [number, number] = [
        unitsToMeters(centerDisplay[0], scale),
        unitsToMeters(centerDisplay[1], scale),
      ];
      const region = this.buildRegionFromFeature(feature);
      if (region && !regionContains(region, centerMeters[0], centerMeters[1])) {
        this.host.notices.notify("Campaign Map: city center must be inside the district — ignored");
        this.host.render.featureChanged(featureId, { reselect: true, panel: false }); // snap the handle back
        return false;
      }
      nextParams.center = centerMeters;
    }
    const parsedParams = algorithm.paramsSchema.parse(nextParams);
    const newBlock: ProcgenBlock = { ...base, params: parsedParams };
    await this.setRegionProcgen(feature, newBlock, block, true, true);
    this.host.render.featureChanged(featureId, { reselect: true });
    return true;
  }

  // ─── Undo ───────────────────────────────────────────────────────────────

  async undoLastEdit(): Promise<void> {
    if (!this.campaign) return;
    const entries = await this.host.vault.readLog(this.campaign.id);
    if (entries.length === 0) {
      this.host.notices.notify("Campaign Map: nothing to undo");
      return;
    }
    const last = entries[entries.length - 1];
    if (last.type === "create" || last.type === "move") {
      // Note-file undo lives in the host (Obsidian TFile ops).
      await this.host.notes.undoNoteEntry(last);
      return;
    }
    if (last.type === "sketch-add" || last.type === "sketch-remove") {
      const parsed = FabricFeatureSchema.safeParse(last.data);
      if (!parsed.success) {
        this.host.notices.notify("Campaign Map: can't undo sketch — malformed log entry");
        return;
      }
      await this.loadFabric();
      if (last.type === "sketch-add") {
        const live = this.fabricCollection.features.find((f) => f.id === parsed.data.id);
        if (live && isProcgenRegion(live)) await this.dropRegionCacheAndUnpaint(live);
        this.fabricCollection = withoutFeature(this.fabricCollection, parsed.data.id);
      } else {
        this.fabricCollection = withFeature(this.fabricCollection, parsed.data);
      }
      this.host.render.selectionInvalidated(parsed.data.id);
      await this.host.vault.saveFabric(this.campaign, this.fabricCollection);
      this.host.render.repaintFabric();
      this.host.notices.notify(
        last.type === "sketch-add"
          ? `Campaign Map: undid sketched ${parsed.data.properties.kind}`
          : `Campaign Map: restored deleted ${parsed.data.properties.kind}`
      );
      if (last.type === "sketch-remove" && isProcgenRegion(parsed.data)) {
        await this.generateRegion(parsed.data);
      }
      this.queueConstraintRegen(parsed.data);
    } else if (last.type === "sketch-procgen-set") {
      const parsed = ProcgenLogDataSchema.safeParse(last.data);
      if (!parsed.success) {
        this.host.notices.notify("Campaign Map: can't undo — malformed log entry");
        return;
      }
      await this.loadFabric();
      const feature = this.fabricCollection.features.find((f) => f.id === parsed.data.featureId) ?? parsed.data.feature;
      if (parsed.data.before === null) {
        await this.stripRegionProcgen(feature, true);
        this.host.notices.notify("Campaign Map: removed the generated city");
      } else {
        await this.setRegionProcgen(withoutProcgen(feature), parsed.data.before, null, false, true);
        this.host.notices.notify("Campaign Map: reverted the city settings");
      }
      this.host.render.featureChanged(parsed.data.featureId);
    } else if (last.type === "sketch-procgen-clear") {
      const parsed = ProcgenLogDataSchema.safeParse(last.data);
      if (!parsed.success || !parsed.data.before) {
        this.host.notices.notify("Campaign Map: can't undo — malformed log entry");
        return;
      }
      await this.loadFabric();
      const base = this.fabricCollection.features.find((f) => f.id === parsed.data.featureId) ?? parsed.data.feature;
      await this.setRegionProcgen(withoutProcgen(base), parsed.data.before, null, false, true);
      this.host.render.featureChanged(parsed.data.featureId);
      this.host.notices.notify("Campaign Map: restored the generated city");
    } else if (last.type === "sketch-edit") {
      const parsed = SketchEditDataSchema.safeParse(last.data);
      if (!parsed.success) {
        this.host.notices.notify("Campaign Map: can't undo edit — malformed log entry");
        return;
      }
      await this.loadFabric();
      const before = parsed.data.before;
      this.fabricCollection = withFeature(this.fabricCollection, before);
      await this.host.vault.saveFabric(this.campaign, this.fabricCollection);
      this.host.render.repaintFabric();
      this.host.render.featureChanged(before.id, { reselect: true });
      if (isProcgenRegion(before)) {
        // Undo re-runs the SAME cascade with the restored inputs:
        // deterministic → the downstream output is restored byte-identically.
        await this.generateRegion(before, { force: true });
        await this.cascadeFromRoot(before.id);
      } else this.queueConstraintRegen(before);
      this.host.notices.notify(`Campaign Map: undid ${before.properties.kind} edit`);
    } else if (last.type === "generate-area") {
      const entry = ManifestEntrySchema.safeParse(last.data);
      if (!entry.success) {
        this.host.notices.notify("Campaign Map: can't undo generate — malformed log entry");
        return;
      }
      await this.loadManifest();
      await this.clearManifestEntries([entry.data]);
    } else if (last.type === "clear-area") {
      const parsed = ManifestEntrySchema.array().safeParse((last.data as { entries?: unknown }).entries);
      if (!parsed.success) {
        this.host.notices.notify("Campaign Map: can't undo clear — malformed log entry");
        return;
      }
      await this.loadManifest();
      for (const entry of parsed.data) {
        this.manifest = withEntry(this.manifest, entry);
        await this.generateTierAt(entry.tier, entry.tileX, entry.tileY, false);
      }
      await this.host.vault.saveManifest(this.campaign, this.manifest);
      this.host.notices.notify(`Campaign Map: restored ${parsed.data.length} generated area${parsed.data.length === 1 ? "" : "s"}`);
    }
  }

  /** Sketch-mode undo: removes the most-recently-added, still-live sketched
   * feature (mutation-log-derived). */
  async undoLastSketch(): Promise<void> {
    if (!this.campaign) return;
    const entries = await this.host.vault.readLog(this.campaign.id);
    const target = sketchUndoTarget(entries);
    if (!target) {
      this.host.notices.notify("Campaign Map: nothing to undo");
      return;
    }
    await this.loadFabric();
    const live = this.fabricCollection.features.find((f) => f.id === target.id);
    if (live && isProcgenRegion(live)) await this.dropRegionCacheAndUnpaint(live);
    this.fabricCollection = withoutFeature(this.fabricCollection, target.id);
    this.host.render.selectionInvalidated(target.id, { keepPanel: true });
    this.host.render.repaintFabric();
    await this.persistFabric("sketch-remove", live ?? target);
    this.host.notices.notify(`Campaign Map: undid sketched ${target.properties.kind}`);
    this.queueConstraintRegen(target);
  }

  /** Sketch-mode undo dispatcher (Cmd/Ctrl-Z and the ↶ button). */
  async undoInSketchMode(): Promise<void> {
    if (!this.campaign) return;
    const entries = await this.host.vault.readLog(this.campaign.id);
    const tail = entries[entries.length - 1];
    if (tail && (tail.type === "sketch-edit" || tail.type === "sketch-procgen-set" || tail.type === "sketch-procgen-clear")) {
      await this.undoLastEdit();
      return;
    }
    await this.undoLastSketch();
  }
}

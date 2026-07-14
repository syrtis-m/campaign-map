/**
 * MapController (plan 021 §2.4) — the host-agnostic lifecycle brain extracted
 * from MapView. Owns generation / regen / clear / undo / replay / migration /
 * region-procgen / sketch-commit orchestration and the state those touch
 * (render store, manifest, fabric collection, gate counters). It talks to the
 * outside world ONLY through the narrow interfaces below (vault gateway, gen
 * gateway, canon gateway, note-ops, notice sink, render sink, viewport) — so
 * it has NO DOM / MapLibre / Obsidian imports and is fully testable against a
 * FakeHost with an in-memory vault (same purity rule as src/gen/, CLAUDE.md).
 *
 * MapView constructs one of these with Obsidian-backed gateways and becomes
 * wiring + paint; every gate-facing test API method on MapView forwards here.
 * This is a REFACTOR — behavior is byte-identical to the pre-extraction
 * MapView (plan 021 §2.4: zero behavior change).
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
import { algorithmById, algorithmForKind, presetById, type ProcgenAlgorithm } from "../gen/procgen/registry";
import { mountainHeightField, type MountainTerrain } from "../gen/mountain";
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

/** Data shape of a `sketch-procgen-set` / `sketch-procgen-clear` log entry
 * (plan 020 §8.4): the region's before/after procgen block + the post-op
 * feature, so undo can strip a block (dropping its cache) or re-attach one
 * (regenerating). Parsed at the undo IO boundary. */
const ProcgenLogDataSchema = z.object({
  featureId: z.string(),
  before: ProcgenBlockSchema.nullable(),
  after: ProcgenBlockSchema.nullable(),
  feature: FabricFeatureSchema,
});

/** Data shape of a `sketch-edit` log entry (plan 020 §9): the full
 * FabricFeature before and after a geometry/property edit. Zod-validated at
 * the undo IO boundary (bad entry → Notice, never a crash). */
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
    opts?: { force?: boolean; preloadedCache?: Map<string, CachedTile> }
  ): Promise<GeoJSON.Feature[]>;
}

/** Read-only canon (location index) access — the generators take canon pins as
 * constraints (plan 019 Phase 3). */
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
  render: RenderSink;
  viewport: Viewport;
}

export class MapController {
  campaign: ParsedCampaign | null = null;

  /**
   * Render store for generated fabric, keyed `${tier}:${tileX}:${tileY}` —
   * generation-space (meters), same as `.mapcache/` itself. Fed ONLY by
   * (a) manifest replay on campaign open and (b) explicit generate actions
   * (plan 019: no viewport dispatch, no generate-on-pan, ever). Sketch-
   * corridor elaborations live under their own `sketch:<id>:` key namespace.
   */
  private loadedTiles = new Map<string, GeoJSON.Feature[]>();
  /** In-memory mirror of `<campaign>/Generated.json` (plan 019, D1). */
  private manifest: GeneratedManifest = emptyManifest();
  private manifestLoadedFor: string | null = null;
  /** Guards manifest replay so it runs once per campaign open. */
  private manifestReplayedFor: string | null = null;
  /** In-memory mirror of `<campaign>/Fabric.geojson` (plan 013). */
  private fabricCollection: FabricCollection = emptyFabric();
  private fabricLoadedFor: string | null = null;
  /** Explicit generate/replay runs in flight — drives the loading badge. */
  private pendingGenerations = 0;
  /** Gate counter (plan 019 Phase 2): actual generator EXECUTIONS. */
  private generatorRunCounter = 0;
  /** Sketch edits accumulated while the regen debounce is pending. */
  private pendingConstraintFeatures: FabricFeature[] = [];
  /** Region ids whose OWN geometry changed and need a force-regen next flush. */
  private pendingRegionRegen = new Set<string>();

  /** World tier only since v3.4 — city fabric is domain-scoped (citynet). */
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
    }
    this.campaign = campaign;
    return { switched };
  }

  // ─── Gate / test / paint surface ───────────────────────────────────────

  /** Test/perf-gate surface: how many tile entries the render store holds. */
  get loadedTileCount(): number {
    return this.loadedTiles.size;
  }

  /** Gate surface (plan 019 Phase 2): actual generator executions this session. */
  get generatorRunCount(): number {
    return this.generatorRunCounter;
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
   * "Generate fabric here" (plan 019/020). World tier: paints the clicked tile
   * and appends a durable manifest entry. City tier: a click inside a region
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

  // ─── Procgen regions (plan 020) ────────────────────────────────────────

  /** Fabric features that carry a procgen block. */
  private regionFeatures(): FabricFeature[] {
    return this.fabricCollection.features.filter(isProcgenRegion);
  }

  /** Build a ProcgenRegion (generation-space meters) from a fabric feature
   * (display units). Polygon → a sketched region (plan 020). LineString WITH a
   * procgen block → a spine CORRIDOR (plan 022 §2): the corridor half-width is
   * the algorithm's pure `corridorMaxOffset(params)`, so the generator reads
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

  /** Render-store key for a region-clipped tile (plan 020 §3.3). */
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

  /** Do two regions overlap? (Same-algorithm regions may not — plan 020 §6.) */
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

  /** Whole-region network computation closure (plan 020 §5). */
  private regionCompute(worker: GenerationWorkerClient | null, feature: FabricFeature): RegionNetworkCompute {
    const block = feature.properties.procgen!;
    const algorithm = algorithmById(block.algorithm);
    return (region, constraints) => {
      this.generatorRunCounter++;
      // Spine (line-kind) regions run on the MAIN thread: the worker protocol
      // reconstructs a region from `region.ring` via makeRegion (plan 020) and
      // would lose `region.spine` — and rivers are geometry-light, so the
      // direct path is both correct and cheap (plan 022 §2 deviation, logged in
      // DECISIONS). Polygon regions keep the worker path unchanged.
      if (worker && !region.spine) {
        return worker.generateRegion(block.algorithm, block.seed, region.id, region.ring, block.params, constraints);
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
    opts: { force?: boolean; preloadedCache?: Map<string, CachedTile> } = {}
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
    let preloaded = opts.preloadedCache;
    if (opts.force) {
      const keys = [
        regionNetworkKey(region.id),
        ...tiles.flatMap((t) => algorithm.tileGeneratorIds.map((gid) => regionTileKey(region.id, t.tileX, t.tileY, gid))),
      ];
      await this.host.vault.removeCached(folder, keys);
      const renderPrefix = `region:${region.id}:`;
      for (const k of [...this.loadedTiles.keys()]) if (k.startsWith(renderPrefix)) this.loadedTiles.delete(k);
      preloaded = preloaded ?? new Map();
    } else if (!preloaded) {
      preloaded = await this.host.vault.readCached(folder);
    }
    if (this.campaign?.id !== campaign.id) return [];
    const ctx = this.generationContext();
    const worker = await this.host.gen.getWorker();
    const compute = this.regionCompute(worker, feature);
    this.pendingGenerations++;
    this.host.render.loadingChanged();
    const all: GeoJSON.Feature[] = [];
    try {
      for (const t of tiles) {
        if (this.campaign?.id !== campaign.id) return all;
        const feats = (
          await this.host.gen.generateRegionTile(ctx, region, algorithm.tileGeneratorIds, t.tileX, t.tileY, compute, {
            force: opts.force,
            preloadedCache: preloaded,
          })
        ).filter((f) => featureTouchesBBox(f, ctx.worldBounds));
        this.loadedTiles.set(this.regionRenderKey(region.id, t.tileX, t.tileY), feats);
        all.push(...feats);
      }
    } finally {
      this.pendingGenerations--;
      this.host.render.loadingChanged();
    }
    this.host.render.repaintGenerated();
    return all;
  }

  /**
   * "Regenerate fabric here" (plan 019/020, D4): re-runs generation at this
   * spot against CURRENT constraints.
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

  /** "Clear generated fabric here" (plan 019, D4). */
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

  /** "Clear all generated fabric" (plan 019/020, D4). */
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
    await this.host.vault.removeCached(folder, keys);
    for (const e of entries) {
      this.manifest = withoutEntry(this.manifest, e.id);
      this.loadedTiles.delete(this.tileKeyFor(e.tier, e.tileX, e.tileY));
    }
    await this.host.vault.saveManifest(campaign, this.manifest);
    this.host.render.repaintGenerated();
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
    this.host.render.repaintGenerated();
    return features;
  }

  /** Per-tile generator ids that RUN for a tier. */
  private legacyIdsFor(tier: ZoomBand): readonly string[] {
    if (tier === "city") return [];
    return generatorIdsForBand(tier);
  }

  // ─── Region procgen lifecycle (plan 020 §8.1/§8.4) ────────────────────

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
    return this.generateRegion(updated, { force });
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
      await this.host.vault.removeCached(folder, keys);
    }
    const prefix = `region:${feature.id}:`;
    for (const k of [...this.loadedTiles.keys()]) if (k.startsWith(prefix)) this.loadedTiles.delete(k);
    this.host.render.repaintGenerated();
  }

  /** "Remove generated city here" (plan 020 §8.4). */
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
   * block, and generate (plan 020 §3.1). */
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
      version: 1,
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

  /** Kind-aware pre-generate validation for the modal path (plan 020 §8.1 /
   * plan 022 §2) — keeps all display→meters unit math on the controller. A
   * polygon must be a valid ring and not overlap a same-algorithm region; a
   * spine (line) must be a valid polyline. Spines MAY cross (tributaries are
   * legal, plan 022 §3.1) so a line NEVER fails on overlap. `overlap` marks the
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
   * `createRegionForTest` for rivers (plan 022 §2). Sketches a line of `kind`,
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

  /** One-way migration (plan 020 §3.2): pre-v4 disc domains become sketched
   * district features carrying the city procgen block. */
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
    await this.host.vault.removeCached(folder, oldKeys);
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

  /** Replay on campaign open (plan 020 §8.2). */
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
    const cached = await this.host.vault.readCached(folder);
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
      for (const feature of regions) {
        if (this.campaign?.id !== campaign.id) return;
        await this.generateRegion(feature, { preloadedCache: cached });
      }
    } finally {
      this.pendingGenerations--;
      this.host.render.loadingChanged();
    }
    this.host.render.repaintGenerated();
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

  // ─── Constraint / region regen debounce (plan 019/020 §8.3) ────────────

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

  /** One debounce flush (plan 020 §8.3). Called by the host's regen timer. */
  async flushSketchRegen(): Promise<void> {
    const regionIds = [...this.pendingRegionRegen];
    this.pendingRegionRegen.clear();
    const edited = this.pendingConstraintFeatures;
    this.pendingConstraintFeatures = [];
    if (!this.campaign) return;
    const campaign = this.campaign;
    await this.loadFabric();
    if (this.campaign?.id !== campaign.id) return;
    const done = new Set<string>();
    for (const id of regionIds) {
      const feature = this.regionFeatures().find((f) => f.id === id);
      if (!feature) continue;
      await this.generateRegion(feature, { force: true });
      done.add(id);
      if (this.campaign?.id !== campaign.id) return;
    }
    if (edited.length > 0) await this.regenerateAffectedTiles(edited, done);
  }

  private async regenerateAffectedTiles(edited: FabricFeature[], done: Set<string>): Promise<void> {
    if (!this.campaign || edited.length === 0) return;
    const campaign = this.campaign;
    if (this.campaign?.id !== campaign.id) return;
    const scale = campaign.config.scaleMetersPerUnit;

    const regionFeatures = this.regionFeatures();
    const regions = new Map<string, { feature: FabricFeature; region: ProcgenRegion }>();
    for (const rf of regionFeatures) {
      const region = this.buildRegionFromFeature(rf);
      if (region) regions.set(rf.id, { feature: rf, region });
    }
    const affected = new Map<string, FabricFeature>();
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
      const reach = MapController.CONSTRAINT_REACH;
      for (const { feature, region } of regions.values()) {
        const d = region.bbox;
        const intersects =
          minX - reach <= d.maxX && maxX + reach >= d.minX && minY - reach <= d.maxY && maxY + reach >= d.minY;
        if (intersects) affected.set(feature.id, feature);
      }
    }
    for (const feature of affected.values()) {
      if (done.has(feature.id)) continue; // already force-regenerated this flush
      if (this.campaign?.id !== campaign.id) return;
      await this.generateRegion(feature, { force: true });
    }
  }

  // ─── Sketch persistence + edit commit (plan 013 / 020 §9) ──────────────

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

  /** Add a just-finished sketch draft (plan 013): stash it in the collection,
   * repaint, persist (`sketch-add` log), and queue the constraint regen a new
   * shape triggers. The host handles the toast + any procgen offer. Sync (the
   * persist fires-and-forgets, matching the pre-extraction finalizeSketchDraft). */
  addSketchedFeature(feature: FabricFeature): void {
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.host.render.repaintFabric();
    void this.persistFabric("sketch-add", feature);
    this.queueConstraintRegen(feature);
  }

  /** Remove a fabric feature (select→delete lifecycle) — a region takes its
   * generated city + cache records with it (plan 020 §8.4). */
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

    if (geomChanged && isProcgenRegion(after)) {
      const algoId = after.properties.procgen!.algorithm;
      if (after.geometry.type === "LineString") {
        // Spine (line-kind) region (plan 022 §2): validate the reshaped line;
        // spines MAY cross (tributaries are legal) so there is NO overlap
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
    }

    this.fabricCollection = withFeature(this.fabricCollection, after);
    this.host.render.repaintFabric();
    await this.host.vault.saveFabric(campaign, this.fabricCollection);
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
      else await this.generateRegion(after, { force: true });
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

  // ─── Region param actions (panel + test API, plan 020 §9 item 4/7) ─────

  /** Change a region's procgen params (v1: profile). */
  async setRegionParams(featureId: string, params: Record<string, unknown>): Promise<void> {
    if (!this.campaign) return;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return;
    const parsedParams = algorithm.paramsSchema.parse(params);
    const newBlock: ProcgenBlock = { ...block, params: parsedParams };
    await this.setRegionProcgen(feature, newBlock, block, true, true);
    this.host.render.featureChanged(featureId);
  }

  /** Apply a template (preset) to a region (plan 022 §1): resolve the preset →
   * params (merged over the existing params so orthogonal keys like `center`
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
    const newBlock: ProcgenBlock = { ...block, seed: hashSeed(block.seed, "reroll") };
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
   * Numeric elevation samples for a mountain region (plan 023 §3 gate) — the
   * point-evaluable height field rebuilt from the persisted seed + params, then
   * sampled at a deterministic set of gen-space points derived from the region
   * bbox. Returns `{h, dx, dy}` per contained sample (mm/rounded), NEVER
   * rendered bytes (plan 023 §4.2 DEM-determinism trap: compare heights, not
   * PNGs). Two calls across a regenerate MUST be identical — the field is a pure
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

  /** Set (or clear, with `null`) a region's persisted generation center. */
  async setRegionCenter(featureId: string, centerDisplay: [number, number] | null): Promise<boolean> {
    if (!this.campaign) return false;
    await this.loadFabric();
    const feature = this.fabricCollection.features.find((f) => f.id === featureId);
    const block = feature?.properties.procgen;
    if (!feature || !block) return false;
    const algorithm = algorithmById(block.algorithm);
    if (!algorithm) return false;
    const nextParams = { ...block.params };
    if (centerDisplay === null) {
      if (!("center" in nextParams)) return false; // already automatic — no-op
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
    const newBlock: ProcgenBlock = { ...block, params: parsedParams };
    await this.setRegionProcgen(feature, newBlock, block, true, true);
    this.host.render.featureChanged(featureId, { reselect: true });
    return true;
  }

  // ─── Undo (plan 013/019/020) ───────────────────────────────────────────

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
      if (isProcgenRegion(before)) await this.generateRegion(before, { force: true });
      else this.queueConstraintRegen(before);
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

  /** Sketch-mode undo (plan 016): removes the most-recently-added, still-live
   * sketched feature (mutation-log-derived). */
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

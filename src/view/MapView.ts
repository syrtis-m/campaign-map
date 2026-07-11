import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, MarkdownRenderer, Notice, TFile, setIcon, FuzzySuggestModal, App } from "obsidian";
import maplibregl, { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import type { ParsedCampaign } from "../model/campaignConfig";
import { LOCATION_TYPES, VISIBILITY_VALUES, type ParsedLocation, type Visibility } from "../model/locationNote";
import { buildConnectionFeatures } from "../model/connections";
import { parseSessionPath, sessionPathFeature } from "../model/sessionPath";
import { appendLogEntry, campaignFolderFromConfigPath } from "../model/mutationLog";
import {
  FABRIC_KINDS,
  FabricFeatureSchema,
  emptyFabric,
  isPolygonKind,
  makeFabricId,
  sketchUndoTarget,
  withFeature,
  withoutFeature,
  type FabricCollection,
  type FabricFeature,
  type FabricKind,
} from "../model/fabric";
import { fabricPath, loadFabric, saveFabric } from "../vault/fabricStore";
import {
  emptyManifest,
  entriesForTile,
  manifestEntryId,
  withEntry,
  withoutEntry,
  ManifestEntrySchema,
  type GeneratedManifest,
  type ManifestEntry,
} from "../model/generatedManifest";
import {
  generatedManifestPath,
  loadGeneratedManifest,
  saveGeneratedManifest,
} from "../vault/generatedManifestStore";
import { readCachedTiles, removeCachedTiles } from "../model/tileCache";
import { FABRIC_LAYER_IDS } from "../map/themes/fabricLayers";
import { SketchController } from "./SketchController";
import { computeScaleBar, defaultFictionalBounds } from "../map/fictionalCRS";
import { obsidianNativeStyle, readObsidianCssTokens } from "../map/theme";
import { glyphsUrlTemplate, createTransformRequest } from "../map/glyphs";
import { registerVaultBasemap, vaultBasemapBounds } from "../map/pmtilesVaultProtocol";
import { buildThemeStyle, isHandcraftedTheme, HANDCRAFTED_THEMES } from "../map/themes";
import { genreForCampaign } from "../gen/naming/cultures";
import { cultureAt } from "../gen/naming/regions";
import {
  generateCityStreets,
  generateDistricts,
  generateCityBlocks,
  generateCorridorStreets,
  CORRIDOR_HALO,
  CORRIDOR_INFLUENCE,
} from "../gen/city";
import { generateWorldRegions, generateRoutes } from "../gen/world";
import {
  tileXYForPoint,
  bandForZoom,
  generatorIdsForBand,
  tileKey,
  GENERATION_ZOOM,
  type ZoomBand,
} from "../gen/cache/tileGrid";
import type { BBox } from "../gen/spatialHash";
import {
  generateTile,
  type GenerationContext,
  type TileGenerator,
} from "../map/generation/generationService";
import type { GeneratorId } from "../gen/worker/generationWorker";
import type { GenerationWorkerClient } from "../map/generation/workerClient";
import { addConnection, removeConnection, setLocationVisibility } from "../vault/locationOps";
import { importNotes } from "../vault/importOps";
import { importGeojson } from "../model/importGeojson";
import { QuickAddModal } from "./QuickAddModal";
import { LocationSearchModal } from "./LocationSearchModal";
import { ThemeSwitcherModal } from "./ThemeSwitcherModal";
import { PopulateAreaModal } from "./PopulateAreaModal";
import { ImportFileModal } from "./ImportFileModal";
import { generateName } from "../gen/naming/culture";
import { populateArea } from "../gen/populate";
import { hashSeed } from "../gen/rng";
import { renderPoster, posterDimensions } from "../map/posterExport";
import { buildAtlasPdf, type AtlasLocation } from "../map/atlasExport";
import type CampaignMapPlugin from "../main";

export const VIEW_TYPE_MAP = "campaign-map-view";

/** Picks a session note (`<campaign>/Sessions/*.md`) whose body's `[[wikilinks]]`
 * become a travel path (plan 009) — same FuzzySuggestModal pattern as
 * `ThemeSwitcherModal`/`CampaignPickerModal`. */
class SessionSearchModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private sessions: TFile[],
    private onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Show session travel path...");
  }

  getItems(): TFile[] {
    return this.sessions;
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

function boundsToBBox(bounds: [number, number, number, number]): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] };
}

/**
 * Generators (src/gen/) are sized in meters — tuned against docs/06 §3's
 * ranges (streamline dsep 20-60m-equiv, block min-area 400m^2, etc). A
 * fictional campaign's own coordinates are fake units where 1 unit =
 * `scaleMetersPerUnit` meters (fictionalCRS.ts), so every point crossing
 * that boundary needs converting or a small campaign (e.g. an 800m-wide
 * town) would barely fill a fraction of one generation tile.
 */
function unitsToMeters(u: number, scaleMetersPerUnit: number): number {
  return u * scaleMetersPerUnit;
}
function metersToUnits(m: number, scaleMetersPerUnit: number): number {
  return m / scaleMetersPerUnit;
}
function bboxUnitsToMeters(b: BBox, scale: number): BBox {
  return {
    minX: unitsToMeters(b.minX, scale),
    minY: unitsToMeters(b.minY, scale),
    maxX: unitsToMeters(b.maxX, scale),
    maxY: unitsToMeters(b.maxY, scale),
  };
}
function mapCoordinates(coords: unknown, fn: (n: number) => number): unknown {
  if (typeof coords === "number") return fn(coords);
  if (Array.isArray(coords)) return coords.map((c) => mapCoordinates(c, fn));
  return coords;
}
function transformFeatureUnits(feature: GeoJSON.Feature, fn: (n: number) => number): GeoJSON.Feature {
  const geometry = feature.geometry as unknown as { type: string; coordinates: unknown };
  return {
    ...feature,
    geometry: { ...geometry, coordinates: mapCoordinates(geometry.coordinates, fn) } as GeoJSON.Geometry,
  };
}

/**
 * `GENERATION_TILE_SIZE` is anchored at the generation-space world origin
 * with a fixed size, not to the campaign's own bounds — so a tile can
 * legitimately extend past a small campaign's edges (docs/06 §3 tuning
 * ranges are sized in meters, campaigns can be much smaller than one tile).
 * Filter emitted features to those actually touching `worldBounds` so
 * generated fabric doesn't visibly spill beyond the campaign's own box.
 */
function featureTouchesBBox(feature: GeoJSON.Feature, bbox: BBox): boolean {
  let touches = false;
  const check = (coords: unknown): void => {
    if (touches) return;
    if (typeof coords === "number") return;
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      if (x >= bbox.minX && x <= bbox.maxX && y >= bbox.minY && y <= bbox.maxY) touches = true;
      return;
    }
    for (const c of coords) check(c);
  };
  check((feature.geometry as unknown as { coordinates: unknown }).coordinates);
  return touches;
}

interface MapViewState extends Record<string, unknown> {
  campaignId?: string;
}

export class MapView extends ItemView {
  map: MapLibreMap | null = null;
  campaign: ParsedCampaign | null = null;
  private plugin: CampaignMapPlugin;
  private mapContainer!: HTMLDivElement;
  private scaleBarEl!: HTMLDivElement;
  private warningBadgeEl!: HTMLDivElement;
  private droppedPinPopup: maplibregl.Popup | null = null;
  private placeCardPopup: maplibregl.Popup | null = null;
  private hoverPopup: maplibregl.Popup | null = null;
  private scaleControl: maplibregl.ScaleControl | null = null;
  /** Guards the "load" handler's fallback `applyCampaign()` call (below) —
   * see onOpen() for why it's a fallback, not the primary path. */
  private campaignAppliedOnce = false;
  private loadingIndicatorEl!: HTMLDivElement;
  private toolbarEl!: HTMLDivElement;
  /** The campaign's overview (fit-bounds) zoom — the anchor for the three
   * focus levels. Captured once per campaign right after fitBounds so the
   * levels stay put when the user pans/zooms or switches theme (a restyle
   * wipes the layers' zoom ranges, so they're re-applied from this). */
  private overviewZoom: number | null = null;
  /** The three "focus level" snap zooms [Wide, Mid, Close] = overview + [0,3,6],
   * relative to the campaign so a fictional world (overview ~z5) and a real
   * city (overview ~z11) both get the same three-step feel. */
  private focusZooms: [number, number, number] | null = null;
  private focusReadoutEl: HTMLElement | null = null;
  /** Last-shown per-session travel path (plan 009, Phase 5), if any — kept
   * in memory (not derived from the index like `connections`) so it can be
   * re-applied to the `session-path` source after a theme switch wipes and
   * rebuilds every source (mirrors how `refreshConnections` re-derives
   * `connections` on the same rebuild). */
  private currentSessionPathFeature: GeoJSON.Feature | null = null;
  /** Guards a running replayCampaign() loop so a second invocation, a
   * campaign switch, or the view closing stops it cleanly instead of two
   * loops racing to fly the camera around. */
  private replayToken = 0;
  /** Sketch mode (plan 013): in-memory mirror of `<campaign>/Fabric.geojson`
   * — MapView is the only writer, so edits mutate this and save through
   * fabricStore; `refreshFabric()` re-applies it after any style rebuild. */
  private fabricCollection: FabricCollection = emptyFabric();
  private fabricLoadedFor: string | null = null;
  private sketchMode = false;
  private sketchKind: FabricKind = "road";
  /** Plan 014: whether newly drawn features are literal sketches or
   * generator feed ("a la Sims landscaping"). */
  private sketchDraftMode: "literal" | "generate" = "literal";
  private sketchController: SketchController | null = null;
  private sketchBarEl: HTMLDivElement | null = null;
  private selectedFabricId: string | null = null;
  private sketchKeyHandler: ((ev: KeyboardEvent) => void) | null = null;
  /** Toolbar pencil button — kept so sketch mode can show a pressed/active
   * state on it (plan 016: re-click to exit is only discoverable if the button
   * looks toggled). */
  private pencilBtnEl: HTMLButtonElement | null = null;
  /** Debounce for auto-elaborating generate-mode corridors on commit (plan
   * 016 "instant generation") — cleared on mode exit / onClose so it can never
   * fire after teardown. */
  private sketchAutoBuildTimer: number | null = null;

  /**
   * Render store for generated fabric, keyed `${tier}:${tileX}:${tileY}` —
   * generation-space (meters), same as `.mapcache/` itself. Fed ONLY by
   * (a) manifest replay on campaign open and (b) explicit generate actions
   * (plan 019: no viewport dispatch, no generate-on-pan, ever). Sketch-
   * corridor elaborations live under their own `sketch:<id>:` key namespace.
   */
  private loadedTiles = new Map<string, GeoJSON.Feature[]>();
  /** In-memory mirror of `<campaign>/Generated.json` (plan 019, D1) — the
   * durable record of areas the GM asked to generate. MapView is the only
   * writer, same authority model as `fabricCollection`. */
  private manifest: GeneratedManifest = emptyManifest();
  private manifestLoadedFor: string | null = null;
  /** Guards manifest replay so it runs once per campaign open, not on every
   * config-change setCampaign() (theme switches etc. repaint from
   * `loadedTiles` via refreshGeneratedSource, no replay needed). */
  private manifestReplayedFor: string | null = null;
  /** Explicit generate/replay runs in flight — drives the loading badge. */
  private pendingGenerations = 0;
  /** Gate counter (plan 019 Phase 2): actual generator EXECUTIONS (cache
   * hits don't count) — pan/zoom must leave this untouched. */
  private generatorRunCounter = 0;

  private readonly directGenerators: Record<string, TileGenerator> = {
    "city-street": generateCityStreets,
    "city-district": generateDistricts,
    "city-block": generateCityBlocks,
    "world-region": generateWorldRegions,
    "world-route": generateRoutes,
  };

  constructor(leaf: WorkspaceLeaf, plugin: CampaignMapPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_MAP;
  }

  getDisplayText(): string {
    return this.campaign ? `Map: ${this.campaign.name}` : "Campaign map";
  }

  getIcon(): string {
    return "map";
  }

  async setState(state: MapViewState, result: ViewStateResult): Promise<void> {
    const campaignId = typeof state?.campaignId === "string" ? state.campaignId : undefined;
    if (campaignId) {
      const campaign = this.plugin.getCampaign(campaignId);
      if (campaign) this.setCampaign(campaign);
    }
    return super.setState(state, result);
  }

  getState(): MapViewState {
    return { campaignId: this.campaign?.id };
  }

  setCampaign(campaign: ParsedCampaign): void {
    const isFirstApply = !this.campaign;
    const themeChanged =
      this.campaign?.config.theme !== campaign.config.theme ||
      this.campaign?.config.basemap !== campaign.config.basemap;
    if (this.campaign && this.campaign.id !== campaign.id) {
      this.loadedTiles.clear();
      this.manifest = emptyManifest();
      this.manifestLoadedFor = null;
      this.manifestReplayedFor = null;
      this.currentSessionPathFeature = null;
      this.replayToken++; // stop any in-flight replay from the previous campaign
      this.fabricCollection = emptyFabric();
      this.fabricLoadedFor = null;
      this.selectedFabricId = null;
      if (this.sketchMode) this.toggleSketchMode(); // exit sketch mode on campaign switch
    }
    this.campaign = campaign;
    void this.loadFabricForCampaign();
    this.refreshHeaderTitle();
    if (this.map && (isFirstApply || themeChanged)) {
      this.map.setStyle(this.buildStyle(campaign));
      this.map.once("styledata", () => {
        this.refreshSource();
        this.refreshGeneratedSource();
        this.applyFocusReveal();
      });
    }
    if (this.map) this.applyCampaign();
    // Plan 019: the ONLY generation on open is replaying the GM's own past
    // requests (cache hit or deterministic regenerate) — pan/zoom never
    // dispatches generators.
    void this.replayGeneratedManifest();
  }

  switchTheme(): void {
    if (!this.campaign) return;
    new ThemeSwitcherModal(this.app, this.campaign.config.theme, (themeId) => {
      void this.app.fileManager.processFrontMatter(
        this.app.vault.getAbstractFileByPath(this.campaign!.path) as TFile,
        (fm) => {
          fm.theme = themeId;
        }
      );
    }).open();
  }

  private buildStyle(campaign: ParsedCampaign): StyleSpecification {
    const { config } = campaign;
    let basemap: { sourceId: string; url: string } | undefined;
    if (config.crs === "real" && config.basemap) {
      basemap = {
        sourceId: `basemap-${campaign.id}`,
        url: registerVaultBasemap(this.app, config.basemap),
      };
    }
    if (isHandcraftedTheme(config.theme)) {
      return buildThemeStyle(HANDCRAFTED_THEMES[config.theme], glyphsUrlTemplate(), basemap);
    }
    return obsidianNativeStyle(readObsidianCssTokens(this.containerEl), glyphsUrlTemplate(), basemap);
  }

  /**
   * Same style as buildStyle(), but with the geojson sources pre-populated with
   * the campaign's CURRENT content (canon pins, generated fabric, connection
   * lines). The offscreen export map (renderPoster) is a fresh MapLibre instance
   * whose sources would otherwise be empty — so without this, poster/atlas
   * renders show the title + terrain background but no locations. Baking the
   * data straight into the style avoids any post-load setData timing.
   */
  private buildExportStyle(campaign: ParsedCampaign): StyleSpecification {
    const style = this.buildStyle(campaign);
    const state = this.plugin.getCampaignState(campaign.id);
    const setSourceData = (id: string, data: GeoJSON.FeatureCollection): void => {
      const src = style.sources?.[id] as { type?: string; data?: unknown } | undefined;
      if (src && src.type === "geojson") src.data = data;
    };
    setSourceData("canon", state.index.toFeatureCollection());
    setSourceData("generated", { type: "FeatureCollection", features: this.generated });
    setSourceData("connections", {
      type: "FeatureCollection",
      features: buildConnectionFeatures(state.index.all()),
    });
    return style;
  }

  private refreshHeaderTitle(): void {
    // Obsidian snapshots getDisplayText() when the tab/header DOM is first built and
    // doesn't re-query it on setState/updateHeader(); patch both title nodes directly.
    const text = this.getDisplayText();
    const leaf = this.leaf as unknown as { tabHeaderInnerTitleEl?: HTMLElement };
    leaf.tabHeaderInnerTitleEl?.setText(text);
    this.containerEl
      .closest(".workspace-leaf")
      ?.querySelector(".view-header-title")
      ?.replaceChildren(document.createTextNode(text));
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("campaign-map-view");

    this.mapContainer = container.createDiv({ cls: "campaign-map-canvas" });
    this.scaleBarEl = container.createDiv({ cls: "campaign-map-scale-bar" });
    this.warningBadgeEl = container.createDiv({ cls: "campaign-map-warning-badge" });
    this.warningBadgeEl.style.display = "none";
    this.loadingIndicatorEl = container.createDiv({ cls: "campaign-map-loading-indicator" });
    this.loadingIndicatorEl.setText("Generating…");
    this.loadingIndicatorEl.style.display = "none";
    this.toolbarEl = container.createDiv({ cls: "campaign-map-toolbar" });
    this.buildToolbar();
    this.buildFocusControl(container);

    this.map = new maplibregl.Map({
      container: this.mapContainer,
      style: this.campaign
        ? this.buildStyle(this.campaign)
        : obsidianNativeStyle(readObsidianCssTokens(this.containerEl), glyphsUrlTemplate()),
      transformRequest: createTransformRequest(this.app),
      center: [0, 0],
      zoom: 3,
      attributionControl: false,
      renderWorldCopies: false,
    });

    this.map.on("load", () => {
      // Fallback only, for the one case setCampaign()'s own synchronous
      // applyCampaign() call can't cover: a campaign already set on this
      // view *before* the map existed (this.map was null, so that call
      // no-opped). In the ordinary case setCampaign() has already fit the
      // bounds by the time "load" fires — MapLibre's camera methods take
      // effect immediately, pre-load, they just don't paint until the style
      // is ready — so re-applying here would silently stomp any camera
      // move made in between (e.g. a caller jumping to a specific tile
      // right after opening), which is exactly what broke Phase 4's
      // viewport dispatcher: a live "load" firing after an explicit jumpTo
      // reset the camera mid-flight, discarding whatever the dispatcher had
      // already started fetching for the jumped-to viewport.
      if (this.campaign && !this.campaignAppliedOnce) this.applyCampaign();
      this.refreshSource();
      this.refreshGeneratedSource();
      this.applyFocusReveal();
      this.updateScaleBar();
      this.updateFocusReadout();
    });
    this.map.on("move", () => this.updateScaleBar());
    this.map.on("zoom", () => {
      this.updateScaleBar();
      this.updateFocusReadout();
    });
    this.map.on("click", (e) => this.handleClick(e));
    this.map.on("dblclick", (e) => this.handleSketchDblClick(e));
    this.map.on("contextmenu", (e) => this.handleContextMenu(e));
    this.map.on("mouseenter", "canon-point", (e) => this.handleHoverEnter(e));
    this.map.on("mouseleave", "canon-point", () => this.handleHoverLeave());
    this.map.on("mousedown", "canon-point", (e) => this.handleDragStart(e));

    this.registerEvent(this.app.workspace.on("css-change", () => this.rebuildTheme()));
    // No manual ResizeObserver: MapLibre's Map already observes its container
    // (trackResize, default on) with its own debounce — a second observer on the
    // same element caused the browser's ResizeObserver loop-detection warning.
  }

  /**
   * Builds the on-map toolbar overlay (top-left) surfacing the highest-value
   * builder actions that were previously only reachable via the command
   * palette. Static — same buttons for any campaign — so it's built once
   * here and never rebuilt on campaign switch (see setCampaign()).
   */
  private buildToolbar(): void {
    this.toolbarEl.empty();
    const btn = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = this.toolbarEl.createEl("button", {
        cls: "campaign-map-toolbar-btn",
        attr: { "aria-label": label, title: label },
      });
      setIcon(b, icon);
      b.onclick = onClick;
      return b;
    };

    btn("plus", "Add location at center", () => {
      if (!this.map) return;
      const c = this.map.getCenter();
      this.openQuickAdd([c.lng, c.lat]);
    });

    // Toolbar holds only the frequent, in-the-moment builder actions (plan 018).
    // The occasional/heavy actions — Generate fabric here, Export poster,
    // Export atlas — now live in the settings/control-panel modal under
    // "Generate & export" (still on the command palette too). See
    // generateFabricHere() for the shared "here" logic.
    // The pencil keeps a ref so sketch mode can show an active/pressed state (016).
    this.pencilBtnEl = btn("pencil", "Sketch fabric (roads, walls, rivers, districts…)", () =>
      this.toggleSketchMode()
    );
    this.pencilBtnEl.toggleClass("is-active", this.sketchMode);
    btn("search", "Search locations", () => this.openSearch());
    btn("palette", "Switch map theme", () => this.switchTheme());
    btn("settings", "Campaign settings (generate, export live here)", () => this.plugin.openControlPanel());
  }

  /**
   * "Generate fabric here" (plan 019) — THE explicit generation trigger,
   * and the only way first-time generation ever happens (no viewport
   * dispatch, no generate-on-pan). Picks the tier (world vs city) from the
   * current zoom so the GM doesn't have to know the distinction, paints the
   * tile at `point` (display-space; defaults to the map center), and
   * appends a durable manifest entry so the area repaints on every future
   * open (cache hit or deterministic regenerate). Real-city campaigns get
   * their fabric from the Protomaps basemap instead.
   */
  async generateFabricHere(
    point?: [number, number],
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<GeoJSON.Feature[]> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return [];
    const campaign = this.campaign;
    await this.loadManifestForCampaign();
    if (this.campaign?.id !== campaign.id) return [];
    const tier = bandForZoom(this.map.getZoom());
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.mapCenterUnits();
    const { tileX, tileY } = tileXYForPoint(
      unitsToMeters(centerUnits[0], scale),
      unitsToMeters(centerUnits[1], scale)
    );

    const features = await this.generateTierAt(tier, tileX, tileY, opts.force === true);
    if (this.campaign?.id !== campaign.id) return [];

    const id = manifestEntryId(tier, tileX, tileY);
    const isNew = !this.manifest.entries.some((e) => e.id === id);
    if (isNew) {
      const entry: ManifestEntry = { id, tier, tileX, tileY, createdAt: Date.now() };
      this.manifest = withEntry(this.manifest, entry);
      await saveGeneratedManifest(this.app, campaign, this.manifest);
      // Durable request → mutation log too (undo/replay): what's logged is
      // the GM's ask, not the (regenerable) output.
      await appendLogEntry(this.app, campaignFolderFromConfigPath(campaign.path), {
        ts: Date.now(),
        type: "generate-area",
        campaignId: campaign.id,
        path: generatedManifestPath(campaign),
        data: entry,
      });
    }
    if (!opts.silent) {
      new Notice(`Campaign Map: generated ${features.length} ${tier} feature${features.length === 1 ? "" : "s"}`);
    }
    return features.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /**
   * "Regenerate fabric here" (plan 019, D4): re-runs every tier the GM has
   * generated at this tile against CURRENT constraints (canon + sketched
   * fabric) — the manifest entries stay as they are; only the regenerable
   * output changes. On a tile with no manifest entry it behaves as a
   * first-time generate (forced, so a stale orphan cache can't shadow it).
   */
  async regenerateFabricHere(point?: [number, number]): Promise<GeoJSON.Feature[]> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return [];
    const campaign = this.campaign;
    await this.loadManifestForCampaign();
    if (this.campaign?.id !== campaign.id) return [];
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.mapCenterUnits();
    const { tileX, tileY } = tileXYForPoint(
      unitsToMeters(centerUnits[0], scale),
      unitsToMeters(centerUnits[1], scale)
    );
    const entries = entriesForTile(this.manifest, tileX, tileY);
    if (entries.length === 0) return this.generateFabricHere(point, { force: true });

    const all: GeoJSON.Feature[] = [];
    for (const entry of entries) {
      all.push(...(await this.generateTierAt(entry.tier, tileX, tileY, true)));
      if (this.campaign?.id !== campaign.id) return [];
    }
    new Notice(`Campaign Map: regenerated ${all.length} feature${all.length === 1 ? "" : "s"}`);
    return all.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /** "Clear generated fabric here" (plan 019, D4): drops this tile's
   * manifest entries + cache records + paint. Gone and stays gone after
   * reopen — the manifest is what replays, and it no longer asks. */
  async clearGeneratedHere(point?: [number, number]): Promise<number> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return 0;
    const campaign = this.campaign;
    await this.loadManifestForCampaign();
    if (this.campaign?.id !== campaign.id) return 0;
    const scale = campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.mapCenterUnits();
    const { tileX, tileY } = tileXYForPoint(
      unitsToMeters(centerUnits[0], scale),
      unitsToMeters(centerUnits[1], scale)
    );
    const entries = entriesForTile(this.manifest, tileX, tileY);
    if (entries.length === 0) {
      new Notice("Campaign Map: nothing generated at this tile to clear");
      return 0;
    }
    await this.clearManifestEntries(entries);
    return entries.length;
  }

  /** "Clear all generated fabric" (plan 019, D4). Sketched fabric and
   * locations are untouched — this only removes generator output + the
   * requests that produced it. */
  async clearAllGenerated(): Promise<number> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return 0;
    const campaign = this.campaign;
    await this.loadManifestForCampaign();
    if (this.campaign?.id !== campaign.id) return 0;
    const entries = [...this.manifest.entries];
    if (entries.length === 0) {
      new Notice("Campaign Map: nothing generated to clear");
      return 0;
    }
    await this.clearManifestEntries(entries);
    return entries.length;
  }

  /** Shared clear path: cache records out (real removal, not a tombstone —
   * see removeCachedTiles), manifest entries out, paint out, one `clear-area`
   * log record with the removed entries so undo can restore them. */
  private async clearManifestEntries(entries: ManifestEntry[]): Promise<void> {
    if (!this.campaign) return;
    const campaign = this.campaign;
    const folder = campaignFolderFromConfigPath(campaign.path);
    const seed = campaign.config.seed;
    const keys = entries.flatMap((e) =>
      generatorIdsForBand(e.tier).map((gid) => tileKey(seed, e.tileX, e.tileY, GENERATION_ZOOM, gid))
    );
    await removeCachedTiles(this.app, folder, keys);
    for (const e of entries) {
      this.manifest = withoutEntry(this.manifest, e.id);
      this.loadedTiles.delete(this.tileKeyFor(e.tier, e.tileX, e.tileY));
    }
    await saveGeneratedManifest(this.app, campaign, this.manifest);
    this.refreshGeneratedSource();
    await appendLogEntry(this.app, folder, {
      ts: Date.now(),
      type: "clear-area",
      campaignId: campaign.id,
      path: generatedManifestPath(campaign),
      data: { entries } as unknown as Record<string, unknown>,
    });
    new Notice(`Campaign Map: cleared ${entries.length} generated area${entries.length === 1 ? "" : "s"}`);
  }

  /**
   * The focus stepper (bottom-right): + / − buttons that SNAP the camera
   * between the three per-campaign focus levels (Wide / Mid / Close), with a
   * three-dot readout of the current level. Free scroll/trackpad zoom stays
   * continuous and untouched — this is the discrete "depth of field" gear on
   * top of it, replacing the old free-for-all where the GM had to know exact
   * zoom numbers to see the right detail.
   */
  private buildFocusControl(container: HTMLElement): void {
    const el = container.createDiv({ cls: "campaign-map-focus-control" });
    const plus = el.createEl("button", {
      cls: "campaign-map-focus-btn",
      text: "+",
      attr: { "aria-label": "Zoom in one focus level", title: "Focus in (Wide → Mid → Close)" },
    });
    plus.onclick = () => this.stepFocus(1);
    this.focusReadoutEl = el.createDiv({ cls: "campaign-map-focus-readout" });
    this.focusReadoutEl.setText("●○○");
    const minus = el.createEl("button", {
      cls: "campaign-map-focus-btn",
      text: "−",
      attr: { "aria-label": "Zoom out one focus level", title: "Focus out (Close → Mid → Wide)" },
    });
    minus.onclick = () => this.stepFocus(-1);
  }

  async onClose(): Promise<void> {
    if (this.sketchAutoBuildTimer !== null) {
      window.clearTimeout(this.sketchAutoBuildTimer);
      this.sketchAutoBuildTimer = null;
    }
    if (this.sketchKeyHandler) {
      window.removeEventListener("keydown", this.sketchKeyHandler, true);
      this.sketchKeyHandler = null;
    }
    this.map?.remove();
    this.map = null;
  }

  /** Called by the plugin after a vault rescan touches this campaign's locations. */
  onIndexUpdated(): void {
    this.refreshSource();
  }

  openSearch(): void {
    if (!this.campaign || !this.map) return;
    const locations = this.plugin.getCampaignState(this.campaign.id).index.all();
    new LocationSearchModal(this.app, locations, (loc) => {
      if (!loc.point || !this.map) return;
      this.map.flyTo({ center: loc.point, zoom: Math.max(this.map.getZoom(), loc.zoomMin + 1) });
      this.pulseFeature(loc);
    }).open();
  }

  /**
   * Per-session travel path (plan 009, Phase 5: "session notes already
   * date-stamp the log" — but here it's the note's own `[[wikilinks]]` that
   * carry the route). Lists `<campaign>/Sessions/*.md`, and on pick, draws
   * a line through the locations that session note links, in the order they
   * appear in the body.
   */
  showSessionPath(): void {
    if (!this.campaign || !this.map) return;
    const folder = campaignFolderFromConfigPath(this.campaign.path);
    const sessionFiles = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${folder}/Sessions/`));
    if (sessionFiles.length === 0) {
      new Notice("Campaign Map: no session notes found (expected <campaign>/Sessions/*.md)");
      return;
    }
    new SessionSearchModal(this.app, sessionFiles, (file) => void this.applySessionPath(file)).open();
  }

  private async applySessionPath(file: TFile): Promise<void> {
    if (!this.campaign || !this.map) return;
    const body = await this.app.vault.cachedRead(file);
    const locations = this.plugin.getCampaignState(this.campaign.id).index.all();
    const points = parseSessionPath(body, locations);
    const feature = sessionPathFeature(points);
    if (!feature) {
      // Clear (not leave-as-is): the GM asked to see *this* session's path,
      // and a previous session's line lingering on screen would misreport
      // where this one went — same "no stale line" bar the connections
      // wiring holds itself to.
      this.clearSessionPath();
      new Notice(`Campaign Map: "${file.basename}" doesn't link 2+ known locations — nothing to draw`);
      return;
    }
    this.currentSessionPathFeature = feature;
    this.refreshSessionPath();
    if (!this.map) return;
    const coords = points.map((p) => p.point);
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    this.map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    new Notice(`Campaign Map: session path — ${file.basename} (${points.length} stops)`);
  }

  /**
   * Campaign replay (plan 009, Phase 5: "campaign replay from the mutation
   * log"): flies the camera to every `create` entry in `.mapcache/log.jsonl`,
   * oldest first, pulsing each location as it's visited — a stepped tour of
   * how the map came to be, not a tweened camera path (scoped out, see
   * plan's maintenance notes). Interruptible: stops if the view closes
   * (`this.map` goes null) or the campaign changes mid-replay.
   */
  async replayCampaign(): Promise<void> {
    if (!this.campaign || !this.map) return;
    const token = ++this.replayToken;
    const entries = (await this.plugin.log.read(this.campaign.id))
      .filter((e) => e.type === "create")
      .sort((a, b) => a.ts - b.ts);
    if (entries.length === 0) {
      new Notice("Campaign Map: no created locations in the mutation log yet");
      return;
    }
    new Notice(`Campaign Map: replaying ${entries.length} location${entries.length === 1 ? "" : "s"}...`);
    const index = this.plugin.getCampaignState(this.campaign.id).index;
    for (const entry of entries) {
      if (token !== this.replayToken || !this.map || !this.campaign) return; // interrupted
      const loc = index.get(entry.path);
      if (!loc?.point) continue;
      this.map.flyTo({ center: loc.point, zoom: Math.max(this.map.getZoom(), loc.zoomMin + 1) });
      this.pulseFeature(loc);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (token === this.replayToken && this.map) new Notice("Campaign Map: replay complete");
  }

  /**
   * v1 poster export (docs/03 Phase 5: "poster export first"): a high-res PNG
   * of the *current* view with a title cartouche, saved into the vault next
   * to the campaign note. Renders via a separate offscreen map (see
   * posterExport.ts) rather than capturing the live map's own canvas, since
   * the live map is created without `preserveDrawingBuffer` (see onOpen).
   */
  async exportPoster(): Promise<void> {
    if (!this.map || !this.campaign) {
      new Notice("Campaign Map: open a campaign first");
      return;
    }
    const campaign = this.campaign;
    const c = this.map.getCenter();
    const canvas = this.map.getCanvas();
    const { width: widthPx, height: heightPx } = posterDimensions(canvas.width, canvas.height, 2000);
    try {
      const buf = await renderPoster({
        style: this.buildExportStyle(campaign),
        center: [c.lng, c.lat],
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
        widthPx,
        heightPx,
        title: campaign.name,
        transformRequest: createTransformRequest(this.app),
      });
      const dir = `${campaign.path.slice(0, campaign.path.lastIndexOf("/"))}/Exports`;
      await this.app.vault.adapter.mkdir(dir).catch(() => {});
      const path = `${dir}/${campaign.name}-${Date.now()}.png`;
      await this.app.vault.adapter.writeBinary(path, buf);
      new Notice(`Campaign Map: poster exported → ${path}`);
    } catch (err) {
      new Notice(`Campaign Map: poster export failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  /** Plan 011: generic GeoJSON importer (covers Azgaar/Watabou exports and
   * anything else that speaks GeoJSON). No network, no Node fs — the GM
   * drops the export into the vault first; this just picks it, converts
   * Point/Line/Polygon features to note specs, and writes them via
   * `importOps.importNotes` (same write paths as quick-add). */
  async importGeojson(): Promise<void> {
    if (!this.campaign) {
      new Notice("Campaign Map: open a campaign first");
      return;
    }
    const campaign = this.campaign;
    const files = this.app.vault.getFiles().filter((f) => f.extension === "geojson" || f.extension === "json");
    if (files.length === 0) {
      new Notice("Campaign Map: no .geojson/.json files found in the vault to import");
      return;
    }

    new ImportFileModal(this.app, files, async (file) => {
      try {
        const raw = await this.app.vault.read(file);
        const parsed = JSON.parse(raw);
        const notes = importGeojson(parsed, LOCATION_TYPES);
        if (notes.length === 0) {
          new Notice(`Campaign Map: no importable features found in "${file.path}"`);
          return;
        }
        const created = await importNotes(this.app, campaign, notes);
        new Notice(
          created === 0
            ? `Campaign Map: import found ${notes.length} feature${notes.length === 1 ? "" : "s"}, but all already exist`
            : `Campaign Map: imported ${created} location${created === 1 ? "" : "s"} from "${file.path}"`
        );
      } catch (err) {
        new Notice(`Campaign Map: import failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
      }
    }).open();
  }

  /**
   * v1 atlas export (docs/03 Phase 5: "Atlas export: PDF from maps +
   * location notes ... the notes ARE the gazetteer now"). Reuses the same
   * offscreen renderPoster pipeline as exportPoster() for the cover image,
   * then reads every canon location's note body (stripping frontmatter the
   * same way showPlaceCard does) and hands it all to buildAtlasPdf
   * (atlasExport.ts) to compose the multi-page PDF.
   */
  async exportAtlas(): Promise<void> {
    if (!this.map || !this.campaign) {
      new Notice("Campaign Map: open a campaign first");
      return;
    }
    const campaign = this.campaign;
    const c = this.map.getCenter();
    const canvas = this.map.getCanvas();
    const { width: coverW, height: coverH } = posterDimensions(canvas.width, canvas.height, 1600);
    try {
      const coverPng = await renderPoster({
        style: this.buildExportStyle(campaign),
        center: [c.lng, c.lat],
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
        widthPx: coverW,
        heightPx: coverH,
        title: campaign.name,
        transformRequest: createTransformRequest(this.app),
      });

      const locs = this.plugin.getCampaignState(campaign.id).index.all();
      const atlasLocs: AtlasLocation[] = await Promise.all(
        locs.map(async (l): Promise<AtlasLocation> => {
          const file = this.app.vault.getAbstractFileByPath(l.path);
          let body = "";
          if (file instanceof TFile) {
            body = (await this.app.vault.cachedRead(file)).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
          }
          return { name: l.name, type: l.type, point: l.point, body };
        })
      );

      const pdf = await buildAtlasPdf({
        title: campaign.name,
        coverPng,
        coverWidth: coverW,
        coverHeight: coverH,
        locations: atlasLocs,
      });

      const dir = `${campaign.path.slice(0, campaign.path.lastIndexOf("/"))}/Exports`;
      await this.app.vault.adapter.mkdir(dir).catch(() => {});
      const path = `${dir}/${campaign.name}-atlas-${Date.now()}.pdf`;
      await this.app.vault.adapter.writeBinary(path, pdf);
      new Notice(`Campaign Map: atlas exported → ${path}`);
    } catch (err) {
      new Notice(`Campaign Map: atlas export failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  async undoLastEdit(): Promise<void> {
    if (!this.campaign) return;
    const entries = await this.plugin.log.read(this.campaign.id);
    if (entries.length === 0) {
      new Notice("Campaign Map: nothing to undo");
      return;
    }
    const last = entries[entries.length - 1];
    const file = this.app.vault.getAbstractFileByPath(last.path);
    if (last.type === "create") {
      if (file instanceof TFile) await this.app.vault.delete(file);
      new Notice(`Campaign Map: undid creation of "${last.path.split("/").pop()}"`);
    } else if (last.type === "move") {
      const from = (last.data as { from?: [number, number] }).from;
      if (file instanceof TFile && from) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.geometry = from;
        });
        new Notice("Campaign Map: undid move");
      }
    } else if (last.type === "sketch-add" || last.type === "sketch-remove") {
      // Plan 013: the log entry's data is the full FabricFeature, so undo can
      // remove a just-drawn feature or restore a just-deleted one.
      const parsed = FabricFeatureSchema.safeParse(last.data);
      if (!parsed.success) {
        new Notice("Campaign Map: can't undo sketch — malformed log entry");
        return;
      }
      await this.loadFabricForCampaign();
      this.fabricCollection =
        last.type === "sketch-add"
          ? withoutFeature(this.fabricCollection, parsed.data.id)
          : withFeature(this.fabricCollection, parsed.data);
      if (this.selectedFabricId === parsed.data.id) {
        this.selectedFabricId = null;
        this.sketchController?.clearSelection();
      }
      await saveFabric(this.app, this.campaign, this.fabricCollection);
      this.refreshFabric();
      new Notice(
        last.type === "sketch-add"
          ? `Campaign Map: undid sketched ${parsed.data.properties.kind}`
          : `Campaign Map: restored deleted ${parsed.data.properties.kind}`
      );
    } else if (last.type === "generate-area") {
      // Undo a generate request = clear that area (appends its own
      // `clear-area`, keeping the log a faithful history — same pattern as
      // sketch undo).
      const entry = ManifestEntrySchema.safeParse(last.data);
      if (!entry.success) {
        new Notice("Campaign Map: can't undo generate — malformed log entry");
        return;
      }
      await this.loadManifestForCampaign();
      await this.clearManifestEntries([entry.data]);
    } else if (last.type === "clear-area") {
      // Undo a clear = restore the manifest entries; output regenerates
      // deterministically from the cache path.
      const parsed = ManifestEntrySchema.array().safeParse((last.data as { entries?: unknown }).entries);
      if (!parsed.success) {
        new Notice("Campaign Map: can't undo clear — malformed log entry");
        return;
      }
      await this.loadManifestForCampaign();
      for (const entry of parsed.data) {
        this.manifest = withEntry(this.manifest, entry);
        await this.generateTierAt(entry.tier, entry.tileX, entry.tileY, false);
      }
      await saveGeneratedManifest(this.app, this.campaign, this.manifest);
      new Notice(`Campaign Map: restored ${parsed.data.length} generated area${parsed.data.length === 1 ? "" : "s"}`);
    }
  }

  openQuickAdd(point: [number, number]): void {
    if (!this.campaign) return;
    const { config } = this.campaign;
    const genre = genreForCampaign(config.crs, config.theme);
    const worldBounds = boundsToBBox(config.bounds ?? defaultFictionalBounds());
    // Region-based naming (docs/04 F5): suggestions reflect whichever
    // culture territory the clicked point falls in, not one culture for the
    // whole campaign.
    const culture = cultureAt(config.seed, point[0], point[1], worldBounds, genre, config.namingCultures);
    new QuickAddModal(this.app, culture, this.campaign.config.seed, ({ name, type, visibility }) => {
      void this.plugin.createLocation(this.campaign!.id, point, name, type, visibility);
    }).open();
  }

  /** Plan 010 / docs/03 Phase 5 "populate this district with N shops" —
   * offline, deterministic (no LLM/API): scatter `count` seeded points across
   * the current viewport and create a real location note for each, named via
   * the same region-culture sequence as openQuickAdd so populated notes read
   * as belonging to whatever culture territory they land in. */
  populateArea(): void {
    if (!this.campaign || !this.map) return;
    const campaign = this.campaign;
    const { config } = campaign;
    const genre = genreForCampaign(config.crs, config.theme);
    const worldBounds = boundsToBBox(config.bounds ?? defaultFictionalBounds());
    const bounds = this.map.getBounds();
    const viewport: BBox = {
      minX: bounds.getWest(),
      minY: bounds.getSouth(),
      maxX: bounds.getEast(),
      maxY: bounds.getNorth(),
    };

    new PopulateAreaModal(this.app, ({ type, count }) => {
      const nameFor = (x: number, y: number): string => {
        const culture = cultureAt(config.seed, x, y, worldBounds, genre, config.namingCultures);
        return generateName(hashSeed(config.seed, x, y, "populate-name"), culture);
      };
      const placed = populateArea({ seed: config.seed, bbox: viewport, type, count, nameFor });
      void (async () => {
        for (const { point, name, type: placedType } of placed) {
          await this.plugin.createLocation(campaign.id, point, name, placedType);
        }
        new Notice(`Campaign Map: populated ${placed.length} location${placed.length === 1 ? "" : "s"}`);
      })();
    }).open();
  }

  /** Generators work in meters (docs/06 §3 tuning ranges); a fictional
   * campaign's own coordinates are fake units (1 unit = `scaleMetersPerUnit`
   * meters). worldBounds/canonFeatures cross into generation-space here. */
  private generationContext(): GenerationContext {
    const config = this.campaign!.config;
    const scale = config.scaleMetersPerUnit;
    const worldBounds = bboxUnitsToMeters(boundsToBBox(config.bounds ?? defaultFictionalBounds()), scale);
    const canonFeatures = this.plugin
      .getCampaignState(this.campaign!.id)
      .index.toFeatureCollection()
      .features.map((f) => transformFeatureUnits(f, (n) => unitsToMeters(n, scale)));
    return { app: this.app, campaign: this.campaign!, worldBounds, canonFeatures };
  }

  private tileKeyFor(band: ZoomBand, tileX: number, tileY: number): string {
    return `${band}:${tileX}:${tileY}`;
  }

  /** All currently-loaded tiles' features, flattened — generation-space (meters). */
  private allLoadedFeatures(): GeoJSON.Feature[] {
    return [...this.loadedTiles.values()].flat();
  }

  private refreshGeneratedSource(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("generated") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const display = this.allLoadedFeatures().map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
    source.setData({ type: "FeatureCollection", features: display });
  }

  private updateLoadingIndicator(): void {
    this.loadingIndicatorEl.style.display = this.pendingGenerations > 0 ? "" : "none";
  }

  /** Test/perf-gate surface: how many tile entries the render store holds
   * (bounded by what the GM has explicitly generated, plan 019). */
  get loadedTileCount(): number {
    return this.loadedTiles.size;
  }

  /** Gate surface (plan 019 Phase 2): actual generator executions this
   * session — pan/zoom aggressively and this must not move. */
  get generatorRunCount(): number {
    return this.generatorRunCounter;
  }

  /** Display-space (fictional units) — matches what's actually rendered/queryable on the map. */
  get generated(): GeoJSON.Feature[] {
    const all = this.allLoadedFeatures();
    if (!this.campaign) return all;
    const scale = this.campaign.config.scaleMetersPerUnit;
    return all.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /** Test surface (docs/05): does a tolerant hit-test at a screen point find a
   * canon feature? Returns the location id or null. */
  hitTestCanonAt(x: number, y: number): string | null {
    const f = this.pickFeatureNear(new maplibregl.Point(x, y), ["canon-point", "canon-label"]);
    return (f?.properties?.id as string | undefined) ?? null;
  }

  /** Test surface (docs/05): drives the "Connect to..." write path without
   * needing to click through the place-card popup + search modal, so gates
   * can assert the `connections` source gains a rendered feature. */
  async connectForTest(fromPath: string, toBasename: string): Promise<void> {
    await addConnection(this.app, fromPath, toBasename);
  }

  private mapCenterUnits(): [number, number] {
    const { lng, lat } = this.map!.getCenter();
    return [lng, lat];
  }

  /** Wraps a tier generator so (a) the worker path is used when available
   * and (b) every actual EXECUTION bumps the gate counter — cache hits
   * never reach this closure, so the counter measures real generator work. */
  private tierGenerator(worker: GenerationWorkerClient | null, id: string): TileGenerator {
    const inner: TileGenerator = worker
      ? (seed, bbox, constraints) => worker.generate(id as GeneratorId, seed, bbox, constraints)
      : this.directGenerators[id];
    return (seed, bbox, constraints) => {
      this.generatorRunCounter++;
      return inner(seed, bbox, constraints);
    };
  }

  /** Runs every generator of `tier` for one tile through the cache path,
   * stores the result in the render store, and paints. Generation-space in,
   * generation-space stored — callers convert for display. */
  private async generateTierAt(
    tier: ZoomBand,
    tileX: number,
    tileY: number,
    force: boolean
  ): Promise<GeoJSON.Feature[]> {
    const ctx = this.generationContext();
    const worker = await this.plugin.getGenerationWorker();
    this.pendingGenerations++;
    this.updateLoadingIndicator();
    let features: GeoJSON.Feature[];
    try {
      const results = await Promise.all(
        generatorIdsForBand(tier).map((id) =>
          generateTile(ctx, tileX, tileY, id, this.tierGenerator(worker, id), { force })
        )
      );
      features = results.flat().filter((f) => featureTouchesBBox(f, ctx.worldBounds));
    } finally {
      this.pendingGenerations--;
      this.updateLoadingIndicator();
    }
    this.loadedTiles.set(this.tileKeyFor(tier, tileX, tileY), features);
    this.refreshGeneratedSource();
    return features;
  }

  /** Loads `<campaign>/Generated.json` into memory once per campaign; bad
   * entries get a warning notice (never a silent drop — CLAUDE.md). */
  private async loadManifestForCampaign(): Promise<void> {
    if (!this.campaign) return;
    const target = this.campaign.id;
    if (this.manifestLoadedFor === target) return;
    const { manifest, invalidCount } = await loadGeneratedManifest(this.app, this.campaign);
    if (this.campaign?.id !== target) return; // switched campaigns mid-load
    this.manifest = manifest;
    this.manifestLoadedFor = target;
    if (invalidCount > 0) {
      new Notice(
        `Campaign Map: skipped ${invalidCount} invalid generation request${invalidCount === 1 ? "" : "s"} in Generated.json`
      );
    }
  }

  /**
   * Manifest replay (plan 019): on campaign open, repaint every area the GM
   * has asked to generate — cache hit or deterministic regenerate, so
   * deleting `.mapcache/` stays harmless. Reads the tile cache ONCE up
   * front: `generateTile`'s own `getCachedTile` re-reads and re-parses the
   * whole JSONL per call, which would be O(entries × file-size) across a
   * replay — the plan's own STOP condition (~1s for 20 areas) forbids that.
   */
  private async replayGeneratedManifest(): Promise<void> {
    if (!this.campaign || this.campaign.config.crs !== "fictional") return;
    const campaign = this.campaign;
    if (this.manifestReplayedFor === campaign.id) return;
    this.manifestReplayedFor = campaign.id;
    await this.loadManifestForCampaign();
    if (this.campaign?.id !== campaign.id) return;
    if (this.manifest.entries.length === 0) return;

    const ctx = this.generationContext();
    const worker = await this.plugin.getGenerationWorker();
    const folder = campaignFolderFromConfigPath(campaign.path);
    const cached = await readCachedTiles(this.app, folder);
    const seed = campaign.config.seed;
    this.pendingGenerations++;
    this.updateLoadingIndicator();
    try {
      for (const entry of [...this.manifest.entries]) {
        if (this.campaign?.id !== campaign.id) return; // switched mid-replay
        const perGenerator = await Promise.all(
          generatorIdsForBand(entry.tier).map((gid) => {
            const key = tileKey(seed, entry.tileX, entry.tileY, GENERATION_ZOOM, gid);
            const hit = cached.get(key);
            if (hit) return Promise.resolve(hit.features as unknown as GeoJSON.Feature[]);
            return generateTile(ctx, entry.tileX, entry.tileY, gid, this.tierGenerator(worker, gid));
          })
        );
        const features = perGenerator.flat().filter((f) => featureTouchesBBox(f, ctx.worldBounds));
        this.loadedTiles.set(this.tileKeyFor(entry.tier, entry.tileX, entry.tileY), features);
      }
    } finally {
      this.pendingGenerations--;
      this.updateLoadingIndicator();
    }
    this.refreshGeneratedSource();
  }

  private applyCampaign(): void {
    if (!this.map || !this.campaign) return;
    this.campaignAppliedOnce = true;
    const { config } = this.campaign;

    if (config.crs === "fictional") {
      const bounds = config.bounds ?? defaultFictionalBounds();
      this.map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 40, animate: false }
      );
      this.captureOverviewZoom();
    } else if (config.basemap) {
      vaultBasemapBounds(this.app, config.basemap).then((bounds) => {
        if (!this.map || !bounds || this.campaign?.config.basemap !== config.basemap) return;
        this.map.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          { padding: 40, animate: false }
        );
        this.captureOverviewZoom();
      });
    }

    this.scaleBarEl.style.display = config.crs === "fictional" ? "" : "none";
    if (config.crs === "real" && !this.scaleControl) {
      this.scaleControl = new maplibregl.ScaleControl({ unit: "metric" });
      this.map.addControl(this.scaleControl, "bottom-left");
    } else if (config.crs === "fictional" && this.scaleControl) {
      this.map.removeControl(this.scaleControl);
      this.scaleControl = null;
    }
  }

  /** Capture the campaign overview zoom (call right after fitBounds) and derive
   * the three focus levels + the depth-of-field label reveal floors from it. */
  private captureOverviewZoom(): void {
    if (!this.map) return;
    const base = Math.round(this.map.getZoom() * 10) / 10;
    this.overviewZoom = base;
    this.focusZooms = [base, base + 3, base + 6];
    this.applyFocusReveal();
    this.updateFocusReadout();
  }

  /**
   * Push the per-campaign depth-of-field reveal floors onto the label layers.
   * `deep` labels are always on (floor 0); `medium` reveals at the midpoint of
   * Wide→Mid, `shallow` at the midpoint of Mid→Close. Done with
   * `setLayerZoomRange` (a live per-layer update, NOT a filter — zoom must never
   * go in a filter) so it's re-applicable after a restyle wipes the defaults.
   * No-ops until both the overview zoom and the layers exist, so it's safe to
   * call from load/styledata handlers and from captureOverviewZoom alike.
   */
  private applyFocusReveal(): void {
    if (!this.map || this.overviewZoom == null) return;
    const base = this.overviewZoom;
    const reveal: Record<string, number> = { deep: 0, medium: base + 1.5, shallow: base + 4.5 };
    for (const prefix of ["canon", "generated"]) {
      for (const depth of ["deep", "medium", "shallow"] as const) {
        const id = `${prefix}-label-${depth}`;
        if (this.map.getLayer(id)) this.map.setLayerZoomRange(id, reveal[depth], 24);
      }
    }
  }

  /** Snap the camera to the previous/next focus level (the +/- buttons). Free
   * scroll/trackpad zoom stays continuous; this just jumps between the three
   * fixed stops. Picks the next stop strictly beyond the current zoom in the
   * given direction, so pressing + from anywhere lands on the next level in. */
  private stepFocus(dir: 1 | -1): void {
    if (!this.map || !this.focusZooms) return;
    const z = this.map.getZoom();
    const eps = 0.05;
    const target =
      dir === 1
        ? this.focusZooms.find((f) => f > z + eps) ?? this.focusZooms[this.focusZooms.length - 1]
        : [...this.focusZooms].reverse().find((f) => f < z - eps) ?? this.focusZooms[0];
    this.map.easeTo({ zoom: target, duration: 300 });
  }

  /** Which focus level (1–3) the current zoom is nearest, for the readout. */
  private currentFocusLevel(): number {
    if (!this.map || !this.focusZooms) return 1;
    const z = this.map.getZoom();
    let best = 0;
    let bestD = Infinity;
    this.focusZooms.forEach((f, i) => {
      const d = Math.abs(f - z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best + 1;
  }

  private updateFocusReadout(): void {
    if (!this.focusReadoutEl) return;
    const level = this.currentFocusLevel();
    // Three dots, the current one filled — a compact "which focus level" gauge.
    this.focusReadoutEl.setText([1, 2, 3].map((n) => (n === level ? "●" : "○")).join(""));
    const names = ["Wide", "Mid", "Close"];
    this.focusReadoutEl.setAttr("title", `Focus: ${names[level - 1]} (level ${level} of 3)`);
  }

  private refreshSource(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("canon") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const fc = this.plugin.getCampaignState(this.campaign.id).index.toFeatureCollection();
    source.setData(fc);
    this.updateWarningBadge();
    this.refreshConnections();
    this.refreshSessionPath();
    this.refreshFabric();
  }

  /** Point-crawl travel connections declared in `connections:` frontmatter
   * (plan 004) — resolved from the same index as canon pins, so a rename,
   * delete, or theme switch that refreshes `canon` also refreshes these lines. */
  private refreshConnections(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("connections") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const locations = this.plugin.getCampaignState(this.campaign.id).index.all();
    source.setData({ type: "FeatureCollection", features: buildConnectionFeatures(locations) });
  }

  /** Per-session travel path (plan 009) — modeled on `refreshConnections`,
   * but the feature is user-picked state (`currentSessionPathFeature`), not
   * derived fresh from the index, so this just re-applies it (or clears the
   * source when there's nothing shown). Called from `refreshSource()` so a
   * theme switch's `setStyle` (which wipes every source) doesn't silently
   * drop a path the GM had open. */
  private refreshSessionPath(): void {
    if (!this.map) return;
    const source = this.map.getSource("session-path") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: "FeatureCollection",
      features: this.currentSessionPathFeature ? [this.currentSessionPathFeature] : [],
    });
  }

  /** Empties the `session-path` source and forgets the last-shown path. */
  clearSessionPath(): void {
    this.currentSessionPathFeature = null;
    this.refreshSessionPath();
  }

  /** Loads `<campaign>/Fabric.geojson` into memory once per campaign; bad
   * features get a warning notice (never a silent drop — CLAUDE.md). */
  private async loadFabricForCampaign(): Promise<void> {
    if (!this.campaign) return;
    const target = this.campaign.id;
    if (this.fabricLoadedFor === target) return;
    const { fabric, invalidCount } = await loadFabric(this.app, this.campaign);
    if (this.campaign?.id !== target) return; // switched campaigns mid-load
    this.fabricCollection = fabric;
    this.fabricLoadedFor = target;
    if (invalidCount > 0) {
      new Notice(
        `Campaign Map: skipped ${invalidCount} invalid fabric feature${invalidCount === 1 ? "" : "s"} in Fabric.geojson`
      );
    }
    this.refreshFabric();
  }

  /** Sketched fabric (plan 013) — modeled on `refreshConnections`: re-applies
   * the in-memory collection to the `fabric` source; called from
   * `refreshSource()` so a theme switch's setStyle (which wipes every source)
   * doesn't drop the GM's sketches. The feature-level `id` is mirrored into
   * `properties.id` because queryRenderedFeatures doesn't reliably surface
   * string feature ids from a geojson source. */
  private refreshFabric(): void {
    if (!this.map) return;
    const source = this.map.getSource("fabric") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const features = this.fabricCollection.features.map((f) => ({
      ...f,
      properties: { ...f.properties, id: f.id },
    }));
    source.setData({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection);
  }

  /** Draft-preview accent for the sketch controller — the same accent token
   * the active theme's connection lines use. */
  private sketchAccent(): string {
    const theme = this.campaign?.config.theme ?? "";
    if (isHandcraftedTheme(theme)) return HANDCRAFTED_THEMES[theme].accent;
    return readObsidianCssTokens(this.containerEl).interactiveAccent;
  }

  /** Enters/exits sketch mode (plan 013): shows the kind palette sub-bar,
   * activates the draw controller, suspends the normal click grammar (see
   * handleClick), and disables double-click zoom so dblclick can mean
   * "finish the draft". */
  toggleSketchMode(): void {
    if (!this.map || !this.campaign) return;
    if (this.sketchMode) {
      this.sketchMode = false;
      if (this.sketchAutoBuildTimer !== null) {
        window.clearTimeout(this.sketchAutoBuildTimer);
        this.sketchAutoBuildTimer = null;
      }
      this.sketchController?.deactivate();
      this.sketchController = null;
      this.sketchBarEl?.remove();
      this.sketchBarEl = null;
      this.selectedFabricId = null;
      if (this.sketchKeyHandler) {
        window.removeEventListener("keydown", this.sketchKeyHandler, true);
        this.sketchKeyHandler = null;
      }
      this.map.doubleClickZoom.enable();
      this.pencilBtnEl?.toggleClass("is-active", false);
      return;
    }
    this.sketchMode = true;
    void this.loadFabricForCampaign();
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();
    this.map.doubleClickZoom.disable();
    this.sketchController = new SketchController(this.map, this.sketchAccent());
    this.sketchController.activate(this.sketchKind);
    this.buildSketchBar();
    // Capture phase so Escape / Cmd-Z reach us before MapLibre's canvas
    // handlers or Obsidian's global shortcuts can swallow them (plan 016:
    // "Escape should reliably leave sketch mode").
    this.sketchKeyHandler = (ev: KeyboardEvent) => this.sketchKeydown(ev);
    window.addEventListener("keydown", this.sketchKeyHandler, true);
    this.pencilBtnEl?.toggleClass("is-active", true);
  }

  get sketchModeActive(): boolean {
    return this.sketchMode;
  }

  /** Kind-palette sub-bar (plan 013 chose the inline sub-bar over a modal:
   * the GM switches kinds constantly while landscaping — a modal per switch
   * would break the flow). */
  private buildSketchBar(): void {
    this.sketchBarEl?.remove();
    this.sketchBarEl = this.contentEl.createDiv({ cls: "campaign-map-sketch-bar" });
    const kindButtons = new Map<FabricKind, HTMLButtonElement>();
    const setActiveKind = (kind: FabricKind): void => {
      this.sketchKind = kind;
      this.sketchController?.setKind(kind);
      for (const [k, b] of kindButtons) b.toggleClass("is-active", k === kind);
    };
    for (const kind of FABRIC_KINDS) {
      const b = this.sketchBarEl.createEl("button", {
        text: kind,
        cls: "campaign-map-sketch-kind-btn",
        attr: { title: `Sketch a ${kind} (${isPolygonKind(kind) ? "polygon" : "line"})` },
      });
      b.onclick = () => setActiveKind(kind);
      kindButtons.set(kind, b);
    }
    // Plan 014: literal vs generator-feed toggle for new drawings + the
    // explicit "build from sketch" action (explicit, not live-as-you-draw,
    // per the plan's preview/commit recommendation).
    const modeBtn = this.sketchBarEl.createEl("button", {
      cls: "campaign-map-sketch-kind-btn campaign-map-sketch-mode-btn",
      attr: { title: 'New drawings feed the procedural generator ("generate" mode) instead of rendering literally' },
    });
    const renderModeBtn = (): void => {
      modeBtn.setText(this.sketchDraftMode === "generate" ? "feed: on" : "feed: off");
      modeBtn.toggleClass("is-active", this.sketchDraftMode === "generate");
    };
    modeBtn.onclick = () => {
      this.sketchDraftMode = this.sketchDraftMode === "generate" ? "literal" : "generate";
      renderModeBtn();
    };
    renderModeBtn();
    const generateBtn = this.sketchBarEl.createEl("button", {
      text: "build",
      cls: "campaign-map-sketch-kind-btn",
      attr: { title: "Generate street networks from generate-mode road corridors" },
    });
    generateBtn.onclick = () => void this.generateFromSketch();
    const undoBtn = this.sketchBarEl.createEl("button", {
      text: "↶ undo",
      cls: "campaign-map-sketch-kind-btn",
      attr: { title: "Undo the last sketched feature (Cmd/Ctrl-Z)" },
    });
    undoBtn.onclick = () => void this.undoLastSketch();
    this.sketchBarEl.createDiv({
      cls: "campaign-map-sketch-hint",
      text: "click: vertex · dbl-click/Enter: finish · Esc: cancel/exit · ⌘Z: undo · Del: delete selected",
    });
    const exit = this.sketchBarEl.createEl("button", {
      text: "✕ done",
      cls: "campaign-map-sketch-exit-btn",
      attr: { title: "Exit sketch mode (or press Escape)" },
    });
    exit.onclick = () => this.toggleSketchMode();
    setActiveKind(this.sketchKind);
  }

  private sketchKeydown(ev: KeyboardEvent): void {
    if (!this.sketchMode) return;
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "z" || ev.key === "Z") && !ev.shiftKey) {
      // Intercept before Obsidian's global undo so Cmd/Ctrl-Z means "undo the
      // last sketch" while landscaping (plan 016).
      ev.preventDefault();
      ev.stopPropagation();
      void this.undoLastSketch();
    } else if (ev.key === "Enter") {
      if (this.sketchController?.isDrawing) {
        ev.preventDefault();
        this.finalizeSketchDraft();
      }
    } else if (ev.key === "Escape") {
      // Two-stage: a first Escape cancels an in-progress draft; with no draft
      // (or on the next press) it exits the mode. The prominent ✕ done button
      // and the toggled pencil are the always-reachable mouse exits.
      ev.preventDefault();
      if (this.sketchController?.isDrawing) this.sketchController.cancel();
      else this.toggleSketchMode();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      if (this.selectedFabricId) {
        ev.preventDefault();
        this.deleteSelectedFabric();
      }
    }
  }

  /** Sketch-mode click grammar: mid-draw every click is a vertex; otherwise a
   * click on an existing fabric feature selects it (delete/promote target),
   * and a click on empty ground starts a new draft. */
  private handleSketchClick(e: MapMouseEvent): void {
    const c = this.sketchController;
    if (!c || !this.map) return;
    if (!c.isDrawing) {
      const layers = FABRIC_LAYER_IDS.filter((l) => this.map!.getLayer(l));
      const hits = layers.length
        ? this.map.queryRenderedFeatures(
            [
              [e.point.x - 6, e.point.y - 6],
              [e.point.x + 6, e.point.y + 6],
            ],
            { layers }
          )
        : [];
      const hitId = hits[0]?.properties?.id as string | undefined;
      if (hitId) {
        const feature = this.fabricCollection.features.find((f) => f.id === hitId);
        if (feature) {
          this.selectedFabricId = hitId;
          c.showSelection(feature.geometry as GeoJSON.Geometry);
          return;
        }
      }
      this.selectedFabricId = null;
      c.clearSelection();
    }
    c.addVertex([e.lngLat.lng, e.lngLat.lat]);
  }

  private handleSketchDblClick(e: MapMouseEvent): void {
    if (!this.sketchMode || !this.sketchController?.isDrawing) return;
    e.preventDefault();
    this.finalizeSketchDraft();
  }

  /** Draft → FabricFeature → in-memory collection → Fabric.geojson +
   * mutation log (`sketch-add`), rendering optimistically before the IO. */
  private finalizeSketchDraft(): void {
    const c = this.sketchController;
    if (!c || !this.campaign) return;
    const kind = this.sketchKind;
    const geometry = c.finish();
    if (!geometry) {
      new Notice(
        `Campaign Map: a ${kind} needs at least ${isPolygonKind(kind) ? 3 : 2} points — draft discarded`
      );
      return;
    }
    const feature: FabricFeature = {
      type: "Feature",
      id: makeFabricId(),
      geometry,
      properties: {
        kind,
        // "literal" is the schema default — only "generate" is worth storing.
        ...(this.sketchDraftMode === "generate" ? { mode: "generate" as const } : {}),
      },
    };
    this.fabricCollection = withFeature(this.fabricCollection, feature);
    this.refreshFabric();
    void this.persistFabric("sketch-add", feature);
    // Immediate confirmation regardless of zoom (a below-minzoom stroke paints
    // into the `fabric` source but its themed layer may be hidden until you
    // zoom in — the toast guarantees "something happened" feedback). Plan 016.
    const feeds = this.sketchDraftMode === "generate";
    new Notice(`Campaign Map: ${kind} added${feeds ? " — elaborating…" : ""}`);
    // Generate-mode corridors elaborate into a street network without a manual
    // trip to "build" (plan 016 "instant generation"): debounced so a flurry of
    // strokes coalesces into one run.
    if (feeds && kind === "road" && geometry.type === "LineString") {
      this.scheduleSketchAutoBuild();
    }
  }

  /** Debounced auto-elaboration of generate-mode corridors (plan 016). Runs
   * the same `generateFromSketch` the explicit "build" button does, silently
   * (no per-run Notice), so committed corridors sprout streets on their own. */
  private scheduleSketchAutoBuild(): void {
    if (this.sketchAutoBuildTimer !== null) window.clearTimeout(this.sketchAutoBuildTimer);
    this.sketchAutoBuildTimer = window.setTimeout(() => {
      this.sketchAutoBuildTimer = null;
      if (!this.sketchMode) return;
      void this.generateFromSketch({ silent: true });
    }, 400);
  }

  /** Saves the in-memory collection and appends the sketch log entry —
   * MapView is Fabric.geojson's only writer, so in-memory is authoritative. */
  private async persistFabric(logType: "sketch-add" | "sketch-remove", feature: FabricFeature): Promise<void> {
    if (!this.campaign) return;
    try {
      await saveFabric(this.app, this.campaign, this.fabricCollection);
      await appendLogEntry(this.app, campaignFolderFromConfigPath(this.campaign.path), {
        ts: Date.now(),
        type: logType,
        campaignId: this.campaign.id,
        path: fabricPath(this.campaign),
        data: feature as unknown as Record<string, unknown>,
      });
    } catch (err) {
      new Notice(`Campaign Map: saving sketch failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  private deleteSelectedFabric(): void {
    if (!this.selectedFabricId || !this.campaign) return;
    const feature = this.fabricCollection.features.find((f) => f.id === this.selectedFabricId);
    if (!feature) {
      this.selectedFabricId = null;
      return;
    }
    this.fabricCollection = withoutFeature(this.fabricCollection, feature.id);
    this.selectedFabricId = null;
    this.sketchController?.clearSelection();
    this.refreshFabric();
    void this.persistFabric("sketch-remove", feature);
    new Notice(`Campaign Map: deleted sketched ${feature.properties.kind}`);
  }

  /** Sketch-mode undo (plan 016): removes the most-recently-added, still-live
   * sketched feature. The mutation log is the source of truth, so undo is
   * derived from it (survives a view reopen) and, like a manual delete,
   * appends its own `sketch-remove` — keeping the log a faithful history. */
  private async undoLastSketch(): Promise<void> {
    if (!this.campaign) return;
    const entries = await this.plugin.log.read(this.campaign.id);
    const target = sketchUndoTarget(entries);
    if (!target) {
      new Notice("Campaign Map: nothing to undo");
      return;
    }
    // Reconcile against on-disk fabric first so we remove from the authoritative
    // collection (mirrors deleteSelectedFabric / undoLastEdit).
    await this.loadFabricForCampaign();
    this.fabricCollection = withoutFeature(this.fabricCollection, target.id);
    if (this.selectedFabricId === target.id) {
      this.selectedFabricId = null;
      this.sketchController?.clearSelection();
    }
    this.refreshFabric();
    // A generate-mode corridor's elaborated streets are regenerable cache keyed
    // `sketch:<id>:*` — evict them so undo doesn't leave orphan streets behind.
    if (target.properties.kind === "road" && target.properties.mode === "generate") {
      this.evictSketchTiles(target.id);
    }
    await this.persistFabric("sketch-remove", target);
    new Notice(`Campaign Map: undid sketched ${target.properties.kind}`);
  }

  /** Drops the elaborated street tiles a generate-mode corridor produced
   * (their own `sketch:<id>:*` key namespace) and repaints the generated
   * source. */
  private evictSketchTiles(id: string): void {
    const prefix = `sketch:${id}:`;
    let evicted = false;
    for (const key of [...this.loadedTiles.keys()]) {
      if (key.startsWith(prefix)) {
        this.loadedTiles.delete(key);
        evicted = true;
      }
    }
    if (evicted) this.refreshGeneratedSource();
  }

  /** Plan 014 ("Generate from sketch"): elaborates every generate-mode road
   * corridor into a street network via the pure corridor generator. The
   * result is regenerable cache (same tile store/cache path as "generate
   * city here" — deleting `.mapcache/` regenerates it identically); the
   * sketch itself stays canon in Fabric.geojson and keeps rendering as the
   * literal drawn line underneath its elaboration. */
  async generateFromSketch(opts?: { silent?: boolean }): Promise<GeoJSON.Feature[]> {
    const silent = opts?.silent === true;
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return [];
    await this.loadFabricForCampaign();
    const corridors = this.fabricCollection.features.filter(
      (f) => f.properties.kind === "road" && f.properties.mode === "generate" && f.geometry.type === "LineString"
    );
    if (corridors.length === 0) {
      if (!silent) {
        new Notice('Campaign Map: no generate-mode road corridors — draw a road with "feed: on" first');
      }
      return [];
    }
    const scale = this.campaign.config.scaleMetersPerUnit;
    const ctx = this.generationContext();
    const generated: GeoJSON.Feature[] = [];
    for (const corridor of corridors) {
      // The corridor crosses into generation-space (meters) whole — every
      // tile must see the identical corridor or seams break (corridor.ts).
      const line: GeoJSON.LineString = {
        type: "LineString",
        coordinates: (corridor.geometry.coordinates as [number, number][]).map(([x, y]) => [
          unitsToMeters(x, scale),
          unitsToMeters(y, scale),
        ]),
      };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of line.coordinates) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      // Every tile the elaboration can reach: corridor extent + seed
      // influence radius + max streamline travel.
      const reach = CORRIDOR_INFLUENCE + CORRIDOR_HALO;
      const lo = tileXYForPoint(minX - reach, minY - reach);
      const hi = tileXYForPoint(maxX + reach, maxY + reach);
      for (let tileY = lo.tileY; tileY <= hi.tileY; tileY++) {
        for (let tileX = lo.tileX; tileX <= hi.tileX; tileX++) {
          const features = await generateTile(
            ctx,
            tileX,
            tileY,
            `sketch-corridor:${corridor.id}`,
            (seed, bbox, constraints) => generateCorridorStreets(seed, bbox, line, constraints)
          );
          const kept = features.filter((f) => featureTouchesBBox(f, ctx.worldBounds));
          if (kept.length === 0) continue;
          // Own key namespace: the viewport dispatcher's band eviction
          // ("city:"/"world:" prefixes) never evicts sketch elaborations;
          // campaign switch clears them with the rest of loadedTiles.
          this.loadedTiles.set(`sketch:${corridor.id}:${tileX}:${tileY}`, kept);
          generated.push(...kept);
        }
      }
    }
    this.refreshGeneratedSource();
    if (!silent) {
      new Notice(
        `Campaign Map: generated ${generated.length} street feature${generated.length === 1 ? "" : "s"} from ${corridors.length} sketched corridor${corridors.length === 1 ? "" : "s"}`
      );
    }
    return generated.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  private updateWarningBadge(): void {
    if (!this.campaign) return;
    const count = this.plugin.getCampaignState(this.campaign.id).invalid.size;
    if (count > 0) {
      this.warningBadgeEl.style.display = "";
      this.warningBadgeEl.setText(`⚠ ${count} location${count > 1 ? "s" : ""} with invalid map data`);
    } else {
      this.warningBadgeEl.style.display = "none";
    }
  }

  private rebuildTheme(): void {
    // Only obsidian-native actually depends on live Obsidian CSS vars; handcrafted
    // themes rebuild to an identical style, which is a harmless no-op.
    if (!this.map || !this.campaign || isHandcraftedTheme(this.campaign.config.theme)) return;
    this.map.setStyle(this.buildStyle(this.campaign));
    this.map.once("styledata", () => {
      this.refreshSource();
      this.applyFocusReveal();
    });
  }

  private updateScaleBar(): void {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return;
    const { widthPx, label } = computeScaleBar(this.map.getZoom(), this.campaign.config.scaleMetersPerUnit, 120);
    this.scaleBarEl.setText(label);
    this.scaleBarEl.style.width = `${Math.max(20, widthPx)}px`;
  }

  /** Hit-test with a pixel tolerance (default 8px) instead of an exact point,
   * so 3–7px dots are clickable when the cursor is merely near them. Returns the
   * candidate whose projected position is closest to `screenPoint`, or null. */
  private pickFeatureNear(
    screenPoint: maplibregl.Point,
    layers: string[],
    radius = 8
  ): MapGeoJSONFeature | null {
    if (!this.map) return null;
    const existing = layers.filter((l) => this.map!.getLayer(l));
    if (existing.length === 0) return null;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [screenPoint.x - radius, screenPoint.y - radius],
      [screenPoint.x + radius, screenPoint.y + radius],
    ];
    const candidates = this.map.queryRenderedFeatures(box, { layers: existing });
    let best: MapGeoJSONFeature | null = null;
    let bestDist = Infinity;
    for (const f of candidates) {
      if (f.geometry.type !== "Point") continue;
      const p = this.map.project(f.geometry.coordinates as [number, number]);
      const d = Math.hypot(p.x - screenPoint.x, p.y - screenPoint.y);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  }

  private handleClick(e: MapMouseEvent): void {
    if (!this.map || !this.campaign) return;
    // Sketch mode owns the click pipeline (plan 013): every click is a
    // vertex/select action; the normal pin/popup grammar is suspended.
    if (this.sketchMode) {
      this.handleSketchClick(e);
      return;
    }
    const canon = this.pickFeatureNear(e.point, ["canon-point", "canon-label"]);
    if (canon) {
      this.showPlaceCard(canon);
      return;
    }
    const line = this.map.queryRenderedFeatures(e.point, {
      layers: this.map.getLayer("connection-line") ? ["connection-line"] : [],
    })[0];
    if (line) {
      this.showConnectionCard(line, e.lngLat);
      return;
    }
    this.showDroppedPin(e.lngLat);
  }

  private handleContextMenu(e: MapMouseEvent): void {
    if (!this.map || !this.campaign) return;
    e.originalEvent.preventDefault();
    const lngLat = e.lngLat;
    const point: [number, number] = [lngLat.lng, lngLat.lat];
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Add location here")
        .setIcon("plus")
        .onClick(() => this.openQuickAdd(point))
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy coordinates")
        .setIcon("copy")
        .onClick(() => {
          void navigator.clipboard.writeText(`${lngLat.lng.toFixed(4)}, ${lngLat.lat.toFixed(4)}`);
          new Notice("Campaign Map: coordinates copied");
        })
    );
    // Explicit generation lives on the right-click grammar (plan 019): the
    // only way procedural fabric appears, changes, or goes away is the GM
    // asking at a spot. Fictional campaigns only — real cities have basemaps.
    if (this.campaign.config.crs === "fictional") {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Generate fabric here")
          .setIcon("wand")
          .onClick(() => void this.generateFabricHere(point))
      );
      menu.addItem((item) =>
        item
          .setTitle("Regenerate fabric here")
          .setIcon("refresh-cw")
          .onClick(() => void this.regenerateFabricHere(point))
      );
      menu.addItem((item) =>
        item
          .setTitle("Clear generated fabric here")
          .setIcon("eraser")
          .onClick(() => void this.clearGeneratedHere(point))
      );
    }
    menu.showAtPosition({ x: e.originalEvent.clientX, y: e.originalEvent.clientY });
  }

  private handleHoverEnter(e: MapMouseEvent & { features?: MapGeoJSONFeature[] }): void {
    if (!this.map) return;
    this.map.getCanvas().style.cursor = "pointer";
    const feature = e.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    this.hoverPopup?.remove();
    this.hoverPopup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "campaign-map-hover-tooltip",
      offset: 12,
    })
      .setLngLat(feature.geometry.coordinates as [number, number])
      .setText(String(feature.properties?.name ?? ""))
      .addTo(this.map);
  }

  private handleHoverLeave(): void {
    if (!this.map) return;
    this.map.getCanvas().style.cursor = "";
    this.hoverPopup?.remove();
    this.hoverPopup = null;
  }

  private handleDragStart(e: MapMouseEvent & { features?: MapGeoJSONFeature[] }): void {
    if (!this.map || !this.campaign) return;
    const feature = this.pickFeatureNear(e.point, ["canon-point", "canon-label"]);
    if (!feature) return;
    const locId = feature.properties?.id as string | undefined;
    const state = this.plugin.getCampaignState(this.campaign.id);
    const location = locId ? state.index.get(locId) : undefined;
    if (!location) return;

    e.preventDefault();
    const startPoint = e.point;
    let dragging = false;
    this.hoverPopup?.remove();
    this.hoverPopup = null;

    const onMove = (moveEvent: MapMouseEvent) => {
      if (!this.map) return;
      const dx = moveEvent.point.x - startPoint.x;
      const dy = moveEvent.point.y - startPoint.y;
      if (!dragging && Math.hypot(dx, dy) > 4) {
        dragging = true;
        this.map.dragPan.disable();
      }
      if (dragging) {
        const fc = state.index.toFeatureCollection();
        const f = fc.features.find((feat) => feat.properties?.id === locId);
        if (f && f.geometry.type === "Point") {
          f.geometry.coordinates = [moveEvent.lngLat.lng, moveEvent.lngLat.lat];
        }
        (this.map.getSource("canon") as maplibregl.GeoJSONSource | undefined)?.setData(fc);
      }
    };

    const onUp = (upEvent: MapMouseEvent) => {
      this.map?.off("mousemove", onMove);
      this.map?.off("mouseup", onUp);
      this.map?.dragPan.enable();
      if (dragging) {
        const newPoint: [number, number] = [upEvent.lngLat.lng, upEvent.lngLat.lat];
        void this.plugin.moveLocation(this.campaign!.id, location, newPoint);
      }
    };

    this.map.on("mousemove", onMove);
    this.map.on("mouseup", onUp);
  }

  private showPlaceCard(feature: MapGeoJSONFeature): void {
    if (!this.map || !this.campaign || feature.geometry.type !== "Point") return;
    this.placeCardPopup?.remove();
    this.droppedPinPopup?.remove();

    const locId = feature.properties?.id as string | undefined;
    const location = locId ? this.plugin.getCampaignState(this.campaign.id).index.get(locId) : undefined;
    if (!location) return;

    const el = document.createElement("div");
    el.addClass("campaign-map-place-card");
    el.createEl("h4", { text: location.name });
    const previewEl = el.createDiv({ cls: "campaign-map-place-card-preview" });

    const file = this.app.vault.getAbstractFileByPath(location.path);
    if (file instanceof TFile) {
      void this.app.vault.cachedRead(file).then((content) => {
        const bodyOnly = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        const preview = bodyOnly.split("\n").slice(0, 4).join("\n") || "*No notes yet.*";
        void MarkdownRenderer.render(this.app, preview, previewEl, location.path, this);
      });
    }

    // Plan 015: retune label visibility mid-session in one click — no
    // frontmatter edit. Writes the explicit `visibility` field; the metadataCache
    // change re-reconciles and the map updates.
    const VIS_LABELS: Record<Visibility, string> = {
      wide: "Wide — always shown",
      mid: "Mid — from mid zoom",
      close: "Close — only up close",
    };
    const visRow = el.createDiv({ cls: "campaign-map-place-card-visibility" });
    visRow.createEl("label", { text: "Visibility", cls: "campaign-map-place-card-visibility-label" });
    const visSelect = visRow.createEl("select", { cls: "campaign-map-place-card-visibility-select" });
    for (const v of VISIBILITY_VALUES) {
      const opt = visSelect.createEl("option", { text: VIS_LABELS[v], value: v });
      if (v === location.visibility) opt.selected = true;
    }
    visSelect.onchange = () => {
      void setLocationVisibility(this.app, location, visSelect.value as Visibility).then(() => {
        new Notice(`Campaign Map: "${location.name}" visibility → ${visSelect.value}`);
      });
    };

    const actions = el.createDiv({ cls: "campaign-map-place-card-actions" });
    // One button, not two: "Open note" and "Edit" both just opened the file —
    // the only real difference was reading vs. editor mode, so open straight
    // to source/edit mode and drop the redundant second button.
    actions.createEl("button", { text: "Open note" }).onclick = () => {
      if (file instanceof TFile) {
        void this.app.workspace.getLeaf("split").openFile(file, { state: { mode: "source" }, eState: { focus: true } });
      }
    };
    actions.createEl("button", { text: "Center" }).onclick = () => {
      if (location.point) this.map?.flyTo({ center: location.point });
    };
    actions.createEl("button", { text: "Connect to…" }).onclick = () => {
      const others = this.plugin
        .getCampaignState(this.campaign!.id)
        .index.all()
        .filter((l) => l.path !== location.path && l.point);
      new LocationSearchModal(this.app, others, (target) => {
        void addConnection(this.app, location.path, target.name).then(() => {
          new Notice(`Campaign Map: connected ${location.name} → ${target.name}`);
        });
      }).open();
    };

    this.placeCardPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "campaign-map-place-card-popup" })
      .setLngLat(feature.geometry.coordinates as [number, number])
      .setDOMContent(el)
      .addTo(this.map);
  }

  private showDroppedPin(lngLat: maplibregl.LngLat): void {
    if (!this.map || !this.campaign) return;
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();

    const nearest = this.plugin
      .getCampaignState(this.campaign.id)
      .index.nearest([lngLat.lng, lngLat.lat], 1)[0];

    const el = document.createElement("div");
    el.addClass("campaign-map-dropped-pin-tooltip");
    el.createDiv({
      text: nearest ? `Near ${nearest.name}` : `${lngLat.lng.toFixed(2)}, ${lngLat.lat.toFixed(2)}`,
      cls: "campaign-map-dropped-pin-context",
    });
    const btn = el.createEl("button", { text: "+ Add location here", cls: "campaign-map-add-here-btn" });
    btn.onclick = () => {
      this.droppedPinPopup?.remove();
      this.openQuickAdd([lngLat.lng, lngLat.lat]);
    };

    this.droppedPinPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, className: "campaign-map-dropped-pin-popup" })
      .setLngLat(lngLat)
      .setDOMContent(el)
      .addTo(this.map);
  }

  /** Click-a-line-to-remove (plan 005): the reciprocal gesture to "Connect
   * to..." — `from`/`to` on a `connection-line` feature are vault paths (plan
   * 004), so resolve them to basenames the same way the frontmatter stores
   * them. Only the declaring end actually has the entry, so removal is
   * attempted on both ends; the non-declaring side is a harmless no-op. */
  private showConnectionCard(feature: MapGeoJSONFeature, lngLat: maplibregl.LngLat): void {
    if (!this.map || !this.campaign) return;
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();

    const from = String(feature.properties?.from ?? "");
    const to = String(feature.properties?.to ?? "");
    const fromName = this.app.vault.getFileByPath(from)?.basename ?? from;
    const toName = this.app.vault.getFileByPath(to)?.basename ?? to;

    const el = document.createElement("div");
    el.addClass("campaign-map-place-card");
    el.createEl("h4", { text: `${fromName} ↔ ${toName}` });
    el.createDiv({ cls: "campaign-map-place-card-preview", text: "Point-crawl connection" });

    const actions = el.createDiv({ cls: "campaign-map-place-card-actions" });
    actions.createEl("button", { text: "Remove connection" }).onclick = () => {
      void Promise.all([removeConnection(this.app, from, toName), removeConnection(this.app, to, fromName)]).then(() => {
        this.placeCardPopup?.remove();
        new Notice(`Campaign Map: removed connection ${fromName} ↔ ${toName}`);
      });
    };

    this.placeCardPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "campaign-map-place-card-popup" })
      .setLngLat(lngLat)
      .setDOMContent(el)
      .addTo(this.map);
  }

  private pulseFeature(loc: ParsedLocation): void {
    if (!this.map || !loc.point) return;
    const el = document.createElement("div");
    el.addClass("campaign-map-pulse");
    const marker = new maplibregl.Marker({ element: el }).setLngLat(loc.point).addTo(this.map);
    setTimeout(() => marker.remove(), 900);
  }
}

import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, MarkdownRenderer, Notice, TFile, setIcon, FuzzySuggestModal, App } from "obsidian";
import maplibregl, { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import type { ParsedCampaign } from "../model/campaignConfig";
import { LOCATION_TYPES, VISIBILITY_VALUES, type ParsedLocation, type Visibility } from "../model/locationNote";
import { buildConnectionFeatures } from "../model/connections";
import { parseSessionPath, sessionPathFeature } from "../model/sessionPath";
import { appendLogEntry, campaignFolderFromConfigPath, type LogEntry } from "../model/mutationLog";
import {
  MapController,
  type ControllerGenContext,
} from "../controller/MapController";
import { boundsToBBox, transformFeatureUnits } from "../controller/units";
import {
  FABRIC_KINDS,
  isPolygonKind,
  isProcgenRegion,
  makeFabricId,
  type FabricFeature,
  type FabricKind,
} from "../model/fabric";
import { loadFabric, saveFabric } from "../vault/fabricStore";
import { loadGeneratedManifest, saveGeneratedManifest } from "../vault/generatedManifestStore";
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
import type { BBox } from "../gen/spatialHash";
import { generateRegionTile, generateTile, type GenerationContext } from "../map/generation/generationService";
import { algorithmForKind, matchingPresetId, presetById, type ProcgenAlgorithm } from "../gen/procgen/registry";
import { RegionProcgenModal } from "./RegionProcgenModal";
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
  /** Sketch mode (plan 013): the durable fabric collection now lives on the
   * MapController; MapView reads it via `this.controller.fabric` to paint and
   * hit-test, and `refreshFabric()` re-applies it after any style rebuild. */
  private sketchMode = false;
  private sketchKind: FabricKind = "road";
  private sketchController: SketchController | null = null;
  private sketchBarEl: HTMLDivElement | null = null;
  /** Select-tool panel (plan 020 §9): name field + procgen section for the
   * currently-selected fabric feature. Anchored under the sketch sub-bar. */
  private selectionPanelEl: HTMLDivElement | null = null;
  private selectedFabricId: string | null = null;
  /** Which sketch tool is armed (plan 020 §9): the Select arrow (edit an
   * existing shape) or the draw palette (add a new one). */
  private sketchTool: "draw" | "select" = "draw";
  /** Re-syncs the sub-bar tool highlights to `sketchTool`/`sketchKind` — set by
   * buildSketchBar, called when the tool changes programmatically (e.g. the
   * "Edit shape" context-menu path arms Select without a button click). */
  private syncSketchToolButtons: (() => void) | null = null;
  private sketchKeyHandler: ((ev: KeyboardEvent) => void) | null = null;
  /** Toolbar pencil button — kept so sketch mode can show a pressed/active
   * state on it (plan 016: re-click to exit is only discoverable if the button
   * looks toggled). */
  private pencilBtnEl: HTMLButtonElement | null = null;
  /** Debounce for regenerating manifest tiles a sketch edit touches (plan
   * 019 Phase 3: "sketch a river, streets adapt" is one gesture) — cleared
   * on mode exit / onClose so it can never fire after teardown. The debounce
   * TIMER lives here (MapView owns `window`); the queued work + flush logic
   * live on the controller (armed via the render sink's `armRegenFlush`). */
  private sketchAutoBuildTimer: number | null = null;

  /** The host-agnostic lifecycle brain (plan 021 §2.4). Owns generation /
   * regen / clear / undo / replay / migration / region-procgen / sketch-commit
   * orchestration and the state those touch (render store, manifest, fabric).
   * MapView is wiring + paint: it builds the controller with Obsidian-backed
   * gateways below and forwards every gate-facing test-API method here. */
  private controller: MapController;

  constructor(leaf: WorkspaceLeaf, plugin: CampaignMapPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.controller = new MapController({
      vault: {
        loadFabric: (c) => loadFabric(this.app, c),
        saveFabric: (c, f) => saveFabric(this.app, c, f),
        loadManifest: (c) => loadGeneratedManifest(this.app, c),
        saveManifest: (c, m) => saveGeneratedManifest(this.app, c, m),
        appendLog: (folder, e) => appendLogEntry(this.app, folder, e),
        readLog: (id) => this.plugin.log.read(id),
        readCached: (folder) => readCachedTiles(this.app, folder),
        removeCached: (folder, keys) => removeCachedTiles(this.app, folder, keys),
      },
      gen: {
        getWorker: () => this.plugin.getGenerationWorker(),
        generateTile: (ctx, tx, ty, gid, gen, opts) =>
          generateTile(this.withApp(ctx), tx, ty, gid, gen, opts),
        generateRegionTile: (ctx, region, ids, tx, ty, compute, opts) =>
          generateRegionTile(this.withApp(ctx), region, ids, tx, ty, compute, opts),
      },
      canon: {
        canonFeatureCollection: (id) => this.plugin.getCampaignState(id).index.toFeatureCollection(),
      },
      notes: {
        undoNoteEntry: (entry) => this.undoNoteEntry(entry),
      },
      notices: {
        notify: (message, timeoutMs) => {
          new Notice(message, timeoutMs);
        },
      },
      render: {
        repaintGenerated: () => this.refreshGeneratedSource(),
        repaintFabric: () => this.refreshFabric(),
        loadingChanged: () => this.updateLoadingIndicator(),
        featureChanged: (id, opts) => this.onControllerFeatureChanged(id, opts),
        selectionInvalidated: (id, opts) => {
          if (this.selectedFabricId !== id) return;
          if (opts?.keepPanel) {
            // Sketch-mode undo cleared the selection + handles but left the
            // panel up (byte-identical to pre-extraction undoLastSketch).
            this.selectedFabricId = null;
            this.sketchController?.clearSelection();
          } else {
            this.deselectFabric();
          }
        },
        armRegenFlush: () => this.armSketchRegen(),
      },
      viewport: {
        zoom: () => this.map?.getZoom() ?? 0,
        centerUnits: () => this.mapCenterUnits(),
      },
    });
  }

  /** Add the Obsidian `app` back onto a controller gen-context before handing
   * it to the App-based generation service (keeps `App` out of the controller,
   * plan 021 §2.4). */
  private withApp(ctx: ControllerGenContext): GenerationContext {
    return { ...ctx, app: this.app };
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
    // The controller drops its own per-campaign state (render store, manifest,
    // fabric) on a genuine switch and tells us so we can reset the view-side
    // (selection / session-path / sketch-mode / camera-replay) state to match.
    const { switched } = this.controller.beginCampaign(campaign);
    if (switched) {
      this.currentSessionPathFeature = null;
      this.replayToken++; // stop any in-flight camera replay from the previous campaign
      this.selectedFabricId = null;
      if (this.sketchMode) this.toggleSketchMode(); // exit sketch mode on campaign switch
    }
    this.campaign = campaign;
    void this.controller.loadFabric();
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
    void this.controller.replayGeneratedManifest();
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
   * "Generate fabric here" (plan 019/020) — the explicit generation trigger
   * for the WORLD tier, and the re-clip trigger for a procgen region at city
   * zoom. World tier: paints the clicked tile and appends a durable manifest
   * entry (unchanged). City tier: city procgen is polygon-scoped now — a
   * click INSIDE a region re-clips/repaints it (cache path); a click outside
   * any region points the GM at the district tool. Founding a city by
   * clicking is retired (plan 020 §8.1): sketch a district instead.
   */
  async generateFabricHere(
    point?: [number, number],
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<GeoJSON.Feature[]> {
    if (!this.map) return [];
    return this.controller.generateFabricHere(point, opts);
  }

  /**
   * "Regenerate fabric here" (plan 019/020, D4): re-runs generation at this
   * spot against CURRENT constraints. A region under the point regenerates
   * whole (drops its network + tile records, recomputes); world-tier entries
   * on the tile regenerate their tile. Nothing here → first-time generate.
   */
  async regenerateFabricHere(point?: [number, number]): Promise<GeoJSON.Feature[]> {
    if (!this.map) return [];
    return this.controller.regenerateFabricHere(point);
  }

  /** "Clear generated fabric here" (plan 019, D4): drops this tile's WORLD
   * manifest entries + cache records + paint. City procgen is removed via
   * "Remove generated city here" (strips the shape's procgen block) instead. */
  async clearGeneratedHere(point?: [number, number]): Promise<number> {
    if (!this.map) return 0;
    return this.controller.clearGeneratedHere(point);
  }

  /** "Clear all generated fabric" (plan 019/020, D4): removes world manifest
   * entries + records, and strips every region's procgen block (each shape
   * stays, inert). Sketched geometry and locations are untouched. */
  async clearAllGenerated(): Promise<number> {
    return this.controller.clearAllGenerated();
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

  /** Undo the last map-originated write. The lifecycle branches (sketch-* /
   * generate-area / clear-area) live on the controller; the note-file branches
   * (create / move) come back here via the `notes.undoNoteEntry` gateway. */
  async undoLastEdit(): Promise<void> {
    return this.controller.undoLastEdit();
  }

  /** Note-file undo (create / move) — Obsidian TFile ops the controller can't
   * do (it's host-agnostic). Called back through the controller's `notes`
   * gateway from `undoLastEdit`. */
  private async undoNoteEntry(entry: LogEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (entry.type === "create") {
      if (file instanceof TFile) await this.app.vault.delete(file);
      new Notice(`Campaign Map: undid creation of "${entry.path.split("/").pop()}"`);
    } else if (entry.type === "move") {
      const from = (entry.data as { from?: [number, number] }).from;
      if (file instanceof TFile && from) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.geometry = from;
        });
        new Notice("Campaign Map: undid move");
      }
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

  /** Repaints the `generated` source from the controller's render store
   * (already converted to display units). Called from the load/styledata paint
   * paths and from the controller's render sink after any generation. */
  private refreshGeneratedSource(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("generated") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData({ type: "FeatureCollection", features: this.controller.displayGenerated() });
  }

  private updateLoadingIndicator(): void {
    this.loadingIndicatorEl.style.display = this.controller.pendingGenerationCount > 0 ? "" : "none";
  }

  /** Test/perf-gate surface: how many tile entries the render store holds
   * (bounded by what the GM has explicitly generated, plan 019). */
  get loadedTileCount(): number {
    return this.controller.loadedTileCount;
  }

  /** The render store (generation-space features, keyed by tier/region tile),
   * re-surfaced from the controller for the CLI eval-testing surface: gate
   * scripts iterate `view.loadedTiles.forEach(...)` directly (docs/05, plan
   * 021 §2.4 keeps this eval surface byte-identical to callers). */
  get loadedTiles(): Map<string, GeoJSON.Feature[]> {
    return this.controller.renderStore;
  }

  /** Gate surface (plan 019 Phase 2): actual generator executions this
   * session — pan/zoom aggressively and this must not move. */
  get generatorRunCount(): number {
    return this.controller.generatorRunCount;
  }

  /** Display-space (fictional units) — matches what's actually rendered/queryable on the map. */
  get generated(): GeoJSON.Feature[] {
    return this.controller.displayGenerated();
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

  // ─── Region procgen lifecycle (plan 020 §8.1/§8.4) ────────────────────

  /** "Remove generated city here" (plan 020 §8.4): strips the procgen block
   * of the region under the point — the shape stays, the city is gone. */
  async removeGeneratedCityHere(point?: [number, number]): Promise<number> {
    if (!this.map) return 0;
    return this.controller.removeGeneratedCityHere(point);
  }

  /** Offer procgen for a just-finished district sketch (plan 020 §8.1): the
   * interactive (modal) path stays in MapView — validate the ring, reject
   * overlap, open the modal, and (on confirm) hand off to the controller's
   * headless attach+generate lifecycle. Cancel keeps the shape inert. */
  private maybeOfferProcgen(feature: FabricFeature): void {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return;
    const algorithm = algorithmForKind(feature.properties.kind);
    if (!algorithm) return;
    // Kind-aware validation (plan 022 §2): polygon → ring + overlap; line →
    // spine polyline (spines may cross, so no overlap rejection). Unit math
    // stays on the controller.
    const validation = this.controller.validateForProcgen(feature, algorithm.id);
    if (!validation.ok) {
      const label = algorithm.label.toLowerCase();
      new Notice(
        validation.overlap
          ? `Campaign Map: overlaps an existing ${label} — they can't overlap. Kept as a plain shape.`
          : `Campaign Map: can't grow a ${label} here — ${validation.reason}. Kept as a plain shape.`,
        8000
      );
      return;
    }
    new RegionProcgenModal(this.app, algorithm, this.campaign.config.theme, (choice) => {
      if (!choice) return; // "Keep as plain shape" — inert district
      void this.controller.attachProcgenAndGenerate(feature, algorithm, choice.params).then(() => {
        if (this.selectedFabricId === feature.id) this.refreshSelectionPanel();
      });
    }).open();
  }

  /** Headless region creation (gate/test path — the RegionProcgenModal would
   * hang CLI automation): sketch a district from a display-space ring, attach a
   * procgen block, and generate. Returns a containment summary so a gate can
   * assert every emitted coordinate is inside the polygon. */
  async createRegionForTest(
    ringUnits: [number, number][],
    algorithmId: string,
    params: Record<string, unknown>,
    name?: string
  ): Promise<{ featureId: string; count: number; outside: number }> {
    return this.controller.createRegionForTest(ringUnits, algorithmId, params, name);
  }

  /** Headless spine (line-kind) creation — the gate/test twin for rivers (plan
   * 022 §2). Sketches a `kind` line, attaches a procgen block, generates, and
   * returns the corridor containment summary. */
  async createSpineForTest(
    coordsUnits: [number, number][],
    kind: FabricKind,
    algorithmId: string,
    params: Record<string, unknown>,
    name?: string
  ): Promise<{ featureId: string; count: number; outside: number }> {
    return this.controller.createSpineForTest(coordsUnits, kind, algorithmId, params, name);
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
    // Canon only: generated content has no label layers anymore — named
    // places are Locations (plan 019, D2).
    for (const depth of ["deep", "medium", "shallow"] as const) {
      const id = `canon-label-${depth}`;
      if (this.map.getLayer(id)) this.map.setLayerZoomRange(id, reveal[depth], 24);
    }
    // Generated building detail (footprints/parcels) is NO LONGER zoom-gated
    // (Jonah 2026-07-12: "the small buildings pop in and out at different
    // zooms — i'd rather they always show"). The former relative reveal
    // floors (overview+4 / overview+5) are gone; these layers now render at
    // every zoom like all other fabric, matching the standing Kanto-test
    // ruling ("LOD should only impact visibility of location names"). Any
    // far-out readability treatment is a paint-level theme decision, not a
    // zoom gate — see generatedLayers.ts.
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

  /** Sketched fabric (plan 013) — modeled on `refreshConnections`: re-applies
   * the controller's in-memory collection to the `fabric` source; called from
   * `refreshSource()` so a theme switch's setStyle (which wipes every source)
   * doesn't drop the GM's sketches, and from the controller's render sink after
   * any fabric mutation. The feature-level `id` is mirrored into `properties.id`
   * because queryRenderedFeatures doesn't reliably surface string feature ids
   * from a geojson source. */
  private refreshFabric(): void {
    if (!this.map) return;
    const source = this.map.getSource("fabric") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const features = this.controller.fabric.features.map((f) => ({
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
      // NOTE: a pending constraint-regen debounce is deliberately NOT
      // cancelled here — "sketch a river, hit done" must still adapt the
      // generated tiles (plan 019). onClose still cancels it on teardown.
      this.sketchController?.deactivate();
      this.sketchController = null;
      this.sketchBarEl?.remove();
      this.sketchBarEl = null;
      this.selectionPanelEl?.remove();
      this.selectionPanelEl = null;
      this.syncSketchToolButtons = null;
      this.selectedFabricId = null;
      this.sketchTool = "draw";
      if (this.sketchKeyHandler) {
        window.removeEventListener("keydown", this.sketchKeyHandler, true);
        this.sketchKeyHandler = null;
      }
      this.map.doubleClickZoom.enable();
      this.pencilBtnEl?.toggleClass("is-active", false);
      return;
    }
    this.sketchMode = true;
    void this.controller.loadFabric();
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();
    this.map.doubleClickZoom.disable();
    this.sketchController = new SketchController(this.map, this.sketchAccent(), {
      onGeometryEdit: (featureId, geometry) => void this.controller.commitGeometryEdit(featureId, geometry, { debounce: true }),
      onCenterEdit: (featureId, center) => void this.controller.setRegionCenter(featureId, center),
    });
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

    // Select tool (plan 020 §9): first position, arrow icon. Arming it lets a
    // click pick an existing shape to edit (vertices + properties); arming a
    // kind returns to drawing new shapes.
    const selectBtn = this.sketchBarEl.createEl("button", {
      cls: "campaign-map-sketch-kind-btn campaign-map-sketch-select-btn",
      attr: { title: "Select & edit an existing shape (move/insert/delete vertices)" },
    });
    setIcon(selectBtn, "mouse-pointer-2");

    const syncToolButtons = (): void => {
      selectBtn.toggleClass("is-active", this.sketchTool === "select");
      for (const [k, b] of kindButtons) b.toggleClass("is-active", this.sketchTool === "draw" && k === this.sketchKind);
    };
    this.syncSketchToolButtons = syncToolButtons;

    for (const kind of FABRIC_KINDS) {
      const b = this.sketchBarEl.createEl("button", {
        text: kind,
        cls: "campaign-map-sketch-kind-btn",
        attr: { title: `Sketch a ${kind} (${isPolygonKind(kind) ? "polygon" : "line"})` },
      });
      b.onclick = () => {
        this.sketchKind = kind;
        this.setSketchTool("draw");
        this.sketchController?.setKind(kind);
        syncToolButtons();
      };
      kindButtons.set(kind, b);
    }
    selectBtn.onclick = () => {
      this.setSketchTool("select");
      syncToolButtons();
    };

    // Plan 019: no feed-mode toggle, no "build" button — EVERY sketched
    // feature is a generator constraint, and tiles the GM already generated
    // regenerate on their own after a sketch edit (queueConstraintRegen).
    const undoBtn = this.sketchBarEl.createEl("button", {
      text: "↶ undo",
      cls: "campaign-map-sketch-kind-btn",
      attr: { title: "Undo the last sketch action (Cmd/Ctrl-Z)" },
    });
    undoBtn.onclick = () => void this.undoInSketchMode();
    this.sketchBarEl.createDiv({
      cls: "campaign-map-sketch-hint",
      text: "draw: click vertex · dbl-click/Enter finish · select: drag handle to move · midpoint to add · Del removes vertex/shape · Esc/⌘Z",
    });
    const exit = this.sketchBarEl.createEl("button", {
      text: "✕ done",
      cls: "campaign-map-sketch-exit-btn",
      attr: { title: "Exit sketch mode (or press Escape)" },
    });
    exit.onclick = () => this.toggleSketchMode();
    syncToolButtons();
  }

  /** Arm a sketch tool (draw palette vs. Select arrow). Leaving Select tears
   * down the selection + its panel; entering it cancels any draft. */
  private setSketchTool(tool: "draw" | "select"): void {
    this.sketchTool = tool;
    this.sketchController?.setTool(tool);
    if (tool === "draw") this.deselectFabric();
    this.syncSketchToolButtons?.();
  }

  private sketchKeydown(ev: KeyboardEvent): void {
    if (!this.sketchMode) return;
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "z" || ev.key === "Z") && !ev.shiftKey) {
      // Intercept before Obsidian's global undo so Cmd/Ctrl-Z means "undo the
      // last sketch" while landscaping (plan 016).
      ev.preventDefault();
      ev.stopPropagation();
      void this.undoInSketchMode();
    } else if (ev.key === "Enter") {
      if (this.sketchController?.isDrawing) {
        ev.preventDefault();
        this.finalizeSketchDraft();
      }
    } else if (ev.key === "Escape") {
      // Two-stage: a first Escape cancels an in-progress draft or clears the
      // current selection; with neither it exits the mode. The prominent ✕
      // done button and the toggled pencil are the always-reachable mouse exits.
      ev.preventDefault();
      if (this.sketchController?.isDrawing) this.sketchController.cancel();
      else if (this.selectedFabricId) this.deselectFabric();
      else this.toggleSketchMode();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      const c = this.sketchController;
      // Grabbed/hovered vertex → delete just that vertex (min-vertex floored);
      // otherwise the whole selected shape (plan 020 §9).
      if (c?.hasActiveVertex) {
        ev.preventDefault();
        const result = c.deleteActiveVertex();
        if (result === "min") {
          new Notice("Campaign Map: can't remove — a shape needs its minimum vertices (2 line / 3 polygon)");
        }
      } else if (this.selectedFabricId) {
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
    // Mid-draft (draw tool): every click is a vertex.
    if (c.isDrawing) {
      c.addVertex([e.lngLat.lng, e.lngLat.lat]);
      return;
    }
    // A vertex/midpoint grab consumed this click (drag or insert) — don't let
    // it also reselect/deselect (advisor #4: the flag is cleared on the next
    // mousedown, so it can never go stale and eat a legit click).
    if (c.consumeInteraction()) return;

    if (this.sketchTool === "select") {
      // Select tool: click a shape to edit it; click empty ground to deselect.
      const hitId = this.fabricFeatureIdAt(e.point);
      if (hitId) this.selectFabricFeature(hitId);
      else this.deselectFabric();
      return;
    }
    // Draw tool, no draft yet: a click starts a new shape.
    this.deselectFabric();
    c.addVertex([e.lngLat.lng, e.lngLat.lat]);
  }

  /** Hit-test the rendered fabric layers near a screen point, resolving to the
   * FabricFeature id via the mirrored `properties.id` (refreshFabric mirrors
   * the feature id there because queryRenderedFeatures doesn't reliably
   * surface string feature ids from a geojson source). */
  private fabricFeatureIdAt(point: maplibregl.Point): string | null {
    if (!this.map) return null;
    const layers = FABRIC_LAYER_IDS.filter((l) => this.map!.getLayer(l));
    if (layers.length === 0) return null;
    const hits = this.map.queryRenderedFeatures(
      [
        [point.x - 6, point.y - 6],
        [point.x + 6, point.y + 6],
      ],
      { layers }
    );
    const hitId = hits[0]?.properties?.id as string | undefined;
    if (hitId) return this.controller.fabricFeature(hitId) ? hitId : null;
    // Fallback: a spine region's sketch line paints invisible under its
    // generated channel (fabricLayers), and a meandered channel can sit
    // farther from the spine than the 6px box — clicking the WATER should
    // still select the river. Corridor-exact resolution on the controller.
    const lngLat = this.map.unproject(point);
    return this.controller.spineRegionIdAtDisplayPoint(lngLat.lng, lngLat.lat);
  }

  /** Select a fabric feature for editing (Select tool): arm the controller's
   * edit state (handles) and open the selected-feature panel. Re-selecting the
   * same id after a commit resets the controller baseline to persisted geom. */
  private selectFabricFeature(id: string): void {
    const feature = this.controller.fabricFeature(id);
    if (!feature) return;
    this.selectedFabricId = id;
    this.reselectController(feature);
    this.buildSelectionPanel(feature);
  }

  /** (Re)arm the SketchController's edit handles for a feature — includes the
   * effective generation-center handle (Addendum 2, computed on the lifecycle
   * controller) for a procgen region. */
  private reselectController(feature: FabricFeature): void {
    const center = isProcgenRegion(feature) ? this.controller.effectiveRegionCenterDisplay(feature) : null;
    this.sketchController?.select({
      id: feature.id,
      geometry: feature.geometry,
      kind: feature.properties.kind,
      center,
    });
  }

  /** Clear any Select-tool selection + its panel. */
  private deselectFabric(): void {
    this.selectedFabricId = null;
    this.sketchController?.clearSelection();
    this.selectionPanelEl?.remove();
    this.selectionPanelEl = null;
  }

  private handleSketchDblClick(e: MapMouseEvent): void {
    if (!this.sketchMode || !this.sketchController?.isDrawing) return;
    e.preventDefault();
    this.finalizeSketchDraft();
  }

  /** Draft → FabricFeature → controller (in-memory collection → Fabric.geojson
   * + mutation log `sketch-add` + constraint regen), rendering optimistically. */
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
      properties: { kind },
    };
    this.controller.addSketchedFeature(feature);
    // Immediate confirmation regardless of zoom (a below-minzoom stroke paints
    // into the `fabric` source but its themed layer may be hidden until you
    // zoom in — the toast guarantees "something happened" feedback). Plan 016.
    new Notice(`Campaign Map: ${kind} added`);
    // Plan 020 §8.1: a district sketch IS the request for city procgen — offer
    // it (modal); other kinds (or a cancelled modal) stay inert overlay shapes.
    this.maybeOfferProcgen(feature);
  }

  /** Arms the debounced constraint/region regen (plan 019 Phase 3 "sketch a
   * river, streets adapt") — MapView owns the `window` timer; the queued work
   * lives on the controller, which arms this via the render sink. Cleared on
   * mode exit / onClose so it can never fire after teardown. */
  private armSketchRegen(): void {
    if (this.sketchAutoBuildTimer !== null) window.clearTimeout(this.sketchAutoBuildTimer);
    this.sketchAutoBuildTimer = window.setTimeout(() => {
      this.sketchAutoBuildTimer = null;
      void this.controller.flushSketchRegen();
    }, 400);
  }

  private deleteSelectedFabric(): void {
    if (!this.selectedFabricId || !this.campaign) return;
    const id = this.selectedFabricId;
    if (!this.controller.fabricFeature(id)) {
      this.selectedFabricId = null;
      return;
    }
    // The controller drops the feature (+ any generated city), repaints,
    // persists (`sketch-remove`), notices, and re-adapts constraints; it calls
    // back through the render sink's `selectionInvalidated` to deselect here.
    this.controller.deleteFabricFeature(id);
  }

  /** Sketch-mode undo dispatcher (Cmd/Ctrl-Z and the ↶ button) — delegates to
   * the controller, which peeks the log tail and either reverses the last
   * geometry/procgen edit or nets the last sketch-add/remove pair. */
  private async undoInSketchMode(): Promise<void> {
    await this.controller.undoInSketchMode();
  }

  // ─── Selected-feature panel (plan 020 §9) ──────────────────────────────

  /** Render-sink hook: the controller changed a feature in place. If it's the
   * selected one, re-sync the edit handles (`reselect`) and/or rebuild the
   * panel (`panel`, default true) — the controller owns no selection state, so
   * that decision lives here. */
  private onControllerFeatureChanged(featureId: string, opts?: { reselect?: boolean; panel?: boolean }): void {
    if (this.selectedFabricId !== featureId) return;
    if (opts?.reselect) {
      const feature = this.controller.fabricFeature(featureId);
      if (feature) this.reselectController(feature);
    }
    if (opts?.panel ?? true) this.refreshSelectionPanel();
  }

  /** Rebuild the selected-feature panel from the current fabric state (after a
   * geometry/name/procgen change). No-op when nothing is selected. */
  private refreshSelectionPanel(): void {
    if (!this.selectedFabricId) return;
    const feature = this.controller.fabricFeature(this.selectedFabricId);
    if (feature) this.buildSelectionPanel(feature);
    else {
      this.selectionPanelEl?.remove();
      this.selectionPanelEl = null;
    }
  }

  /** The small overlay under the sketch bar: kind label, editable name, and —
   * for a kind with a registry algorithm — the procgen section (generate /
   * profile / re-roll / regenerate / remove). Native-Obsidian createEl. */
  private buildSelectionPanel(feature: FabricFeature): void {
    if (!this.sketchBarEl) return;
    this.selectionPanelEl?.remove();
    const panel = this.contentEl.createDiv({ cls: "campaign-map-sketch-selection" });
    this.selectionPanelEl = panel;

    const header = panel.createDiv({ cls: "campaign-map-sketch-selection-header" });
    header.createSpan({ cls: "campaign-map-sketch-selection-kind", text: feature.properties.kind });
    const close = header.createEl("button", {
      cls: "campaign-map-sketch-selection-close",
      text: "✕",
      attr: { title: "Deselect (Esc)" },
    });
    close.onclick = () => this.deselectFabric();

    const nameRow = panel.createDiv({ cls: "campaign-map-sketch-selection-row" });
    nameRow.createSpan({ cls: "campaign-map-sketch-selection-label", text: "Name" });
    const nameInput = nameRow.createEl("input", {
      cls: "campaign-map-sketch-selection-name",
      attr: { type: "text", placeholder: "(unnamed)" },
    });
    nameInput.value = feature.properties.name ?? "";
    const commitName = (): void => {
      const current = this.controller.fabricFeature(feature.id);
      if (!current) return;
      const v = nameInput.value.trim();
      const newName = v.length ? v : undefined;
      if ((current.properties.name ?? undefined) === newName) return;
      const after: FabricFeature = { ...current, properties: { ...current.properties, name: newName } };
      void this.controller.commitSketchEdit(current, after, { debounce: false });
    };
    nameInput.onblur = commitName;
    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        nameInput.blur();
      }
    });

    const algorithm = algorithmForKind(feature.properties.kind);
    if (algorithm && this.campaign?.config.crs === "fictional") {
      this.buildProcgenSection(panel, feature, algorithm);
    }
  }

  private buildProcgenSection(panel: HTMLElement, feature: FabricFeature, algorithm: ProcgenAlgorithm): void {
    const section = panel.createDiv({ cls: "campaign-map-sketch-procgen" });
    const block = feature.properties.procgen;
    if (!block) {
      section.createDiv({
        cls: "campaign-map-sketch-procgen-label",
        text: `${algorithm.label}: not generated`,
      });
      const gen = section.createEl("button", {
        cls: "campaign-map-sketch-procgen-btn mod-cta",
        text: `Generate ${algorithm.label.toLowerCase()}…`,
      });
      gen.onclick = () => this.maybeOfferProcgen(feature);
      return;
    }
    // Template (preset) dropdown (plan 022 §1) — the primary control. For city
    // the four profiles ARE the presets, so this replaces the old profile
    // dropdown: picking a template re-seeds params from that preset. When the
    // params have been customised away from every preset the dropdown shows a
    // synthetic "Custom (from …)" option (unreachable for city today, since its
    // only knob IS the preset discriminator — the mechanism is here for the
    // param-carrying algorithms of later 022 phases).
    if (algorithm.presets.length > 0) {
      const row = section.createDiv({ cls: "campaign-map-sketch-selection-row" });
      row.createSpan({ cls: "campaign-map-sketch-selection-label", text: "Template" });
      const dd = row.createEl("select", { cls: "campaign-map-sketch-procgen-select" });
      const currentPreset = matchingPresetId(algorithm, block.params);
      for (const preset of algorithm.presets) {
        const o = dd.createEl("option", { text: preset.label, value: preset.id });
        if (preset.id === currentPreset) o.selected = true;
      }
      if (!currentPreset) {
        const fromLabel = block.presetId ? presetById(algorithm, block.presetId)?.label ?? block.presetId : "preset";
        const custom = dd.createEl("option", { text: `Custom (from ${fromLabel})`, value: "__custom__" });
        custom.selected = true;
      }
      dd.onchange = () => {
        if (dd.value === "__custom__") return;
        void this.setRegionPreset(feature.id, dd.value);
      };
    }
    // Center hint (Addendum 2): drag the diamond handle to place the plaza.
    // Polygon regions only — spine (line) algorithms have no center concept.
    const isPolygonRegion = feature.geometry.type === "Polygon";
    const hasCenter = isPolygonRegion && "center" in block.params;
    if (isPolygonRegion) {
      section.createDiv({
        cls: "campaign-map-sketch-procgen-label",
        text: hasCenter ? "Center: custom (drag the ◆ handle)" : "Center: automatic (drag the ◆ handle to place)",
      });
    }

    const actions = section.createDiv({ cls: "campaign-map-sketch-procgen-actions" });
    const reroll = actions.createEl("button", { cls: "campaign-map-sketch-procgen-btn", text: "Re-roll" });
    reroll.onclick = () => void this.rerollRegion(feature.id);
    const regen = actions.createEl("button", { cls: "campaign-map-sketch-procgen-btn", text: "Regenerate" });
    regen.onclick = () => void this.regenerateRegionById(feature.id);
    if (hasCenter) {
      const resetCenter = actions.createEl("button", { cls: "campaign-map-sketch-procgen-btn", text: "Reset center" });
      resetCenter.onclick = () => void this.setRegionCenter(feature.id, null);
    }
    // "Remove", kind-agnostic (Jonah 2026-07-13: it read "Remove city" on a
    // selected river). Strips the procgen block; the sketch stays inert.
    const remove = actions.createEl("button", {
      cls: "campaign-map-sketch-procgen-btn campaign-map-sketch-procgen-btn-warning",
      text: "Remove",
    });
    remove.onclick = () => void this.removeRegionById(feature.id);
  }

  // ─── Region param actions (panel + test API, plan 020 §9 item 4/7) ─────

  /** Change a region's procgen params (v1: profile) — logs a
   * `sketch-procgen-set` {before: oldBlock, after: newBlock} and force-regens
   * (the id-keyed cache carries no params). Seed unchanged. */
  async setRegionParams(featureId: string, params: Record<string, unknown>): Promise<void> {
    return this.controller.setRegionParams(featureId, params);
  }

  /** Apply a template (preset) to a region — the headless twin of the panel's
   * Template dropdown (plan 022 §1). Resolves the preset → params (keeping any
   * orthogonal params like `center`) and runs the full setRegionParams commit
   * path. City presets carry no `presetId` (params always match a preset), so
   * the persisted block stays byte-identical to the pre-022 `{ profile }`
   * shape. */
  async setRegionPreset(featureId: string, presetId: string): Promise<void> {
    return this.controller.setRegionPreset(featureId, presetId);
  }

  /** Re-roll a region: a NEW seed (`hashSeed(seed, "reroll")`) — the city
   * re-rolls rather than adapting. Logged as `sketch-procgen-set`, force-regen. */
  async rerollRegion(featureId: string): Promise<void> {
    return this.controller.rerollRegion(featureId);
  }

  /** Regenerate a region against CURRENT constraints (drop records + recompute,
   * no block change, no log — idempotent). */
  async regenerateRegionById(featureId: string): Promise<GeoJSON.Feature[]> {
    return this.controller.regenerateRegionById(featureId);
  }

  /** Remove a region's generated city (strip the block; shape stays inert). */
  async removeRegionById(featureId: string): Promise<void> {
    return this.controller.removeRegionById(featureId);
  }

  // ─── Programmatic edit test API (plan 020 §9 item 7, gate procgen41) ────
  // Each runs the FULL commit path (validation, sketch-edit log, persist,
  // regen) synchronously-awaitable, so a gate can assert on the settled state.
  // These forward to the host-agnostic MapController (plan 021 §2.4) — the
  // same surface the FakeHost integration tests drive headlessly.

  /** Create a plain (non-procgen) fabric feature headlessly (gate path — the
   * constraint-loop test needs a river/road/wall/water shape to edit). */
  async createFabricForTest(kind: FabricKind, coordsUnits: [number, number][], name?: string): Promise<string> {
    return this.controller.createFabricForTest(kind, coordsUnits, name);
  }

  /** Delete a fabric feature by id through the real select→delete path
   * (gate/test path for the sketch-remove lifecycle — a region takes its
   * generated city + cache records with it, plan 020 §8.4). Returns whether
   * the feature was found and removed. */
  async deleteFabricForTest(id: string): Promise<boolean> {
    await this.controller.loadFabric();
    if (!this.controller.fabricFeature(id)) return false;
    await this.selectFeature(id);
    this.deleteSelectedFabric();
    return true;
  }

  /** Enter sketch mode + Select tool and select a fabric feature by id. */
  async selectFeature(id: string): Promise<void> {
    if (!this.sketchMode) this.toggleSketchMode();
    this.setSketchTool("select");
    this.selectFabricFeature(id);
  }

  /** Move open-list vertex `index` to `pt` (display units). */
  async moveVertex(id: string, index: number, pt: [number, number]): Promise<boolean> {
    return this.controller.moveVertex(id, index, pt);
  }

  /** Insert a vertex on edge `edgeIndex` at `pt` (display units). */
  async insertVertex(id: string, edgeIndex: number, pt: [number, number]): Promise<boolean> {
    return this.controller.insertVertex(id, edgeIndex, pt);
  }

  /** Delete open-list vertex `index` (min-vertex floored — false if refused). */
  async deleteVertex(id: string, index: number): Promise<boolean> {
    return this.controller.deleteVertex(id, index);
  }

  /** Snapshot the generated feature ids currently painted for a region — the
   * gate's adapt-vs-reroll id-overlap measurement. Optional `generatorId`
   * filter (e.g. "city-street"). */
  regionFeatureIds(regionId: string, generatorId?: string): string[] {
    return this.controller.regionFeatureIds(regionId, generatorId);
  }

  /** Containment report for a region's currently-painted output (gate a/b):
   * `outside === 0` proves "nothing spills past the GM's line" after an edit. */
  regionContainmentReport(regionId: string): { count: number; outside: number } {
    return this.controller.regionContainmentReport(regionId);
  }

  /** Set (or clear, with `null`) a region's persisted generation center
   * (params.center, gen-space meters) via the full commit path — the
   * draggable-plaza feature (Addendum 2). `centerDisplay` is in DISPLAY units. */
  async setRegionCenter(featureId: string, centerDisplay: [number, number] | null): Promise<boolean> {
    return this.controller.setRegionCenter(featureId, centerDisplay);
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

    // Right-click a sketch feature (works OUTSIDE sketch mode too, plan 020
    // §9): "Edit shape" enters sketch mode with it selected; a region also
    // gets "City settings…" (its procgen section in the same panel). The pin/
    // place-card/dropped-pin grammar below is untouched.
    const fabricId = this.fabricFeatureIdAt(e.point);
    const fabricFeature = fabricId ? this.controller.fabricFeature(fabricId) : undefined;
    if (fabricFeature) {
      menu.addItem((item) =>
        item
          .setTitle(`Edit ${fabricFeature.properties.kind} shape`)
          .setIcon("pencil")
          .onClick(() => void this.selectFeature(fabricFeature.id))
      );
      if (algorithmForKind(fabricFeature.properties.kind) && this.campaign.config.crs === "fictional") {
        menu.addItem((item) =>
          item
            .setTitle("City settings…")
            .setIcon("building-2")
            .onClick(() => void this.selectFeature(fabricFeature.id))
        );
      }
      menu.addSeparator();
    }
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
      menu.addItem((item) =>
        item
          .setTitle("Remove generated city here")
          .setIcon("building-2")
          .onClick(() => void this.removeGeneratedCityHere(point))
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

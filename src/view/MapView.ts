import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, MarkdownRenderer, Notice, TFile, setIcon, FuzzySuggestModal, App } from "obsidian";
import maplibregl, { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import type { ParsedCampaign } from "../model/campaignConfig";
import { LOCATION_TYPES, type ParsedLocation } from "../model/locationNote";
import { buildConnectionFeatures } from "../model/connections";
import { parseSessionPath, sessionPathFeature } from "../model/sessionPath";
import { campaignFolderFromConfigPath } from "../model/mutationLog";
import { computeScaleBar, defaultFictionalBounds } from "../map/fictionalCRS";
import { obsidianNativeStyle, readObsidianCssTokens } from "../map/theme";
import { glyphsUrlTemplate, createTransformRequest } from "../map/glyphs";
import { registerVaultBasemap, vaultBasemapBounds } from "../map/pmtilesVaultProtocol";
import { buildThemeStyle, isHandcraftedTheme, HANDCRAFTED_THEMES } from "../map/themes";
import { genreForCampaign } from "../gen/naming/cultures";
import { cultureAt } from "../gen/naming/regions";
import { generateCityStreets, generateDistricts, generateCityBlocks } from "../gen/city";
import { generateWorldRegions, generateSettlements, generateRoutes } from "../gen/world";
import { tileXYForPoint, bandForZoom, generatorIdsForBand, GENERATION_TILE_SIZE, type ZoomBand } from "../gen/cache/tileGrid";
import type { BBox } from "../gen/spatialHash";
import {
  generateTile,
  regenerateTile,
  canonizeFeature,
  type GenerationContext,
  type TileGenerator,
} from "../map/generation/generationService";
import type { GeneratorId } from "../gen/worker/generationWorker";
import type { GenerationWorkerClient } from "../map/generation/workerClient";
import { addConnection, removeConnection } from "../vault/locationOps";
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

  /**
   * Viewport-windowed tile store (Phase 4: "zoom-band dispatcher over
   * `.mapcache/` chunks"), keyed `${band}:${tileX}:${tileY}` — generation-
   * space (meters), same as `.mapcache/` itself. This replaced a flat
   * merge-by-id array that only ever grew: `source.setData()` re-parses the
   * *entire* FeatureCollection on every merge, so an unbounded array makes
   * every subsequent tile slower to render as a pan accumulates history,
   * directly undermining the perf gate. Eviction (tiles outside viewport+
   * margin get dropped on every dispatch) keeps render cost bounded by
   * what's on screen, not by how far the GM has panned this session —
   * cheap to re-fetch on revisit since `.mapcache/` still has it cached.
   */
  private loadedTiles = new Map<string, GeoJSON.Feature[]>();
  /** Tile keys with a generation request in flight — dedup key, not
   * `requestId`, so re-crossing a tile mid-pan doesn't re-dispatch it. */
  private pendingTiles = new Set<string>();
  /** Recomputed on every dispatch; a `loadTile()` in flight checks this on
   * resolution and discards its result if the tile panned out of view
   * while it was generating, instead of resurrecting a stale eviction. */
  private wantedTiles = new Set<string>();
  private dispatchTimer: number | null = null;
  /** Which band the dispatcher last computed, so a genuine zoom-band
   * transition (not just "band unchanged") is what triggers wiping the
   * other tier's tiles — see dispatchViewportTiles() for why this matters. */
  private lastDispatchedBand: ZoomBand | null = null;

  private readonly directGenerators: Record<string, TileGenerator> = {
    "city-street": generateCityStreets,
    "city-district": generateDistricts,
    "city-block": generateCityBlocks,
    "world-region": generateWorldRegions,
    "world-settlement": generateSettlements,
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
      this.pendingTiles.clear();
      this.wantedTiles.clear();
      this.currentSessionPathFeature = null;
      this.replayToken++; // stop any in-flight replay from the previous campaign
    }
    this.campaign = campaign;
    this.refreshHeaderTitle();
    if (this.map && (isFirstApply || themeChanged)) {
      this.map.setStyle(this.buildStyle(campaign));
      this.map.once("styledata", () => {
        this.refreshSource();
        this.refreshGeneratedSource();
      });
    }
    if (this.map) this.applyCampaign();
    this.scheduleDispatch();
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
      this.updateScaleBar();
    });
    this.map.on("move", () => this.updateScaleBar());
    this.map.on("zoom", () => this.updateScaleBar());
    this.map.on("moveend", () => this.scheduleDispatch());
    this.map.on("zoomend", () => this.scheduleDispatch());
    this.map.on("click", (e) => this.handleClick(e));
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
    const btn = (icon: string, label: string, onClick: () => void): void => {
      const b = this.toolbarEl.createEl("button", {
        cls: "campaign-map-toolbar-btn",
        attr: { "aria-label": label, title: label },
      });
      setIcon(b, icon);
      b.onclick = onClick;
    };

    btn("plus", "Add location at center", () => {
      if (!this.map) return;
      const c = this.map.getCenter();
      this.openQuickAdd([c.lng, c.lat]);
    });

    // One "Generate here" that picks the tier from the current zoom, so the GM
    // doesn't have to know the world/city band distinction.
    btn("wand-2", "Generate fabric here", () => {
      if (!this.map) return;
      const band = bandForZoom(this.map.getZoom());
      const run = band === "world" ? this.generateWorldHere() : this.generateCityHere();
      void run.then((f) => new Notice(`Campaign Map: generated ${f.length} ${band} feature${f.length === 1 ? "" : "s"}`));
    });

    btn("stamp", "Canonize nearest generated feature", () => {
      void this.canonizeGeneratedNear().then((ok) =>
        new Notice(ok ? "Campaign Map: canonized nearest feature" : "Campaign Map: nothing generated nearby to canonize")
      );
    });

    btn("search", "Search locations", () => this.openSearch());
    btn("palette", "Switch map theme", () => this.switchTheme());
    btn("image", "Export map poster", () => void this.exportPoster());
    btn("book-open", "Export campaign atlas (PDF)", () => void this.exportAtlas());
    btn("settings", "Campaign settings", () => this.plugin.openControlPanel());
  }

  async onClose(): Promise<void> {
    if (this.dispatchTimer !== null) window.clearTimeout(this.dispatchTimer);
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
        style: this.buildStyle(campaign),
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
   * `importOps.importNotes` (same write paths as quick-add/canonize). */
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
        style: this.buildStyle(campaign),
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
    new QuickAddModal(this.app, culture, this.campaign.config.seed, ({ name, type }) => {
      void this.plugin.createLocation(this.campaign!.id, point, name, type);
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
    this.loadingIndicatorEl.style.display = this.pendingTiles.size > 0 ? "" : "none";
  }

  /** Test/perf-gate surface: how many viewport-window tile entries are
   * currently held (bounded by eviction, not by how far the GM has panned). */
  get loadedTileCount(): number {
    return this.loadedTiles.size;
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

  /** Debounced entry point for the viewport dispatcher — coalesces the
   * flurry of moveend/zoomend/setCampaign calls a single pan or campaign
   * switch can produce into one dispatch pass. */
  private scheduleDispatch(): void {
    if (this.dispatchTimer !== null) window.clearTimeout(this.dispatchTimer);
    this.dispatchTimer = window.setTimeout(() => {
      this.dispatchTimer = null;
      void this.dispatchViewportTiles();
    }, 200);
  }

  /**
   * Phase 4 core: for the current viewport + zoom, generate whichever tier
   * (world or city, per `bandForZoom`) is active, fetch any tile touching
   * viewport+margin that isn't already loaded or in flight, and evict
   * tiles that fell outside that window.
   *
   * Eviction is scoped to the *current* band's own tile-key prefix, not
   * the whole store: a manual `generate-city-here`/`generate-world-here`
   * call (docs/03 3b/3c) can legitimately add a tile from the *other* tier
   * at a zoom the automatic dispatcher would never have picked — e.g. the
   * GM forces city fabric while still zoomed out at world scale. If a
   * same-band-only sweep also nuked cross-band keys, the very next
   * automatic dispatch pass (200ms later, on the same unchanged zoom)
   * would erase what the GM just asked for. A genuine zoom-band
   * *transition* still needs to clear the outgoing tier wholesale (that's
   * the "world tiles disappear when you zoom into city fabric" contract),
   * so that's handled separately, keyed on the band actually changing —
   * not on "some key isn't in this pass's wanted set."
   */
  private async dispatchViewportTiles(): Promise<void> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return;
    const band = bandForZoom(this.map.getZoom());
    const generatorIds = generatorIdsForBand(band);
    const scale = this.campaign.config.scaleMetersPerUnit;

    let evicted = false;
    if (this.lastDispatchedBand !== null && this.lastDispatchedBand !== band) {
      evicted = this.loadedTiles.size > 0;
      this.loadedTiles.clear();
    }
    this.lastDispatchedBand = band;

    const bounds = this.map.getBounds();
    const viewportUnits: BBox = {
      minX: bounds.getWest(),
      minY: bounds.getSouth(),
      maxX: bounds.getEast(),
      maxY: bounds.getNorth(),
    };
    const viewportMeters = bboxUnitsToMeters(viewportUnits, scale);
    // Capped, not proportional to viewport size: at low (world-tier) zoom the
    // viewport can span dozens of 600m tiles, and an uncapped margin turned a
    // single moveend into 16+ concurrent tile fetches (48+ simultaneous
    // generator calls) — a real perf/concurrency problem, not just a test
    // flakiness one, since it's the same "bound the work per dispatch" issue
    // advisor flagged for the tile *store*, just showing up in the fetch
    // burst instead of the eviction side.
    const margin = Math.min(
      Math.max(viewportMeters.maxX - viewportMeters.minX, viewportMeters.maxY - viewportMeters.minY) * 0.5,
      GENERATION_TILE_SIZE * 2
    );
    const padded: BBox = {
      minX: viewportMeters.minX - margin,
      minY: viewportMeters.minY - margin,
      maxX: viewportMeters.maxX + margin,
      maxY: viewportMeters.maxY + margin,
    };
    const { tileX: minTX, tileY: minTY } = tileXYForPoint(padded.minX, padded.minY);
    const { tileX: maxTX, tileY: maxTY } = tileXYForPoint(padded.maxX, padded.maxY);

    const wanted = new Set<string>();
    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let ty = minTY; ty <= maxTY; ty++) {
        wanted.add(this.tileKeyFor(band, tx, ty));
      }
    }
    this.wantedTiles = wanted;

    const bandPrefix = `${band}:`;
    for (const key of this.loadedTiles.keys()) {
      if (key.startsWith(bandPrefix) && !wanted.has(key)) {
        this.loadedTiles.delete(key);
        evicted = true;
      }
    }
    if (evicted) this.refreshGeneratedSource();

    const ctx = this.generationContext();
    const worker = await this.plugin.getGenerationWorker();
    for (const key of wanted) {
      if (this.loadedTiles.has(key) || this.pendingTiles.has(key)) continue;
      const [, txStr, tyStr] = key.split(":");
      this.pendingTiles.add(key);
      this.updateLoadingIndicator();
      void this.loadTile(ctx, worker, key, Number(txStr), Number(tyStr), generatorIds).finally(() => {
        this.pendingTiles.delete(key);
        this.updateLoadingIndicator();
      });
    }
  }

  private async loadTile(
    ctx: GenerationContext,
    worker: GenerationWorkerClient | null,
    key: string,
    tileX: number,
    tileY: number,
    generatorIds: readonly string[]
  ): Promise<void> {
    const results = await Promise.all(
      generatorIds.map((id) => {
        const compute: TileGenerator = worker
          ? (seed, bbox, constraints) => worker.generate(id as GeneratorId, seed, bbox, constraints)
          : this.directGenerators[id];
        return generateTile(ctx, tileX, tileY, id, compute);
      })
    );
    // Panned away while this was in flight — the tile's no longer wanted;
    // storing it now would resurrect something dispatchViewportTiles already evicted.
    if (!this.wantedTiles.has(key)) return;
    const features = results.flat().filter((f) => featureTouchesBBox(f, ctx.worldBounds));
    this.loadedTiles.set(key, features);
    this.refreshGeneratedSource();
  }

  /** "Generate city fabric here" (docs/03 3b/3d) — streets/districts/blocks
   * for the tile at `point` (display-space; defaults to the map center).
   * Manual trigger sharing the same tile store as the viewport dispatcher —
   * a manually-forced tile is subject to the same eviction on the next
   * dispatch pass, which is correct: revisiting re-fetches from `.mapcache/`
   * identically (determinism), it's just not pinned in memory forever.
   * Procedural generation targets fictional worlds — real-city campaigns
   * already have their fabric from the Protomaps basemap (Phase 2). */
  async generateCityHere(point?: [number, number], force = false): Promise<GeoJSON.Feature[]> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return [];
    const scale = this.campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.mapCenterUnits();
    const centerMeters: [number, number] = [unitsToMeters(centerUnits[0], scale), unitsToMeters(centerUnits[1], scale)];
    const ctx = this.generationContext();
    const { tileX, tileY } = tileXYForPoint(centerMeters[0], centerMeters[1]);
    const run = force ? regenerateTile : generateTile;
    const [streets, districts, blocks] = await Promise.all([
      run(ctx, tileX, tileY, "city-street", generateCityStreets),
      run(ctx, tileX, tileY, "city-district", generateDistricts),
      run(ctx, tileX, tileY, "city-block", generateCityBlocks),
    ]);
    const newFeatures = [...streets, ...districts, ...blocks].filter((f) => featureTouchesBBox(f, ctx.worldBounds));
    this.loadedTiles.set(this.tileKeyFor("city", tileX, tileY), newFeatures);
    this.refreshGeneratedSource();
    return newFeatures.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /** "Generate world fabric here" (docs/03 3c) — regions/settlements/routes. */
  async generateWorldHere(point?: [number, number], force = false): Promise<GeoJSON.Feature[]> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return [];
    const scale = this.campaign.config.scaleMetersPerUnit;
    const centerUnits = point ?? this.mapCenterUnits();
    const centerMeters: [number, number] = [unitsToMeters(centerUnits[0], scale), unitsToMeters(centerUnits[1], scale)];
    const ctx = this.generationContext();
    const { tileX, tileY } = tileXYForPoint(centerMeters[0], centerMeters[1]);
    const run = force ? regenerateTile : generateTile;
    const [regions, settlements, routes] = await Promise.all([
      run(ctx, tileX, tileY, "world-region", generateWorldRegions),
      run(ctx, tileX, tileY, "world-settlement", generateSettlements),
      run(ctx, tileX, tileY, "world-route", generateRoutes),
    ]);
    const newFeatures = [...regions, ...settlements, ...routes].filter((f) => featureTouchesBBox(f, ctx.worldBounds));
    this.loadedTiles.set(this.tileKeyFor("world", tileX, tileY), newFeatures);
    this.refreshGeneratedSource();
    return newFeatures.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  /** Canonize whichever generated Point feature is nearest `point`
   * (display-space; defaults to the map center) — docs/02 §5: "canonize =
   * create the note, remove from cache." Uses the name/type the generator
   * already assigned; no modal, consistent with the ≤5s add-location bar. */
  async canonizeGeneratedNear(point?: [number, number], maxDistanceMeters = 40): Promise<boolean> {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return false;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const atUnits = point ?? this.mapCenterUnits();
    const atMeters: [number, number] = [unitsToMeters(atUnits[0], scale), unitsToMeters(atUnits[1], scale)];

    let best: GeoJSON.Feature | null = null;
    let bestDist = Infinity;
    let bestTileKey: string | null = null;
    for (const [key, features] of this.loadedTiles) {
      for (const f of features) {
        if (f.geometry.type !== "Point") continue;
        const [fx, fy] = f.geometry.coordinates as [number, number];
        const d = Math.hypot(fx - atMeters[0], fy - atMeters[1]);
        if (d < bestDist) {
          bestDist = d;
          best = f;
          bestTileKey = key;
        }
      }
    }
    if (!best || !bestTileKey || bestDist > maxDistanceMeters) return false;

    const props = (best.properties ?? {}) as Record<string, unknown>;
    const name = String(props.name ?? "Unnamed");
    const type = String(props.type ?? "custom");
    const noteFeature = transformFeatureUnits(best, (n) => metersToUnits(n, scale));
    await canonizeFeature(this.generationContext(), this.plugin, best, name, type, noteFeature);
    // The dispatcher's debounced eviction can fire during the vault I/O
    // canonizeFeature() just awaited — the tile may already be gone (panned
    // out of view mid-canonize). That's fine: canonizeFeature() already
    // stripped the feature from the on-disk cache either way, so there's
    // nothing left to reconcile in memory.
    const stillLoaded = this.loadedTiles.get(bestTileKey);
    if (stillLoaded) {
      this.loadedTiles.set(bestTileKey, stillLoaded.filter((f) => f.id !== best!.id));
      this.refreshGeneratedSource();
    }
    return true;
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

  private refreshSource(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("canon") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const fc = this.plugin.getCampaignState(this.campaign.id).index.toFeatureCollection();
    source.setData(fc);
    this.updateWarningBadge();
    this.refreshConnections();
    this.refreshSessionPath();
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
    this.map.once("styledata", () => this.refreshSource());
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
    const canon = this.pickFeatureNear(e.point, ["canon-point", "canon-label"]);
    if (canon) {
      this.showPlaceCard(canon);
      return;
    }
    const generated = this.pickFeatureNear(e.point, ["generated-point", "generated-label"]);
    if (generated) {
      this.showGeneratedCard(generated, e.lngLat);
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

  private showGeneratedCard(feature: MapGeoJSONFeature, lngLat: maplibregl.LngLat): void {
    if (!this.map || !this.campaign || feature.geometry.type !== "Point") return;
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();

    const name = String(feature.properties?.name ?? "Unnamed");
    const type = String(feature.properties?.type ?? "settlement");

    const el = document.createElement("div");
    el.addClass("campaign-map-place-card");
    el.createEl("h4", { text: name });
    el.createDiv({ cls: "campaign-map-place-card-preview", text: `Generated ${type} — not yet canon.` });

    const actions = el.createDiv({ cls: "campaign-map-place-card-actions" });
    const at = feature.geometry.coordinates as [number, number];
    actions.createEl("button", { text: "Add to canon" }).onclick = () => {
      void this.canonizeGeneratedNear(at).then((ok) => {
        this.placeCardPopup?.remove();
        new Notice(ok ? `Campaign Map: "${name}" is now canon` : "Campaign Map: could not canonize");
      });
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

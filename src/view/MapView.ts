import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, Modal, Notice, TFile, TAbstractFile, setIcon, FuzzySuggestModal, App } from "obsidian";
import maplibregl, { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification, type MapSourceDataEvent } from "maplibre-gl";
import type { CampaignConfig, ParsedCampaign } from "../model/campaignConfig";

/** The persisted reference-underlay block (plan 041) — the non-optional shape of
 * the campaign config's `underlay` field, used by the apply/test/toggle entries. */
type UnderlayConfig = NonNullable<CampaignConfig["underlay"]>;
import { LOCATION_TYPES, VISIBILITY_VALUES, type ParsedLocation, type Visibility } from "../model/locationNote";
import { buildConnectionFeatures } from "../model/connections";
import { parseSessionPath, sessionPathFeature } from "../model/sessionPath";
import { appendLogEntry, campaignFolderFromConfigPath, type LogEntry } from "../model/mutationLog";
import {
  MapController,
  type ControllerGenContext,
} from "../controller/MapController";
import { boundsToBBox, transformFeatureUnits, metersToUnits } from "../controller/units";
import {
  FABRIC_KINDS,
  isPolygonKind,
  isProcgenRegion,
  makeFabricId,
  type FabricFeature,
  type FabricGeometry,
  type FabricKind,
} from "../model/fabric";
import { loadFabric, saveFabric, fabricPath } from "../vault/fabricStore";
import { loadGeneratedManifest, saveGeneratedManifest } from "../vault/generatedManifestStore";
import { readCachedTiles, removeCachedTiles } from "../model/tileCache";
import { FABRIC_LAYER_IDS } from "../map/themes/fabricLayers";
import { polygonNetArea } from "../gen/metricsGeom";
import { resolveFabricClick, orderFabricCandidates, type FabricCandidate, type FabricCycleState } from "./fabricSelect";
import { resolveMapClickAction, resolveContextMenuSections } from "./mapClickAction";
import {
  decorateCanonWaterAvoidance,
  waterPolylinesFromFabric,
  WATER_AVOIDANCE_METERS,
} from "../map/themes/labelPlacement";
import { REGION_LABEL_LAYER_ID, REGION_LABEL_SOURCE_ID, regionLabelOpacityRamp, regionLabelSourceData } from "../map/themes/regionLabels";
import { SketchController } from "./SketchController";
import { computeScaleBar, defaultFictionalBounds } from "../map/fictionalCRS";
import { smoothPolyline } from "../map/fabricSmooth";
import { obsidianNativeStyle, readObsidianCssTokens } from "../map/theme";
import { glyphsUrlTemplate, createTransformRequest } from "../map/glyphs";
import { registerVaultBasemap, vaultBasemapBounds } from "../map/pmtilesVaultProtocol";
import {
  registerDemProvider,
  unregisterDemProvider,
  campaignDemUrlTemplate,
  resolveDemTileForTest,
} from "../map/campaignDemProtocol";
import { demVerticalScale } from "../gen/fields";
import { buildThemeStyle, isHandcraftedTheme, HANDCRAFTED_THEMES } from "../map/themes";
import { registerTreeGlyphs, installTreeGlyphProvider } from "../map/treeGlyphs";
import { registerParkGlyphs, installParkGlyphProvider } from "../map/parkGlyphs";
import { registerRiverGlyphs, installRiverGlyphProvider } from "../map/riverGlyphs";
import { genreForCampaign } from "../gen/naming/cultures";
import { cultureAt } from "../gen/naming/regions";
import type { BBox } from "../gen/spatialHash";
import { generateRegionTile, generateTile, type GenerationContext } from "../map/generation/generationService";
import { TerrainContourManager } from "../map/generation/terrainContourManager";
import { TERRAIN_CONTOUR_SOURCE_ID } from "../map/themes/terrainContourLayer";
import { UNDERLAY_LAYER_ID, type UnderlayDescriptor } from "../map/themes/underlayLayer";
import { algorithmForKind, algorithmSupportsCenter, matchingPresetId, presetById, type ProcgenAlgorithm } from "../gen/procgen/registry";
import { RegionProcgenModal } from "./RegionProcgenModal";
import { presentedParamSpecs, presentedParams, presentedParamPatch, renderParamControls } from "./paramControls";
import { landformReplaceAdvisoryMessage, warnLandformReplaceOverlap } from "./terrainAdvisory";
import { invertedSeaBounds, invertedSeaLandHoles, invertedSeaDonutRings } from "../map/invertedSea";
import {
  heightHandleDescriptor,
  heightParamsFromValue,
  formatHeightReadout,
  riverDepthValues,
  depthParamsFromValues,
  formatDepthReadout,
  DEPTH_HANDLE_MIN,
  DEPTH_HANDLE_MAX,
} from "./heightHandle";
import { bandValuesFromParams, formatBandReadout } from "./bandGhost";
import { normalizeTerrainBlock, type TerrainBlock } from "./terrainSettings";
import { TerrainRefresh } from "./terrainRefresh";
import { TerrainToggle } from "./terrainToggle";
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

/** What each sketch kind DOES, as its toolbar tooltip (Jonah 2026-07-16:
 * "if I'm editing something, I don't necessarily know what each option does").
 * Draw gesture first, consequence second. */
const KIND_TOOLTIPS: Record<string, string> = {
  road: "Draw a road line \u2014 a plain drawn stroke (no generation)",
  wall: "Draw a wall line \u2014 can generate masonry, towers, gates and a moat along it",
  river: "Draw a river line from source to mouth \u2014 generates the channel and carves its gorge into the terrain",
  water: "Draw a water polygon (lake, bay) \u2014 a plain drawn shape (no generation)",
  district: "Draw a district polygon \u2014 offers city generation (streets, blocks, buildings) inside it",
  park: "Draw a park polygon \u2014 generates paths, lawns, beds and ponds inside it",
  forest: "Draw a forest polygon \u2014 generates canopy and trees inside it",
  farmland: "Draw a farmland polygon \u2014 generates fields, lanes, hedges and farmsteads inside it",
  mountain: "Draw a mountain polygon \u2014 raises a rocky massif in the terrain inside it",
  relief: "Draw a ridge/valley line \u2014 raises or lowers the terrain along it",
  landform: "Draw a plateau/basin/sea polygon \u2014 reshapes the terrain inside it (or outside, for an island coast)",
};

/** Picks a session note (`<campaign>/Sessions/*.md`) whose body's `[[wikilinks]]`
 * become a travel path — same FuzzySuggestModal pattern as
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
  /** Last-shown per-session travel path, if any — kept
   * in memory (not derived from the index like `connections`) so it can be
   * re-applied to the `session-path` source after a theme switch wipes and
   * rebuilds every source (mirrors how `refreshConnections` re-derives
   * `connections` on the same rebuild). */
  private currentSessionPathFeature: GeoJSON.Feature | null = null;
  /** Guards a running replayCampaign() loop so a second invocation, a
   * campaign switch, or the view closing stops it cleanly instead of two
   * loops racing to fly the camera around. */
  private replayToken = 0;
  /** Sketch mode: the durable fabric collection lives on the
   * MapController; MapView reads it via `this.controller.fabric` to paint and
   * hit-test, and `refreshFabric()` re-applies it after any style rebuild. */
  private sketchMode = false;
  private sketchKind: FabricKind = "road";
  private sketchController: SketchController | null = null;
  private sketchBarEl: HTMLDivElement | null = null;
  /** Select-tool panel: name field + procgen section for the
   * currently-selected fabric feature. Anchored under the sketch sub-bar. */
  private selectionPanelEl: HTMLDivElement | null = null;
  /** Floating HUD readout shown while a height handle is being dragged. */
  private heightReadoutEl: HTMLDivElement | null = null;
  private selectedFabricId: string | null = null;
  /** Stacked-select cycle anchor: a repeated select-click at the same spot over
   * the same overlapping fabric stack advances to the next candidate (farmland →
   * plateau beneath). Reset whenever the click lands elsewhere or on empty
   * ground. */
  private fabricCycle: FabricCycleState | null = null;
  /** Which sketch tool is armed: the Select arrow (edit an
   * existing shape) or the draw palette (add a new one). */
  private sketchTool: "draw" | "select" = "draw";
  /** Re-syncs the sub-bar tool highlights to `sketchTool`/`sketchKind` — set by
   * buildSketchBar, called when the tool changes programmatically (e.g. the
   * "Edit shape" context-menu path arms Select without a button click). */
  private syncSketchToolButtons: (() => void) | null = null;
  private sketchKeyHandler: ((ev: KeyboardEvent) => void) | null = null;
  /** Toolbar pencil button — kept so sketch mode can show a pressed/active
   * state on it (re-click to exit is only discoverable if the button
   * looks toggled). */
  private pencilBtnEl: HTMLButtonElement | null = null;
  private terrainBtnEl: HTMLButtonElement | null = null;
  /** Debounce for regenerating manifest tiles a sketch edit touches
   * ("sketch a river, streets adapt" is one gesture) — cleared
   * on mode exit / onClose so it can never fire after teardown. The debounce
   * TIMER lives here (MapView owns `window`); the queued work + flush logic
   * live on the controller (armed via the render sink's `armRegenFlush`). */
  private sketchAutoBuildTimer: number | null = null;
  /** Debounce timer for the external-fabric reload (vault-as-source-of-truth):
   * an out-of-process write to `Fabric.geojson` (sync / a script / a hand edit)
   * fires a vault event → this coalesces a burst of sync writes into ONE
   * `controller.reloadFabricFromDisk`. Cleared on onClose so it can never fire
   * after teardown. */
  private fabricReloadTimer: number | null = null;
  /** Debounce timer for the mid-drag region preview (plan 034-D). Cleared on a
   * commit (release) and on teardown so a trailing preview can never repaint
   * over committed bytes. */
  private sketchPreviewTimer: number | null = null;

  /** The host-agnostic lifecycle brain. Owns generation /
   * regen / clear / undo / replay / migration / region-procgen / sketch-commit
   * orchestration and the state those touch (render store, manifest, fabric).
   * MapView is wiring + paint: it builds the controller with Obsidian-backed
   * gateways below and forwards every gate-facing test-API method here. */
  private controller: MapController;

  /** Terrain-refresh chokepoint (terrainRefresh.ts): converges every
   * terrain-affecting fabric mutation (stamp delete / create / edit / re-roll /
   * undo-redo / adopt / base-terrain) onto the SAME DEM + contour refresh a param
   * edit runs, driven off the composed-elevation digest at the render-signal
   * chokepoint. Fixes the stale 3D-mesh lag after a landform delete. */
  private terrainRefresh: TerrainRefresh;

  /** The terrain-toggle lifecycle brain (terrainToggle.ts): owns the enabled
   * state, the digest-gated tile-cache bust (a plain toggle reuses retained
   * tiles), the pitch-adaptive relief mode, and the bounded source-ready mesh
   * retry. MapView is a thin adapter: it maps this port onto the live MapLibre
   * map + controller digest, and forwards `setTerrainEnabled` here. */
  private terrainToggle: TerrainToggle;

  constructor(leaf: WorkspaceLeaf, plugin: CampaignMapPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.terrainToggle = new TerrainToggle({
      hasHillshadeLayer: () => !!this.map?.getLayer("hillshade"),
      setHillshadeVisible: (visible) => {
        if (this.map?.getLayer("hillshade")) {
          this.map.setLayoutProperty("hillshade", "visibility", visible ? "visible" : "none");
        }
      },
      getPitch: () => this.map?.getPitch() ?? 0,
      meshMode: () => {
        const t = this.map?.getTerrain();
        if (!t) return "off";
        return (t.exaggeration ?? 0) > 0 ? "on" : "flat";
      },
      setMesh: (mode) => {
        if (!this.map || !this.campaign) return;
        if (mode === "off") {
          this.map.setTerrain(null);
          return;
        }
        // "flat" keeps the terrain object (and its tile/render caches) RESIDENT
        // at exaggeration 0 — a pitch crossing is a ~2 ms uniform flip instead
        // of a teardown + full refetch/decode/mesh rebuild (toggle bug 3).
        this.map.setTerrain({
          source: `dem-${this.campaign.id}`,
          exaggeration: mode === "on" ? MapView.TERRAIN_EXAGGERATION : 0,
        });
      },
      bustDemTiles: () => {
        if (this.campaign) this.bustDemTileCache(`dem-${this.campaign.id}`);
      },
      registerProvider: () => {
        if (this.campaign) this.registerDemProviderFor(this.campaign);
      },
      readDigest: () => this.controller.campaignElevationDigest(),
      addPitchHandler: (fn) => this.map?.on("pitch", fn),
      removePitchHandler: (fn) => this.map?.off("pitch", fn),
      onceSourceReady: (fn) => {
        const map = this.map;
        const sourceId = this.campaign ? `dem-${this.campaign.id}` : null;
        if (!map || !sourceId) return () => {};
        const handler = (e: MapSourceDataEvent): void => {
          if (e.sourceId !== sourceId || !e.isSourceLoaded) return;
          map.off("sourcedata", handler);
          fn();
        };
        map.on("sourcedata", handler);
        return () => map.off("sourcedata", handler);
      },
    });
    this.terrainRefresh = new TerrainRefresh({
      readDigest: () => this.controller.campaignElevationDigest(),
      terrainEnabled: () => this.terrainToggle.isEnabled(),
      registerProvider: () => {
        if (this.campaign) this.registerDemProviderFor(this.campaign);
      },
      bustTileCache: () => {
        if (this.campaign) this.bustDemTileCache(`dem-${this.campaign.id}`);
        // Keep the toggle's retained-tile digest in lockstep with this on-terrain
        // bust so a later plain toggle doesn't re-bust the tiles this just
        // refreshed.
        this.terrainToggle.markDemTilesFresh();
      },
      refreshContours: () => this.refreshTerrainContours(),
    });
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
      confirm: {
        confirm: (message) => this.confirmDialog(message),
      },
      render: {
        repaintGenerated: (stage?: number, regionId?: string) => {
          this.refreshGeneratedSource(stage, regionId);
          // Terrain-refresh chokepoint: a generated repaint that moved the
          // elevation field (a terrain stamp created / re-rolled / adopted) busts
          // the DEM + refreshes contours; a pure city repaint is a cheap no-op.
          this.terrainRefresh.refreshIfElevationChanged();
        },
        repaintFabric: () => {
          this.refreshFabric();
          // Same chokepoint on the fabric side — this is the path a landform
          // DELETE / undo / procgen-clear reaches (the bug: 3D lagged here).
          this.terrainRefresh.refreshIfElevationChanged();
        },
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
        armFabricReload: () => this.armFabricReload(),
      },
      viewport: {
        zoom: () => this.map?.getZoom() ?? 0,
        centerUnits: () => this.mapCenterUnits(),
      },
    });
  }

  /** Add the Obsidian `app` back onto a controller gen-context before handing
   * it to the App-based generation service (keeps `App` out of the
   * controller). */
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
    // A base-terrain edit (036-D campAmp/seaDatum/grade) moves the composed
    // elevation field ⇒ the DEM digest changes ⇒ tiles must re-derive. setStyle
    // is skipped for a terrain-only change, so refresh the DEM explicitly below.
    const terrainBaseChanged =
      JSON.stringify(this.campaign?.config.terrain ?? null) !== JSON.stringify(campaign.config.terrain ?? null);
    // A reference-underlay change (plan 041: attach / move corners / change image /
    // opacity / visibility) is spliced into the style at build time, so it rides
    // the same setStyle rebuild as a theme/basemap change — a rare, explicit GM
    // action, and reusing the asserted style order keeps the z-stack correct.
    const underlayChanged =
      JSON.stringify(this.campaign?.config.underlay ?? null) !== JSON.stringify(campaign.config.underlay ?? null);
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
    // Baseline the terrain-refresh digest to this campaign so the render
    // chokepoint never compares against the previous campaign's field (loadFabric
    // then repaints, and the first real terrain mutation is what triggers).
    this.terrainRefresh.seedBaseline();
    void this.controller.loadFabric();
    this.refreshHeaderTitle();
    // The terrain toggle is crs-dependent (fictional only) and the toolbar may
    // have been built before the campaign arrived — rebuild it now. Guarded:
    // setCampaign can run before onOpen has created the toolbar element.
    if (this.toolbarEl) this.buildToolbar();
    if (this.map && (isFirstApply || themeChanged || underlayChanged)) {
      if (switched) this.terrainToggle.reset(); // terrain is per-session, never carried across campaigns
      if (switched) this.terrainContourManager?.reset(); // drop the prior campaign's contour engine
      this.map.setStyle(this.buildStyle(campaign));
      this.map.once("styledata", () => {
        registerTreeGlyphs(this.map!);
        registerParkGlyphs(this.map!);
        registerRiverGlyphs(this.map!);
        this.refreshSource();
        this.refreshGeneratedSource();
        this.applyFocusReveal();
        // setStyle rebuilds the hillshade layer default-hidden and drops the 3D
        // terrain mesh — re-apply the GM's toggle across a theme change. setStyle
        // also recreates the (empty) terrain-contour source → repopulate it.
        if (this.terrainToggle.isEnabled()) this.setTerrainEnabled(true);
        this.refreshTerrainContours();
      });
      this.updateTerrainButton();
    }
    if (this.map) this.applyCampaign();
    // Terrain-only edit (no setStyle rebuild): re-derive the DEM against the new
    // base params if relief is currently showing.
    if (terrainBaseChanged && !isFirstApply && !themeChanged) this.refreshTerrainIfEnabled();
    // The ONLY generation on open is replaying the GM's own past requests
    // (cache hit or deterministic regenerate) — pan/zoom never dispatches
    // generators.
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

  /**
   * Persist the base-terrain block (036-D campAmp/seaDatum/grade) to campaign
   * frontmatter behind the settings modal's explicit Apply. `undefined` ⇒ the
   * block is all-default, so the key is deleted (frontmatter stays minimal). The
   * config rescan pushes the new terrain into setCampaign, which re-derives the
   * DEM (the digest changes ⇒ tiles re-fetch). Applying is deliberately explicit
   * (never a live slider): a base-param change re-derives every DEM tile. Shows a
   * one-line cost Notice. `applyTerrainSettingsForTest` is the modal-free twin.
   */
  async applyTerrainSettings(block: TerrainBlock | undefined): Promise<void> {
    if (!this.campaign) return;
    const file = this.app.vault.getAbstractFileByPath(this.campaign.path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (block) fm.terrain = { campAmp: block.campAmp, seaDatum: block.seaDatum, grade: block.grade };
      else delete fm.terrain;
    });
    new Notice("Campaign Map: base terrain applied — the elevation surface re-derives (DEM tiles refresh).");
  }

  /** Headless twin of the settings Apply (the modal would hang CLI): normalize
   * the raw inputs and persist, no Notice/DOM. Returns the persisted block (or
   * undefined when it collapsed to all-defaults). */
  async applyTerrainSettingsForTest(input: {
    campAmp?: number;
    seaDatum?: number;
    grade?: boolean;
  }): Promise<TerrainBlock | undefined> {
    const block = normalizeTerrainBlock(input);
    await this.applyTerrainSettings(block);
    return block;
  }

  // ─── Reference-image underlay (plan 041 "trace mode") ───────────────────────
  /**
   * Resolve the campaign's underlay config to a style descriptor: a directly-
   * loadable URL (via the DataAdapter's `getResourcePath` — NEVER Node fs, the
   * same mechanism the font glyphs use) plus the two display-unit anchor corners.
   * Returns `undefined` when no underlay is attached (⇒ the style carries no
   * underlay source/layer at all, the pre-041 behavior). A NON-visible underlay is
   * still resolved (layer present, `visibility: none`) so the toggle command is a
   * cheap `setLayoutProperty` with no restyle.
   */
  private resolveUnderlay(campaign: ParsedCampaign): UnderlayDescriptor | undefined {
    const u = campaign.config.underlay;
    if (!u) return undefined;
    return {
      url: this.app.vault.adapter.getResourcePath(u.image),
      sw: u.sw,
      ne: u.ne,
      opacity: u.opacity,
      visible: u.visible,
    };
  }

  /**
   * Persist a reference-underlay block (plan 041) to campaign frontmatter behind
   * the settings modal's Apply. `undefined` ⇒ detach (delete the key). The config
   * rescan pushes it into `setCampaign`, whose `underlayChanged` triggers the
   * style rebuild that splices the source/layer in at the asserted z-order.
   * `setUnderlayForTest` is the modal-free twin (a modal hangs the CLI).
   */
  async applyUnderlay(block: UnderlayConfig | undefined): Promise<void> {
    if (!this.campaign) return;
    const file = this.app.vault.getAbstractFileByPath(this.campaign.path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (block) fm.underlay = { ...block };
      else delete fm.underlay;
    });
    new Notice(
      block
        ? "Campaign Map: reference underlay applied."
        : "Campaign Map: reference underlay removed."
    );
  }

  /** Headless twin of the settings Apply — persist the block (or detach on
   * `undefined`), no Notice/DOM. Returns what was persisted. */
  async setUnderlayForTest(block: UnderlayConfig | undefined): Promise<UnderlayConfig | undefined> {
    if (!this.campaign) return undefined;
    const file = this.app.vault.getAbstractFileByPath(this.campaign.path);
    if (!(file instanceof TFile)) return undefined;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (block) fm.underlay = { ...block };
      else delete fm.underlay;
    });
    return block;
  }

  /** LIVE opacity feedback for the settings slider — display-only, no persist, no
   * regen (ratified fine per plan 041). Persisting on Apply triggers the restyle
   * that bakes the final value in. No-op until the layer exists. */
  setUnderlayOpacityLive(opacity: number): void {
    if (!this.map?.getLayer(UNDERLAY_LAYER_ID)) return;
    this.map.setPaintProperty(UNDERLAY_LAYER_ID, "raster-opacity", Math.max(0, Math.min(1, opacity)));
  }

  /** Flip the attached underlay's visibility (command + headless entry). Live
   * `setLayoutProperty` for instant feedback, then persist (the async frontmatter
   * write reconverges via `setCampaign`). Notices when nothing is attached. */
  async toggleUnderlay(): Promise<void> {
    const u = this.campaign?.config.underlay;
    if (!u) {
      new Notice("Campaign Map: no reference underlay attached (add one in campaign settings).");
      return;
    }
    const next = !u.visible;
    if (this.map?.getLayer(UNDERLAY_LAYER_ID)) {
      this.map.setLayoutProperty(UNDERLAY_LAYER_ID, "visibility", next ? "visible" : "none");
    }
    await this.applyUnderlay({ ...u, visible: next });
  }

  // ─── Terrain: hillshade relief + 3D ────────────────────────────────────────
  /** 3D-mesh vertical exaggeration. The encoded DEM already scales heights by K
   * (terrarium-capped, `demVerticalScale`); the 3D mesh raises vertices in
   * mercator-meters, so a fictional mountain (tiny in campaign meters, huge on
   * the mercator canvas) needs a multiplier on top to read as relief when
   * pitched. Tunable (default-off); verified by screenshot. Dialled 6 → 3
   * (shortlist 1, Jonah 2026-07-15): at 6 a massif rose as a vertical-walled
   * mesa off flat ground; halving the vertical scale lets peaks read as relief
   * without the sheer-cliff artifact (the foothill-apron falloff is the
   * generator-side other half of the same fix). */
  private static readonly TERRAIN_EXAGGERATION = 3;

  isTerrainEnabled(): boolean {
    return this.terrainToggle.isEnabled();
  }

  /** The single terrain toggle (button + headless twin). The lifecycle lives on
   * `this.terrainToggle` (terrainToggle.ts): ON is PITCH-ADAPTIVE — top-down →
   * the hillshade layer (2D shaded relief); pitched → the 3D terrain mesh with
   * hillshade hidden. The two never render together: maplibre-gl 4.7.1 misrenders
   * the hillshade layer while a terrain mesh is active (the draped hillshade
   * texture smears/stretches past the relief), so each mode uses the one that
   * renders correctly, and the draped hachures/contours carry the relief read in
   * 3D. VISIBILITY + mesh only — never generation (explicit-only survives: DEM
   * tiles are field evaluation, generatorRunCount stays flat). Fictional
   * campaigns only (the DEM source exists only there). A plain toggle no longer
   * refetches tiles: the toggle busts only when the elevation field moved while
   * terrain was off (see terrainToggle). */
  setTerrainEnabled(on: boolean): boolean {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return false;
    const ok = this.terrainToggle.setEnabled(on);
    if (ok) this.updateTerrainButton();
    return ok;
  }

  /** Force MapLibre to refetch DEM tiles (their URL is stable, so a mountain
   * edit wouldn't otherwise invalidate already-cached raster tiles). */
  private bustDemTileCache(sourceId: string): void {
    const src = this.map?.getSource(sourceId) as { setTiles?: (t: string[]) => void } | undefined;
    if (src?.setTiles) {
      try {
        src.setTiles([campaignDemUrlTemplate(this.campaign!.id)]);
      } catch {
        /* best-effort cache bust */
      }
    }
    // An ACTIVE 3D mesh holds its own terrain tile/render cache that a source
    // `setTiles` reload does NOT invalidate — measured 2026-07-16 (Jonah:
    // "after generate relief I have to toggle show-3d off/on to see it"): the
    // source recomputed its stale tiles but the mesh kept rendering the old
    // surface until a toggle re-applied `setTerrain`. Re-apply it here so a
    // terrain edit made while pitched shows immediately. Cheap relative to the
    // bust itself: unchanged tiles re-serve from the PNG memo; only the mesh
    // rebuild is new work, and that rebuild IS the point.
    const terrain = this.map?.getTerrain();
    if (terrain) {
      try {
        this.map!.setTerrain(null);
        this.map!.setTerrain(terrain);
      } catch {
        /* best-effort — the pitch handler re-converges relief mode */
      }
    }
  }

  /** Re-point + refresh the DEM (only if terrain is on) AND the global contour
   * surface (ALWAYS — contour lines render regardless of the hillshade/3D toggle)
   * after a terrain region changed. The contour manager keys its engine on the
   * field digest, so the edit is picked up on this refresh. Delegates to the
   * terrain-refresh chokepoint's `refreshNow` (always refresh + re-baseline) for
   * the explicit-edit paths whose repaint doesn't flow through the render
   * chokepoint (base-terrain apply / campaign re-open); digest-changing region
   * mutations converge automatically via the render callbacks. */
  private refreshTerrainIfEnabled(): void {
    this.terrainRefresh.refreshNow();
  }

  private updateTerrainButton(): void {
    this.terrainBtnEl?.toggleClass("is-active", this.terrainToggle.isEnabled());
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
    // DEM/hillshade/terrain is fictional-campaign-only (real-city elevation
    // isn't supported yet). The hillshade layer + raster-dem source are always
    // PRESENT in a fictional style but default hidden (layout visibility
    // "none"); the terrain toggle flips them on.
    let dem: { sourceId: string; url: string } | undefined;
    if (config.crs === "fictional") {
      dem = { sourceId: `dem-${campaign.id}`, url: campaignDemUrlTemplate(campaign.id) };
      this.registerDemProviderFor(campaign);
    }
    // Reference-image underlay (plan 041): resolved to a directly-loadable URL +
    // display-unit corners before the pure style builder runs.
    const underlay = this.resolveUnderlay(campaign);
    if (isHandcraftedTheme(config.theme)) {
      return buildThemeStyle(HANDCRAFTED_THEMES[config.theme], glyphsUrlTemplate(), basemap, dem, underlay);
    }
    return obsidianNativeStyle(readObsidianCssTokens(this.containerEl), glyphsUrlTemplate(), basemap, dem, underlay);
  }

  /** Point the `campaigndem` protocol at this campaign's live elevation field.
   * The provider re-reads the composed field + digest on every
   * tile request, so a mountain edit is reflected once the source is refreshed
   * (refreshTerrain). Serving is off the region-generation path — it never moves
   * generatorRunCount (DEM tiles are field evaluation, not procgen). */
  private registerDemProviderFor(campaign: ParsedCampaign): void {
    registerDemProvider(campaign.id, {
      app: this.app,
      campaignFolder: campaignFolderFromConfigPath(campaign.path),
      scaleMetersPerUnit: campaign.config.scaleMetersPerUnit,
      k: demVerticalScale(campaign.config.scaleMetersPerUnit),
      snapshot: () =>
        this.controller.campaignElevationSnapshot() ?? {
          field: () => ({ v: 0, dx: 0, dy: 0 }),
          digest: "empty",
          inputs: {
            features: [],
            base: { campAmp: 0, seaDatum: 0 },
            campaignSeed: 0,
            include: { relief: true, landform: true, carve: true, grade: false },
          },
        },
      // DEM lattice fill OFF the main thread (Jonah 2026-07-15): the 256² sample
      // stalled the renderer on a cold fill. `null` (no worker) ⇒ the protocol
      // falls back to the main-thread pure function, byte-identical.
      computeLatticeOffThread: async (inputs, z, x, y, res, scaleMU, k) => {
        const worker = await this.plugin.getGenerationWorker();
        if (!worker) return null;
        return worker.computeDemTile(inputs, z, x, y, res, scaleMU, k);
      },
    });
    this.ensureTerrainContourManager(campaign);
  }

  // ─── Global terrain contours ───────────────────────────────────────────────
  private terrainContourManager: TerrainContourManager | null = null;
  private terrainContourCampaignId: string | null = null;

  /** (Re)build the viewport-keyed contour manager for `campaign` — fictional
   * only (the `terrain-contour` source exists only there, same gate as the DEM).
   * Rebuilt on campaign switch (scale is fixed per manager). */
  private ensureTerrainContourManager(campaign: ParsedCampaign): void {
    if (campaign.config.crs !== "fictional") {
      this.terrainContourManager = null;
      this.terrainContourCampaignId = null;
      return;
    }
    if (this.terrainContourManager && this.terrainContourCampaignId === campaign.id) return;
    this.terrainContourManager = new TerrainContourManager({
      sourceId: TERRAIN_CONTOUR_SOURCE_ID,
      scaleMetersPerUnit: campaign.config.scaleMetersPerUnit,
      getMap: () => this.map,
      getSnapshot: () => {
        // A live terrain-draft preview (vertex drag on a stamp) supersedes the
        // durable surface for CONTOURS only — the DEM provider keeps reading
        // the durable snapshot, so no draft bytes ever reach dem.jsonl.
        const pre = this.controller.campaignPreviewElevationSnapshot();
        if (pre) return { digest: pre.digest, inputs: pre.inputs, preview: true };
        const snap = this.controller.campaignElevationSnapshot();
        return snap ? { digest: snap.digest, inputs: snap.inputs } : null;
      },
      getWorker: () => this.plugin.getGenerationWorker(),
    });
    this.terrainContourCampaignId = campaign.id;
  }

  /** Refresh the global contour surface for the current viewport (best-effort —
   * a failed worker round-trip must never break the map). */
  private refreshTerrainContours(): void {
    void this.terrainContourManager?.update().catch(() => {
      /* worker/setData hiccup — the next settle retries */
    });
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
      // DEM-tile RETENTION (Jonah: "areas stop being 3D when i stop looking and
      // take a while to reappear"). MapLibre's default tile cache is sized to the
      // current viewport, so panning away evicts off-screen raster-dem tiles and a
      // revisit re-requests them. A fixed, generous cap keeps a session's worth of
      // already-derived DEM (and vector) tiles resident so revisited areas stay 3D.
      // ~512 decoded 128²/256² DEM tiles is a few tens of MB; tunable down if the
      // Surface Pro budget feels it. The encoded-PNG memo (campaignDemProtocol)
      // backstops any eviction — a re-request is still a pure serve (no recompute,
      // no re-encode).
      maxTileCacheSize: 512,
    });

    // Tree glyph SDF images — `installTreeGlyphProvider` wires a
    // `styleimagemissing` handler that lazily supplies any tree glyph the style
    // asks for. It lives on the map (not the style), so it survives every
    // setStyle (theme switch, css-change) and campaign switch with no per-callsite
    // bookkeeping; `registerTreeGlyphs` below is the proactive companion that
    // registers them up front so there's no first-paint flash.
    installTreeGlyphProvider(this.map);
    installParkGlyphProvider(this.map);
    installRiverGlyphProvider(this.map);

    this.map.on("load", () => {
      // Fallback only, for the one case setCampaign()'s own synchronous
      // applyCampaign() call can't cover: a campaign already set on this
      // view *before* the map existed (this.map was null, so that call
      // no-opped). In the ordinary case setCampaign() has already fit the
      // bounds by the time "load" fires — MapLibre's camera methods take
      // effect immediately, pre-load, they just don't paint until the style
      // is ready — so re-applying here would silently stomp any camera
      // move made in between (e.g. a caller jumping to a specific tile
      // right after opening): a live "load" firing after an explicit jumpTo
      // would reset the camera mid-flight, discarding whatever had already
      // been started for the jumped-to viewport.
      if (this.campaign && !this.campaignAppliedOnce) this.applyCampaign();
      registerTreeGlyphs(this.map!);
      registerParkGlyphs(this.map!);
        registerRiverGlyphs(this.map!);
      this.refreshSource();
      this.refreshGeneratedSource();
      this.applyFocusReveal();
      this.updateScaleBar();
      this.updateFocusReadout();
      this.refreshTerrainContours();
    });
    // Global terrain contours are viewport-keyed (LOD by zoom); recompute the
    // touched tiles once the camera settles (coalesced + off-thread).
    this.map.on("moveend", () => this.refreshTerrainContours());
    // Scale bar depends only on zoom — binding it to `move` wrote the same
    // text/width to the DOM every pan frame (style-recalc churn for nothing);
    // the `zoom` binding below covers every case that actually changes it.
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
    // Vault-as-source-of-truth for sketch fabric (Cradle learning): an EXTERNAL
    // write to the loaded campaign's `Fabric.geojson` (sync / a script / a hand
    // edit) must reach the running map — location notes already reconcile via
    // vault events; sketch fabric now does too. The controller's own persists
    // fire these events as well, but its self-write guard (content compare)
    // no-ops them, and the reload debounces bursts of sync writes into one pass.
    const onFabricEvent = (file: TAbstractFile): void => {
      if (this.campaign && file.path === fabricPath(this.campaign)) {
        this.controller.noteExternalFabricChange();
      }
    };
    this.registerEvent(this.app.vault.on("modify", onFabricEvent));
    this.registerEvent(this.app.vault.on("create", onFabricEvent));
    this.registerEvent(this.app.vault.on("delete", onFabricEvent));
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

    // Toolbar holds only the frequent, in-the-moment builder actions.
    // The occasional/heavy actions — Generate fabric here, Export poster,
    // Export atlas — now live in the settings/control-panel modal under
    // "Generate & export" (still on the command palette too). See
    // generateFabricHere() for the shared "here" logic.
    // The pencil keeps a ref so sketch mode can show an active/pressed state.
    this.pencilBtnEl = btn("pencil", "Sketch fabric (roads, walls, rivers, districts…)", () =>
      this.toggleSketchMode()
    );
    this.pencilBtnEl.toggleClass("is-active", this.sketchMode);
    btn("search", "Search locations", () => this.openSearch());
    btn("palette", "Switch map theme", () => this.switchTheme());
    // Terrain toggle — fictional campaigns only (DEM/hillshade is
    // fictional-only). Next to the theme switcher; flips hillshade
    // relief + 3D terrain on/off (visibility only, never generation).
    this.terrainBtnEl = null;
    if (this.campaign?.config.crs === "fictional") {
      this.terrainBtnEl = btn("mountain", "Toggle terrain relief (hillshade + 3D)", () =>
        this.setTerrainEnabled(!this.terrainToggle.isEnabled())
      );
      this.updateTerrainButton();
    }
    btn("settings", "Campaign settings (generate, export live here)", () => this.plugin.openControlPanel());
  }

  /**
   * "Generate fabric here" — the explicit generation trigger
   * for the WORLD tier, and the re-clip trigger for a procgen region at city
   * zoom. World tier: paints the clicked tile and appends a durable manifest
   * entry (unchanged). City tier: city procgen is polygon-scoped now — a
   * click INSIDE a region re-clips/repaints it (cache path); a click outside
   * any region points the GM at the district tool. Founding a city by
   * clicking is retired: sketch a district instead.
   */
  async generateFabricHere(
    point?: [number, number],
    opts: { force?: boolean; silent?: boolean } = {}
  ): Promise<GeoJSON.Feature[]> {
    if (!this.map) return [];
    return this.controller.generateFabricHere(point, opts);
  }

  /**
   * "Regenerate fabric here": re-runs generation at this
   * spot against CURRENT constraints. A region under the point regenerates
   * whole (drops its network + tile records, recomputes); world-tier entries
   * on the tile regenerate their tile. Nothing here → first-time generate.
   */
  async regenerateFabricHere(point?: [number, number]): Promise<GeoJSON.Feature[]> {
    if (!this.map) return [];
    return this.controller.regenerateFabricHere(point);
  }

  /** "Clear generated fabric here": drops this tile's WORLD
   * manifest entries + cache records + paint. City procgen is removed via
   * "Remove generated city here" (strips the shape's procgen block) instead. */
  async clearGeneratedHere(point?: [number, number]): Promise<number> {
    if (!this.map) return 0;
    return this.controller.clearGeneratedHere(point);
  }

  /** "Clear all generated fabric": removes world manifest
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
    if (this.sketchPreviewTimer !== null) {
      window.clearTimeout(this.sketchPreviewTimer);
      this.sketchPreviewTimer = null;
    }
    if (this.fabricReloadTimer !== null) {
      window.clearTimeout(this.fabricReloadTimer);
      this.fabricReloadTimer = null;
    }
    if (this.sketchKeyHandler) {
      window.removeEventListener("keydown", this.sketchKeyHandler, true);
      this.sketchKeyHandler = null;
    }
    if (this.campaign) unregisterDemProvider(this.campaign.id);
    // Drop the terrain toggle's pitch + source-ready listeners symmetrically
    // (map.remove() would drop them too, but this keeps the toggle's own
    // bookkeeping honest and leak-free across re-opens).
    this.terrainToggle.dispose();
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
   * Per-session travel path: the note's own `[[wikilinks]]` carry the route.
   * Lists `<campaign>/Sessions/*.md`, and on pick, draws a line through the
   * locations that session note links, in the order they appear in the body.
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
   * Campaign replay: flies the camera to every `create` entry in
   * `.mapcache/log.jsonl`, oldest first, pulsing each location as it's visited —
   * a stepped tour of how the map came to be, not a tweened camera path.
   * Interruptible: stops if the view closes (`this.map` goes null) or the
   * campaign changes mid-replay.
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
   * v1 poster export: a high-res PNG
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

  /** Generic GeoJSON importer (covers Azgaar/Watabou exports and
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
   * v1 atlas export: a PDF built from the map plus location notes (the notes
   * ARE the gazetteer). Reuses the same
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

  /** Apply a cross-layer cascade the confirm cap deferred — the non-modal
   * affordance for the "that edit affects N downstream regions" Notice
   * (a command, not a modal — modals hang CLI automation, docs/05). */
  async applyPendingCascade(): Promise<void> {
    return this.controller.applyPendingCascade();
  }

  /** The downstream regions the most recent cascade regenerated (gate
   * observability) — DAG-deterministic, seed-independent. */
  cascadeRegeneratedIds(): string[] {
    return [...this.controller.cascadeRegeneratedIds];
  }

  /** Regions a cost-capped forward pass deferred — their painted bytes are the
   * pre-edit cache until "Apply pending cascade" runs (plan 034 "outdated"
   * badge, the plan-029 needsAdoption pattern). */
  outdatedRegionIds(): string[] {
    return this.controller.outdatedRegionIds();
  }

  /** True while a cost-capped pass holds deferred downstream work. */
  hasPendingCascade(): boolean {
    return this.controller.hasPendingCascade;
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

  /** "Populate this district with N shops" — offline, deterministic (no
   * LLM/API): scatter `count` seeded points across
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

  /** Feature ids currently painted in the `generated` source, grouped by DAG
   * stage (plan 032-D). A staged repaint diffs against this to `updateData` only
   * the changed stage; a full repaint rebuilds it. */
  private paintedStageIds = new Map<number, Set<string | number>>();

  /**
   * Repaints the `generated` source from the controller's render store (already
   * converted to display units). Called from the load/styledata paint paths and
   * the controller's render sink after any generation.
   *
   * With a `stage` (plan 032-D) the repaint is INCREMENTAL: only that DAG
   * stage's features are replaced via `updateData` (remove the stage's old
   * features by id, add its current ones), so the repaint scales with the
   * changed stage instead of re-indexing all generated features. A full repaint
   * (no `stage`, e.g. initial paint / replay) does the authoritative `setData`
   * and re-seeds the per-stage id tracking. Visual judgment of the staged path
   * is deferred to normal app use (plan 032 §2, headless-only verification).
   */
  private refreshGeneratedSource(stage?: number, regionId?: string): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("generated") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    // Staged `updateData` (032-D) is only safe when the source is UPDATEABLE:
    // MapLibre requires every feature to carry a unique, non-null id
    // (`isUpdateableGeoJSON`). A single duplicate / missing id makes the whole
    // source non-updateable, and `updateData` then throws in the worker and
    // silently no-ops — the regenerated bytes never repaint (the moved-vertex
    // bug). Render ids are tile-key-namespaced in the controller to guarantee
    // uniqueness, but this stays defensive: on ANY non-updateable collection
    // (an id-less future generator, a hash collision) fall back to a full
    // `setData`, which always reflects the store, over a silent stale paint.
    const fullPaint = stage === undefined || typeof source.updateData !== "function";
    if (!fullPaint && !this.generatedSourceUpdateable) {
      // Non-updateable source: a staged diff would silently fail. Do the
      // authoritative full paint instead (also re-seeds the updateable flag).
      this.paintGeneratedFull(source);
      return;
    }
    if (fullPaint) {
      this.paintGeneratedFull(source);
      return;
    }
    const oldIds = this.paintedStageIds.get(stage) ?? new Set<string | number>();
    if (regionId !== undefined) {
      // Region-scoped diff (2026-07-16): remove only THIS region's previous
      // features, add its current ones — same-stage siblings never re-ship.
      // Render ids are tile-key-namespaced `region:<id>:x:y#i`, so the region's
      // prior ids are recoverable from the stage tracking by prefix.
      const prefix = `region:${regionId}:`;
      const remove = [...oldIds].filter((id) => String(id).startsWith(prefix));
      const feats = this.controller.displayGeneratedForRegion(stage, regionId);
      source.updateData({ remove, add: feats });
      const next = new Set(oldIds);
      for (const id of remove) next.delete(id);
      for (const f of feats) next.add(f.id as string | number);
      this.paintedStageIds.set(stage, next);
      return;
    }
    const feats = this.controller.displayGeneratedForStage(stage);
    // Remove the stage's previous features, add its current ones — other stages'
    // features in the source are untouched.
    source.updateData({ remove: [...oldIds], add: feats });
    this.paintedStageIds.set(stage, new Set(feats.map((f) => f.id as string | number)));
  }

  /** Whether the `generated` source's last full paint had globally-unique,
   * non-null feature ids (MapLibre's `updateData` precondition). Staged repaints
   * fall back to a full `setData` when this is false. */
  private generatedSourceUpdateable = true;

  /** Authoritative full repaint of the `generated` source: `setData` the whole
   * collection, re-seed per-stage id tracking, and record whether the collection
   * is updateable (drives the staged-vs-full choice on the next repaint). */
  private paintGeneratedFull(source: maplibregl.GeoJSONSource): void {
    const features = this.controller.displayGenerated();
    source.setData({ type: "FeatureCollection", features });
    const seen = new Set<string | number>();
    let updateable = true;
    for (const f of features) {
      const id = f.id;
      if (id === undefined || id === null || seen.has(id)) {
        updateable = false;
        break;
      }
      seen.add(id);
    }
    this.generatedSourceUpdateable = updateable;
    this.paintedStageIds.clear();
    for (const [s, feats] of this.controller.displayGeneratedByStage()) {
      this.paintedStageIds.set(s, new Set(feats.map((f) => f.id as string | number)));
    }
  }

  private updateLoadingIndicator(): void {
    this.loadingIndicatorEl.style.display = this.controller.pendingGenerationCount > 0 ? "" : "none";
  }

  /** Test/perf-gate surface: how many tile entries the render store holds
   * (bounded by what the GM has explicitly generated). */
  get loadedTileCount(): number {
    return this.controller.loadedTileCount;
  }

  /** The render store (generation-space features, keyed by tier/region tile),
   * re-surfaced from the controller for the CLI eval-testing surface: gate
   * scripts iterate `view.loadedTiles.forEach(...)` directly (docs/05). */
  get loadedTiles(): Map<string, GeoJSON.Feature[]> {
    return this.controller.renderStore;
  }

  /** Gate surface: actual generator executions this
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

  // ─── Region procgen lifecycle ─────────────────────────────────────────

  /** "Remove generated city here": strips the procgen block
   * of the region under the point — the shape stays, the city is gone. */
  async removeGeneratedCityHere(point?: [number, number]): Promise<number> {
    if (!this.map) return 0;
    return this.controller.removeGeneratedCityHere(point);
  }

  /** Offer procgen for a just-finished district sketch: the
   * interactive (modal) path stays in MapView — validate the ring, reject
   * overlap, open the modal, and (on confirm) hand off to the controller's
   * headless attach+generate lifecycle. Cancel keeps the shape inert. */
  private maybeOfferProcgen(feature: FabricFeature): void {
    if (!this.map || !this.campaign || this.campaign.config.crs !== "fictional") return;
    const algorithm = algorithmForKind(feature.properties.kind);
    if (!algorithm) return;
    // Kind-aware validation: polygon → ring + overlap; line →
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
        // A freshly-created landform sitting over a mountain/relief add-stamp
        // silently flattens it — warn once on creation.
        const created = this.controller.fabricFeature(feature.id);
        if (created) this.maybeWarnReplaceOverlap(created);
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
    name?: string,
    kind: FabricKind = "district"
  ): Promise<{ featureId: string; count: number; outside: number }> {
    return this.controller.createRegionForTest(ringUnits, algorithmId, params, name, kind);
  }

  /** Headless spine (line-kind) creation — the gate/test twin for rivers.
   * Sketches a `kind` line, attaches a procgen block, generates, and returns
   * the corridor containment summary. */
  async createSpineForTest(
    coordsUnits: [number, number][],
    kind: FabricKind,
    algorithmId: string,
    params: Record<string, unknown>,
    name?: string
  ): Promise<{ featureId: string; count: number; outside: number }> {
    return this.controller.createSpineForTest(coordsUnits, kind, algorithmId, params, name);
  }

  /** A minimal blocking yes/no modal for the version-adoption prompt. */
  private confirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new (class extends Modal {
        private resolved = false;
        onOpen(): void {
          this.titleEl.setText("Campaign Map");
          this.contentEl.createEl("p", { text: message });
          const row = this.contentEl.createDiv({ cls: "modal-button-container" });
          const proceed = row.createEl("button", { text: "Proceed", cls: "mod-cta" });
          proceed.addEventListener("click", () => {
            this.resolved = true;
            resolve(true);
            this.close();
          });
          const cancel = row.createEl("button", { text: "Cancel" });
          cancel.addEventListener("click", () => this.close());
        }
        onClose(): void {
          if (!this.resolved) resolve(false); // dismiss = decline
        }
      })(this.app);
      modal.open();
    });
  }

  // Adoption test twins (gates drive these headlessly — the confirm modal
  // above hangs CLI automation; queue responses instead).
  adoptRegionForTest(featureId: string): Promise<boolean> {
    return this.controller.adoptRegionForTest(featureId);
  }
  adoptAllForTest(): Promise<number> {
    return this.controller.adoptAllForTest();
  }
  overrideCurrentVersionForTest(algorithmId: string, version: number | null): void {
    this.controller.overrideCurrentVersionForTest(algorithmId, version);
  }
  queueConfirmResponseForTest(response: boolean): void {
    this.controller.queueConfirmResponseForTest(response);
  }
  needsAdoptionIds(): string[] {
    return this.controller.needsAdoptionIds();
  }
  adoptAllRegions(): Promise<number> {
    return this.controller.adoptAllRegions();
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
    // Canon only: generated content has no label layers — named places are
    // Locations.
    for (const depth of ["deep", "medium", "shallow"] as const) {
      const id = `canon-label-${depth}`;
      if (this.map.getLayer(id)) this.map.setLayerZoomRange(id, reveal[depth], 24);
    }
    // Generated building detail (footprints/parcels) is deliberately NOT
    // zoom-gated here — these layers render at every zoom like all fabric. Any
    // far-out readability treatment is a paint-level theme decision, not a
    // zoom gate — see generatedLayers.ts.
    //
    // Named-region overview labels: install the campaign-relative opacity ramp
    // (full at the Wide/overview level, faded to 0 by Mid). An opacity ramp, NOT
    // a zoom gate — the label feature always exists, it just goes transparent as
    // you zoom into the detail. Re-applied here so a restyle's constant-opacity
    // default is replaced by the campaign-relative fade.
    if (this.map.getLayer(REGION_LABEL_LAYER_ID)) {
      this.map.setPaintProperty(REGION_LABEL_LAYER_ID, "text-opacity", regionLabelOpacityRamp(base));
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
    // Water-avoidance (label-feature level): stamp a `dryAnchor` on any pin near
    // sketched water so the canon label layer's variable-anchor-offset prefers
    // the dry side. Display-only, deterministic; recomputed here on every canon
    // refresh (a location/theme change) — a subsequent water sketch edit
    // re-decorates on the next canon refresh, not live per stroke.
    const scale = this.campaign.config.scaleMetersPerUnit;
    const water = waterPolylinesFromFabric(this.controller.fabric.features);
    source.setData(decorateCanonWaterAvoidance(fc, water, metersToUnits(WATER_AVOIDANCE_METERS, scale)));
    this.updateWarningBadge();
    this.refreshConnections();
    this.refreshSessionPath();
    this.refreshFabric();
  }

  /** Point-crawl travel connections declared in `connections:` frontmatter —
   * resolved from the same index as canon pins, so a rename,
   * delete, or theme switch that refreshes `canon` also refreshes these lines. */
  private refreshConnections(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("connections") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const locations = this.plugin.getCampaignState(this.campaign.id).index.all();
    source.setData({ type: "FeatureCollection", features: buildConnectionFeatures(locations) });
  }

  /** Per-session travel path — modeled on `refreshConnections`,
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

  /** Sketched fabric — modeled on `refreshConnections`: re-applies
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
    const features = this.controller.fabric.features.map((f) => {
      const props: Record<string, unknown> = { ...f.properties, id: f.id };
      // Mirror-only paint properties (persisted bytes untouched):
      //  - `landformMode` lifts the landform's procgen `mode` (plateau/basin/sea)
      //    to a top-level filterable key so the fabric layer can paint a sea as
      //    theme water while plateau/basin keep the subtle wash.
      let invertedSea = false;
      if (f.properties.kind === "landform") {
        const params = f.properties.procgen?.params as { mode?: unknown; invert?: unknown } | undefined;
        if (typeof params?.mode === "string") props.landformMode = params.mode;
        invertedSea = params?.mode === "sea" && params?.invert === true;
      }
      // Geometry mirrors (persisted bytes untouched; selection reads the RAW
      // feature via controller.fabricFeature, so vertex handles map to the true
      // vertices, not these display forms):
      //  - rural roads: centripetal Catmull-Rom smoothing (straight strokes → gentle
      //    curves through the clicked vertices).
      //  - inverted sea (plan 041 island-from-coastline): the drawn ring is the
      //    COAST, so paint the ring's EXTERIOR as water by emitting a bounds-DONUT
      //    (outer = campaign box, hole = the coast). The water fill + selection then
      //    just work; the composed terrain field is the arithmetic source of truth.
      let geometry: GeoJSON.Geometry = f.geometry;
      if (f.properties.kind === "road" && f.geometry.type === "LineString") {
        geometry = { ...f.geometry, coordinates: smoothPolyline(f.geometry.coordinates as [number, number][]) };
      } else if (invertedSea && f.geometry.type === "Polygon") {
        geometry = { type: "Polygon", coordinates: this.invertedSeaDonut(f) };
      }
      return { ...f, geometry, properties: props };
    });
    source.setData({ type: "FeatureCollection", features } as GeoJSON.FeatureCollection);
    // Rederive the one-centroid-point-per-region overview-label source from the
    // SAME durable fabric (never the giant polygons, which repeat the symbol
    // per-tile). Derived from the raw collection so region names/geometry stay
    // authoritative; skipped silently if the style has no such source.
    const labelSource = this.map.getSource(REGION_LABEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (labelSource) {
      labelSource.setData(regionLabelSourceData(this.controller.fabric.features, this.campaign?.config));
    }
  }

  /**
   * Bounds-donut display geometry for an inverted sea (plan 041): outer ring =
   * campaign box, hole = the drawn coast ring, PLUS a hole for every OTHER landform
   * that re-raises land above the sea datum and lies in the exterior (Cradle bug
   * 2026-07-15 — an islet plateau out in the water was painted as water because
   * only the main coast was cut). So the fabric water fill paints everything
   * OUTSIDE the coast and OUTSIDE each island, and each island renders as land with
   * its wash/contours on top. Geometry + hole selection live in the shared,
   * host-agnostic `invertedSea` helper (same donut the region label builder uses).
   * Display-only — persisted geometry stays the drawn coast ring; elevation is
   * untouched (`exteriorMaskField` is the arithmetic source of truth). */
  private invertedSeaDonut(feature: FabricFeature): number[][][] {
    const coast = feature.geometry.type === "Polygon" ? (feature.geometry.coordinates[0] as number[][]) : [];
    const cfg = this.campaign?.config;
    const bounds = invertedSeaBounds(cfg?.bounds, cfg?.crs === "real", coast);
    const seaDatum = cfg?.terrain?.seaDatum ?? 0;
    const landHoles = invertedSeaLandHoles(feature, this.controller.fabric.features, seaDatum);
    return invertedSeaDonutRings(bounds, coast, landHoles);
  }

  /** Draft-preview accent for the sketch controller — the same accent token
   * the active theme's connection lines use. */
  private sketchAccent(): string {
    const theme = this.campaign?.config.theme ?? "";
    if (isHandcraftedTheme(theme)) return HANDCRAFTED_THEMES[theme].accent;
    return readObsidianCssTokens(this.containerEl).interactiveAccent;
  }

  /** Enters/exits sketch mode: shows the kind palette sub-bar,
   * activates the draw controller, suspends the normal click grammar (see
   * handleClick), and disables double-click zoom so dblclick can mean
   * "finish the draft". */
  toggleSketchMode(): void {
    if (!this.map || !this.campaign) return;
    if (this.sketchMode) {
      this.sketchMode = false;
      // Click-out safety: hitting ✕ done (or Escape-to-exit) with a finishable
      // draft in progress COMMITS it rather than silently dropping it — the
      // same "don't delete my shape" contract as a tool/kind switch.
      this.sketchController?.commitDraftIfAny();
      // NOTE: a pending constraint-regen debounce is deliberately NOT
      // cancelled here — "sketch a river, hit done" must still adapt the
      // generated tiles. onClose still cancels it on teardown.
      this.sketchController?.deactivate();
      this.sketchController = null;
      this.sketchBarEl?.remove();
      this.sketchBarEl = null;
      this.selectionPanelEl?.remove();
      this.selectionPanelEl = null;
      this.hideHeightReadout();
      this.syncSketchToolButtons = null;
      this.selectedFabricId = null;
      this.sketchTool = "draw";
      if (this.sketchKeyHandler) {
        window.removeEventListener("keydown", this.sketchKeyHandler, true);
        this.sketchKeyHandler = null;
      }
      this.map.doubleClickZoom.enable();
      this.pencilBtnEl?.toggleClass("is-active", false);
      // A drag abandoned mid-preview leaves a terrain draft staged — restore
      // the durable contour surface on mode exit.
      if (this.controller.clearTerrainPreview()) this.refreshTerrainContours();
      return;
    }
    this.sketchMode = true;
    void this.controller.loadFabric();
    this.droppedPinPopup?.remove();
    this.placeCardPopup?.remove();
    this.map.doubleClickZoom.disable();
    this.sketchController = new SketchController(this.map, this.sketchAccent(), {
      onGeometryEdit: (featureId, geometry) => {
        // Release/commit: cancel any pending mid-drag preview — the full
        // forward pass (via the debounced flush) supersedes it.
        if (this.sketchPreviewTimer !== null) {
          window.clearTimeout(this.sketchPreviewTimer);
          this.sketchPreviewTimer = null;
        }
        this.controller.clearTerrainPreview();
        void this.controller.commitGeometryEdit(featureId, geometry, { debounce: true });
        // Replace-over-add advisory: a landform whose (edited) ring now covers a
        // mountain/relief add-stamp flattens it — warn against the new geometry
        // (the commit is debounced, so build a feature carrying the fresh ring).
        const edited = this.controller.fabricFeature(featureId);
        if (edited) this.maybeWarnReplaceOverlap({ ...edited, geometry } as FabricFeature);
      },
      onCenterEdit: (featureId, center) => void this.controller.setRegionCenter(featureId, center),
      // Click-out safety: a finishable draft the GM implicitly left (switched
      // tool/kind, hit ✕ done) is persisted, not discarded.
      onDraftCommit: (geometry, kind) => this.persistSketchDraft(geometry, kind),
      // Drag-to-extrude height handle (plan 040): live readout during the drag
      // (no regen); on release, map the signed value back to the algorithm's
      // params and run the normal setRegionParams path (validate/log/cascade).
      onHeightDrag: (featureId, value) => this.showHeightReadout(featureId, value),
      onHeightCommit: (featureId, value) => {
        this.hideHeightReadout();
        const feature = this.controller.fabricFeature(featureId);
        if (!feature) return;
        const live = feature.properties.procgen?.params ?? {};
        void this.setRegionParams(featureId, { ...live, ...heightParamsFromValue(feature.properties.kind, value) });
      },
      // River per-vertex depth grips (plan 040): live readout during the drag;
      // on release, merge the (monotone-clamped) depths array into the live
      // params and run the normal setRegionParams path (validate/log/cascade).
      onDepthDrag: (_featureId, _index, value) => this.showDepthReadout(value),
      onDepthCommit: (featureId, values) => {
        this.hideHeightReadout();
        const feature = this.controller.fabricFeature(featureId);
        if (!feature) return;
        const live = feature.properties.procgen?.params ?? {};
        void this.setRegionParams(featureId, { ...live, ...depthParamsFromValues(values) });
      },
      // Band-edge grips (plan 040 Phase 2): live readout during the drag (the
      // ghost outline re-offsets in the controller, no regen); on release, merge
      // the single edited band param into the live params and run the normal
      // setRegionParams path (validate/log/cascade).
      onBandDrag: (_featureId, param, value) => this.showBandReadout(param, value),
      onBandCommit: (featureId, params) => {
        this.hideHeightReadout();
        const feature = this.controller.fabricFeature(featureId);
        if (!feature) return;
        const live = feature.properties.procgen?.params ?? {};
        // Presented → schema translation (relief `width` → halfWidth/apron).
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params)) {
          Object.assign(patch, presentedParamPatch(feature.properties.kind, k, v));
        }
        void this.setRegionParams(featureId, { ...live, ...patch });
      },
      onGeometryPreview: (featureId, geometry) => {
        // Preview mode (plan 034-D): per debounce PAUSE of the drag, repaint
        // only the ROOT region as ephemeral render state (no cache, no
        // fingerprints, no downstream). 250 ms trailing debounce.
        if (this.sketchPreviewTimer !== null) window.clearTimeout(this.sketchPreviewTimer);
        this.sketchPreviewTimer = window.setTimeout(() => {
          this.sketchPreviewTimer = null;
          // Terrain stamps (relief/landform/mountain/river) additionally
          // preview through the ELEVATION field: the draft geometry feeds an
          // ephemeral snapshot the contour manager traces, so the topo lines
          // follow the drag (2026-07-16). No DEM bust — 3D settles on release.
          if (this.controller.setTerrainPreview(featureId, geometry)) {
            this.refreshTerrainContours();
          }
          void this.controller.previewRegionGeometry(featureId, geometry);
        }, 250);
      },
    });
    this.sketchController.activate(this.sketchKind);
    this.buildSketchBar();
    // Default tool is the SELECTOR, not a draw kind (Jonah 2026-07-15): entering
    // sketch mode should let a click edit an existing shape, not immediately arm
    // the road pen. `sketchKind` is left untouched — it is the kind that draws
    // once the GM picks a draw tool.
    this.setSketchTool("select");
    // Capture phase so Escape / Cmd-Z reach us before MapLibre's canvas
    // handlers or Obsidian's global shortcuts can swallow them — Escape must
    // reliably leave sketch mode.
    this.sketchKeyHandler = (ev: KeyboardEvent) => this.sketchKeydown(ev);
    window.addEventListener("keydown", this.sketchKeyHandler, true);
    this.pencilBtnEl?.toggleClass("is-active", true);
  }

  get sketchModeActive(): boolean {
    return this.sketchMode;
  }

  /** Kind-palette sub-bar — an inline sub-bar rather than a modal: the GM
   * switches kinds constantly while landscaping, and a modal per switch would
   * break the flow. */
  private buildSketchBar(): void {
    this.sketchBarEl?.remove();
    this.sketchBarEl = this.contentEl.createDiv({ cls: "campaign-map-sketch-bar" });
    const kindButtons = new Map<FabricKind, HTMLButtonElement>();

    // Select tool: first position, arrow icon. Arming it lets a
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
        attr: { title: KIND_TOOLTIPS[kind] ?? `Sketch a ${kind} (${isPolygonKind(kind) ? "polygon" : "line"})` },
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

    // No feed-mode toggle, no "build" button — EVERY sketched feature is a
    // generator constraint, and tiles the GM already generated regenerate on
    // their own after a sketch edit (queueConstraintRegen).
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
    // Typing in a form field (the selection panel's name/param inputs, a modal
    // field): every key belongs to the FIELD — Backspace/Delete edit text and
    // must never delete the selected shape (Jonah 2026-07-16), Cmd-Z is the
    // field's own undo. Escape leaves the field (back to map focus) instead of
    // deselecting the shape mid-edit.
    const target = ev.target as HTMLElement | null;
    const inEditable =
      !!target &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable);
    if (inEditable) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        target.blur();
      }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "z" || ev.key === "Z") && !ev.shiftKey) {
      // Intercept before Obsidian's global undo so Cmd/Ctrl-Z means "undo the
      // last sketch" while landscaping.
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
      // otherwise the whole selected shape.
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
      // A repeated click at the same spot cycles down through the overlapping
      // stack (farmland first, the plateau beneath on the next click) so a big
      // terrain stamp never traps the detail region on top of it.
      const hitId = this.pickFabricForSelect(e.point);
      if (hitId) this.selectFabricFeature(hitId);
      else this.deselectFabric();
      return;
    }
    // Draw tool, no draft yet: a click starts a new shape.
    this.deselectFabric();
    c.addVertex([e.lngLat.lng, e.lngLat.lat]);
  }

  /** Every overlapping fabric feature under the click box, resolved to real
   * FabricFeatures (kind + ring area) via the mirrored `properties.id`
   * (refreshFabric mirrors the feature id there because queryRenderedFeatures
   * doesn't reliably surface string feature ids from a geojson source). Deduped
   * by id, preserving first-seen render order as each candidate's `rank`. */
  private fabricCandidatesAt(point: maplibregl.Point): FabricCandidate[] {
    if (!this.map) return [];
    const layers = FABRIC_LAYER_IDS.filter((l) => this.map!.getLayer(l));
    if (layers.length === 0) return [];
    const hits = this.map.queryRenderedFeatures(
      [
        [point.x - 6, point.y - 6],
        [point.x + 6, point.y + 6],
      ],
      { layers }
    );
    const seen = new Set<string>();
    const candidates: FabricCandidate[] = [];
    for (const h of hits) {
      const id = h.properties?.id as string | undefined;
      if (!id || seen.has(id)) continue;
      const feature = this.controller.fabricFeature(id);
      if (!feature) continue;
      seen.add(id);
      candidates.push({
        id,
        kind: feature.properties.kind,
        area: this.fabricAreaOf(feature),
        rank: candidates.length,
      });
    }
    return candidates;
  }

  /**
   * `polygonNetArea` memoized per feature GEOMETRY (Jonah 2026-07-15, Cradle:
   * "everything feels slow to click around"). Every fabric click computes the net
   * area of each overlapping candidate to order them; on the Cradle a water click
   * hits the huge inverted-sea donut (bounds ring + 128-vertex coast + islet
   * holes), so its shoelace re-ran over hundreds of vertices per click. A geometry
   * edit replaces the geometry object (`commitGeometryEdit`: `{ ...before,
   * geometry }`), so keying the WeakMap on `feature.geometry` invalidates the
   * cached area exactly when — and only when — the shape actually changes. */
  private readonly fabricAreaCache = new WeakMap<object, number>();
  private fabricAreaOf(feature: FabricFeature): number {
    const geom = feature.geometry as unknown as object;
    const cached = this.fabricAreaCache.get(geom);
    if (cached !== undefined) return cached;
    const area = polygonNetArea(feature as unknown as GeoJSON.Feature);
    this.fabricAreaCache.set(geom, area);
    return area;
  }

  /** Best single fabric id under a screen point (topmost-detail rule, no
   * cycling) — used by the right-click grammar. Resolves overlapping polygons
   * the same way a select-click does, minus the repeated-click cycling. */
  private fabricFeatureIdAt(point: maplibregl.Point): string | null {
    if (!this.map) return null;
    const ordered = orderFabricCandidates(this.fabricCandidatesAt(point));
    if (ordered.length > 0) return ordered[0].id;
    // Fallback: a spine region's sketch line paints invisible under its
    // generated channel (fabricLayers), and a meandered channel can sit
    // farther from the spine than the 6px box — clicking the WATER should
    // still select the river. Corridor-exact resolution on the controller.
    const lngLat = this.map.unproject(point);
    return this.controller.spineRegionIdAtDisplayPoint(lngLat.lng, lngLat.lat);
  }

  /** Select-click resolution WITH stacked cycling: the first click at a spot
   * picks the topmost detail (smallest polygon; terrain stamps sink), a repeated
   * click at the same spot advances to the next candidate beneath. Falls back to
   * the spine-region corridor when nothing paints under the box. */
  private pickFabricForSelect(point: maplibregl.Point): string | null {
    if (!this.map) return null;
    const candidates = this.fabricCandidatesAt(point);
    if (candidates.length === 0) {
      this.fabricCycle = null;
      const lngLat = this.map.unproject(point);
      return this.controller.spineRegionIdAtDisplayPoint(lngLat.lng, lngLat.lat);
    }
    const { id, state } = resolveFabricClick(candidates, { x: point.x, y: point.y }, this.fabricCycle);
    this.fabricCycle = state;
    return id;
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
   * effective generation-center handle (computed on the lifecycle controller)
   * for a procgen region. */
  private reselectController(feature: FabricFeature): void {
    const center = isProcgenRegion(feature) ? this.controller.effectiveRegionCenterDisplay(feature) : null;
    // Height handle: only for a GENERATED terrain stamp (its params exist).
    const params = feature.properties.procgen?.params;
    const desc = params ? heightHandleDescriptor(feature.properties.kind, params) : null;
    // River depth grips (plan 040): one per spine vertex, seeded from the
    // persisted per-vertex depths or the uniform width-derived incision.
    const vertexCount =
      feature.geometry.type === "LineString" ? feature.geometry.coordinates.length : 0;
    const depthVals = params ? riverDepthValues(feature.properties.kind, params, vertexCount) : null;
    // Band ghost (plan 040 Phase 2): the effective ground band a relief/landform
    // reaches, editable on the map. Values are the live param metres; the
    // controller converts them into the geometry's planar units via metersPerUnit.
    const kind = feature.properties.kind;
    const band =
      params && (kind === "relief" || kind === "landform")
        ? { values: bandValuesFromParams(kind, params), metersPerUnit: this.campaign?.config.scaleMetersPerUnit ?? 1 }
        : null;
    this.sketchController?.select({
      id: feature.id,
      geometry: feature.geometry,
      kind: feature.properties.kind,
      center,
      height: desc ? { value: desc.value, min: desc.min, max: desc.max } : null,
      depths: depthVals ? { values: depthVals, min: DEPTH_HANDLE_MIN, max: DEPTH_HANDLE_MAX } : null,
      band,
    });
  }

  /** Clear any Select-tool selection + its panel. */
  private deselectFabric(): void {
    this.selectedFabricId = null;
    this.fabricCycle = null;
    this.sketchController?.clearSelection();
    this.selectionPanelEl?.remove();
    this.selectionPanelEl = null;
    this.hideHeightReadout();
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
    this.persistSketchDraft(geometry, kind);
  }

  /** Persist a finished draft geometry into a FabricFeature (both the explicit
   * double-click/Enter finish and the auto-commit-on-click-out path funnel
   * through here so a shape reaches the vault the same way either way). */
  private persistSketchDraft(geometry: FabricGeometry, kind: FabricKind): void {
    const feature: FabricFeature = {
      type: "Feature",
      id: makeFabricId(),
      geometry,
      properties: { kind },
    };
    this.controller.addSketchedFeature(feature);
    // Immediate confirmation regardless of zoom (a below-minzoom stroke paints
    // into the `fabric` source but its themed layer may be hidden until you
    // zoom in — the toast guarantees "something happened" feedback).
    new Notice(`Campaign Map: ${kind} added`);
    // A district sketch IS the request for city procgen — offer it (modal);
    // other kinds (or a cancelled modal) stay inert overlay shapes.
    this.maybeOfferProcgen(feature);
  }

  /** Live drag readout for the height handle (modeling-software convention:
   * the exact value is visible while you drag). A single lightweight overlay
   * pinned to the sketch bar — the terrain itself re-composes on release. */
  private showHeightReadout(_featureId: string, value: number): void {
    if (!this.heightReadoutEl) {
      this.heightReadoutEl = this.contentEl.createDiv({ cls: "campaign-map-height-readout" });
    }
    this.heightReadoutEl.setText(formatHeightReadout(value));
  }

  private hideHeightReadout(): void {
    this.heightReadoutEl?.remove();
    this.heightReadoutEl = null;
  }

  /** Live drag readout for a river depth grip — reuses the height readout HUD
   * (only one grip drags at a time). */
  private showDepthReadout(value: number): void {
    if (!this.heightReadoutEl) {
      this.heightReadoutEl = this.contentEl.createDiv({ cls: "campaign-map-height-readout" });
    }
    this.heightReadoutEl.setText(formatDepthReadout(value));
  }

  /** Live drag readout for a band-edge grip (plan 040 Phase 2) — reuses the
   * height readout HUD (only one band grip drags at a time). */
  private showBandReadout(param: string, value: number): void {
    if (!this.heightReadoutEl) {
      this.heightReadoutEl = this.contentEl.createDiv({ cls: "campaign-map-height-readout" });
    }
    this.heightReadoutEl.setText(formatBandReadout(param as "width" | "band", value));
  }

  /** Arms the debounced constraint/region regen ("sketch a river, streets
   * adapt") — MapView owns the `window` timer; the queued work
   * lives on the controller, which arms this via the render sink. Cleared on
   * mode exit / onClose so it can never fire after teardown. */
  private armSketchRegen(): void {
    if (this.sketchAutoBuildTimer !== null) window.clearTimeout(this.sketchAutoBuildTimer);
    // 100 ms (was 400, 2026-07-16): the arming events are DISCRETE (a drag
    // release, a finished shape), not per-frame, so the window only needs to
    // coalesce a rapid burst of commits — `runForwardPass`'s passChain already
    // serializes overlapping passes. 400 ms was pure dead time on the
    // edit-to-repaint path.
    this.sketchAutoBuildTimer = window.setTimeout(() => {
      this.sketchAutoBuildTimer = null;
      void this.controller.flushSketchRegen();
    }, 100);
  }

  /** Debounced external-fabric reload (vault-as-source-of-truth). Sync writes
   * arrive in bursts, so a longer coalescing window than the sketch-regen timer
   * lets a multi-file sync settle before one reconcile pass. Cleared on onClose. */
  private armFabricReload(): void {
    if (this.fabricReloadTimer !== null) window.clearTimeout(this.fabricReloadTimer);
    this.fabricReloadTimer = window.setTimeout(() => {
      this.fabricReloadTimer = null;
      void this.controller.reloadFabricFromDisk();
    }, 500);
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

  // ─── Selected-feature panel ─────────────────────────────────────────────

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

    const nameRow = panel.createDiv({
      cls: "campaign-map-sketch-selection-row",
      attr: { title: "Display name for this shape — shown as its map label where the kind draws one." },
    });
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

    // Persistent replace-over-add hint (Cradle learning 2026-07-15): while a
    // non-inverted landform that covers mountain/relief add-stamps is selected,
    // keep a one-line advisory in view (the Notice is transient — this is the
    // durable reminder that its replace is flattening those stamps).
    if (feature.properties.kind === "landform") {
      const scale = this.campaign?.config.scaleMetersPerUnit ?? 1;
      const hint = landformReplaceAdvisoryMessage(feature, this.controller.fabric.features, scale);
      if (hint) {
        // The message already leads with "⚠ " (single canonical string, shared with
        // the Notice) — render it verbatim, no extra prefix.
        panel.createDiv({ cls: "campaign-map-sketch-selection-warning", text: hint });
      }
    }

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
        attr: {
          title: `Grow a ${algorithm.label.toLowerCase()} from this shape — pick a template, then everything generates inside the boundary you drew.`,
        },
      });
      gen.onclick = () => this.maybeOfferProcgen(feature);
      return;
    }
    // Needs-adoption state: the region is pinned to an older generator
    // version. Offer the explicit adopt action (edits would prompt anyway).
    if (this.controller.isRegionPinnedOld(feature.id)) {
      const row = section.createDiv({ cls: "campaign-map-sketch-selection-row" });
      row.createSpan({
        cls: "campaign-map-sketch-procgen-label",
        text: `Needs adoption — generated by an older ${algorithm.label} generator (v${block.version})`,
      });
      const adopt = row.createEl("button", {
        cls: "campaign-map-sketch-procgen-btn mod-cta",
        text: "Adopt",
        attr: { title: "Regenerate this region with the current generator version. Its look may change; until adopted it keeps (or lost) its old bytes and never silently changes." },
      });
      adopt.onclick = () =>
        void this.controller.adoptRegion(feature.id).then(() => this.refreshSelectionPanel());
    }
    // Outdated state (plan 034): a cost-capped forward pass deferred this
    // region — its painted bytes are the pre-edit cache. Offer the explicit
    // apply action (the same non-modal affordance as the command).
    if (this.controller.outdatedRegionIds().includes(feature.id)) {
      const row = section.createDiv({ cls: "campaign-map-sketch-selection-row" });
      row.createSpan({
        cls: "campaign-map-sketch-procgen-label",
        text: "Outdated — an upstream edit is waiting to be applied here",
      });
      const apply = row.createEl("button", {
        cls: "campaign-map-sketch-procgen-btn mod-cta",
        text: "Apply pending cascade",
        attr: { title: "Re-run the deferred regeneration an earlier edit queued for this region (it was skipped to keep that edit fast)." },
      });
      apply.onclick = () =>
        void this.controller.applyPendingCascade().then(() => this.refreshSelectionPanel());
    }
    // Template (preset) dropdown — the primary control. For city the four
    // profiles ARE the presets: picking a template re-seeds params from that
    // preset. When the params have been customised away from every preset the
    // dropdown shows a synthetic "Custom (from …)" option (unreachable for city
    // today, since its only knob IS the preset discriminator — the mechanism is
    // here for param-carrying algorithms).
    if (algorithm.presets.length > 0) {
      const row = section.createDiv({
        cls: "campaign-map-sketch-selection-row",
        attr: {
          title:
            "Quick-fill: picking a template sets every knob below to that preset\u2019s values (you can still tweak them after). \u2018Custom\u2019 means the current values match no template.",
        },
      });
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
    // Per-param controls, derived from the algorithm's zod schema — every knob
    // beyond the preset discriminator (river windiness/slopeSensitivity, wall
    // towerSpacing/moat, relief height/halfWidth, city grade, …). A change reads
    // the LIVE params (they may have shifted) and runs the full setRegionParams
    // commit path (validate → log → regen), then rebuilds the panel.
    // PRESENTED specs/values (relief: one `width` control instead of the
    // confusing halfWidth+apron split — the field only reads their sum).
    const kindForParams = feature.properties.kind;
    const specs = presentedParamSpecs(kindForParams, algorithm.paramsSchema);
    const paramsEl = section.createDiv({ cls: "campaign-map-param-controls" });
    renderParamControls(paramsEl, specs, presentedParams(kindForParams, block.params), (key, value) => {
      const live = this.controller.fabricFeature(feature.id)?.properties.procgen;
      if (!live) return;
      void this.setRegionParams(feature.id, {
        ...live.params,
        ...presentedParamPatch(kindForParams, key, value),
      }).then(() => this.refreshSelectionPanel());
    });
    // Center hint: drag the diamond handle to place the plaza. Only where the
    // algorithm's params schema HAS a center (city) — a relief/landform/forest
    // generator never reads one, so the hint (and the ◆ handle,
    // effectiveRegionCenterDisplay) must not appear (Jonah 2026-07-16).
    const isPolygonRegion = feature.geometry.type === "Polygon" && algorithmSupportsCenter(algorithm);
    const hasCenter = isPolygonRegion && "center" in block.params;
    if (isPolygonRegion) {
      section.createDiv({
        cls: "campaign-map-sketch-procgen-label",
        text: hasCenter ? "Center: custom (drag the ◆ handle)" : "Center: automatic (drag the ◆ handle to place)",
        attr: { title: "The plaza and main streets anchor at the center. Drag the \u25c6 handle on the map to place it; automatic picks the polygon\u2019s natural center." },
      });
    }

    const actions = section.createDiv({ cls: "campaign-map-sketch-procgen-actions" });
    const reroll = actions.createEl("button", {
      cls: "campaign-map-sketch-procgen-btn",
      text: "Re-roll",
      attr: { title: "New random seed: a fresh layout with the same shape and settings. This permanently replaces the current layout." },
    });
    reroll.onclick = () => void this.rerollRegion(feature.id);
    const regen = actions.createEl("button", {
      cls: "campaign-map-sketch-procgen-btn",
      text: "Regenerate",
      attr: { title: "Rebuild from the same seed and settings — the layout stays identical; use it if the drawn fabric looks stale." },
    });
    regen.onclick = () => void this.regenerateRegionById(feature.id);
    if (hasCenter) {
      const resetCenter = actions.createEl("button", {
        cls: "campaign-map-sketch-procgen-btn",
        text: "Reset center",
        attr: { title: "Forget the hand-placed \u25c6 center and go back to the automatic one." },
      });
      resetCenter.onclick = () => void this.setRegionCenter(feature.id, null);
    }
    // "Remove", kind-agnostic (a city-specific label would be wrong on a
    // selected river). Strips the procgen block; the sketch stays inert.
    const remove = actions.createEl("button", {
      cls: "campaign-map-sketch-procgen-btn campaign-map-sketch-procgen-btn-warning",
      text: "Remove",
      attr: { title: "Remove the generated content. The drawn shape stays and can be re-generated later." },
    });
    remove.onclick = () => void this.removeRegionById(feature.id);
  }

  // ─── Region param actions (panel + test API) ──────────────────────────

  /** Change a region's procgen params — logs a `sketch-procgen-set`
   * {before: oldBlock, after: newBlock} and force-regens (the id-keyed cache
   * carries no params). Seed unchanged. A terrain-bearing kind
   * (mountain/relief/landform) moves the composed elevation field, so refresh
   * the DEM if relief is showing (mirrors reroll/regenerate). */
  async setRegionParams(featureId: string, params: Record<string, unknown>): Promise<void> {
    await this.controller.setRegionParams(featureId, params);
    // DEM/contour refresh converges through the render chokepoint (the commit
    // repaints, moving the elevation digest for a terrain-bearing kind) — no
    // explicit refresh needed here (would double-fire).
    // A landform param edit (mode/target/band/…) can change what it flattens —
    // re-run the replace-over-add advisory against the settled feature.
    const edited = this.controller.fabricFeature(featureId);
    if (edited) this.maybeWarnReplaceOverlap(edited);
  }

  /** Replace-over-add advisory (Cradle learning 2026-07-15): fire a NON-BLOCKING
   * Notice when a non-inverted landform's ring covers a mountain/relief add-stamp
   * (a replace flattens the add inside it). No-op for any non-landform feature and
   * when nothing overlaps. The decision + message live in the host-agnostic,
   * headless-tested `terrainAdvisory` twin; here we just pass the live fabric and
   * the Obsidian Notice seam. */
  private maybeWarnReplaceOverlap(feature: FabricFeature): void {
    if (feature.properties.kind !== "landform") return;
    const scale = this.campaign?.config.scaleMetersPerUnit ?? 1;
    warnLandformReplaceOverlap(feature, this.controller.fabric.features, scale, (message) =>
      new Notice(`Campaign Map: ${message}`, 8000)
    );
  }

  /** Apply a template (preset) to a region — the headless twin of the panel's
   * Template dropdown. Resolves the preset → params (keeping any orthogonal
   * params like `center`) and runs the full setRegionParams commit path. City
   * presets carry no `presetId` (params always match a preset), so the
   * persisted block stays the plain `{ profile }` shape. */
  async setRegionPreset(featureId: string, presetId: string): Promise<void> {
    await this.controller.setRegionPreset(featureId, presetId);
    // A mountain/relief/landform template shift moves the DEM — refreshed via the
    // render chokepoint (the commit repaint changes the elevation digest).
  }

  /** Re-roll a region: a NEW seed (`hashSeed(seed, "reroll")`) — the city
   * re-rolls rather than adapting. Logged as `sketch-procgen-set`, force-regen. */
  async rerollRegion(featureId: string): Promise<void> {
    await this.controller.rerollRegion(featureId);
    // A re-rolled mountain reshapes the DEM (new seed) — refreshed via the render
    // chokepoint (the commit repaint changes the elevation digest).
  }

  /** Regenerate a region against CURRENT constraints (drop records + recompute,
   * no block change, no log — idempotent). */
  async regenerateRegionById(featureId: string): Promise<GeoJSON.Feature[]> {
    const feats = await this.controller.regenerateRegionById(featureId);
    this.refreshTerrainIfEnabled(); // pick up any mountain change in the DEM
    return feats;
  }

  /** Remove a region's generated city (strip the block; shape stays inert). */
  async removeRegionById(featureId: string): Promise<void> {
    return this.controller.removeRegionById(featureId);
  }

  // ─── Programmatic edit test API ─────────────────────────────────────────
  // Each runs the FULL commit path (validation, sketch-edit log, persist,
  // regen) synchronously-awaitable, so a gate can assert on the settled state.
  // These forward to the host-agnostic MapController — the same surface the
  // FakeHost integration tests drive headlessly.

  /** Create a plain (non-procgen) fabric feature headlessly (gate path — the
   * constraint-loop test needs a river/road/wall/water shape to edit). */
  async createFabricForTest(kind: FabricKind, coordsUnits: [number, number][], name?: string): Promise<string> {
    return this.controller.createFabricForTest(kind, coordsUnits, name);
  }

  /** Delete a fabric feature by id through the real select→delete path
   * (gate/test path for the sketch-remove lifecycle — a region takes its
   * generated city + cache records with it). Returns whether the feature was
   * found and removed. */
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

  /** Numeric elevation samples for a mountain region: the point-evaluable
   * height field rebuilt from the persisted seed+params and sampled at
   * deterministic gen-space points — heights compared numerically, never
   * rendered bytes. Two calls across a regenerate must match. */
  regionElevationReport(regionId: string): { x: number; y: number; h: number; dx: number; dy: number }[] {
    return this.controller.regionElevationReport(regionId);
  }

  /** DEM tile report for the terrain gate: resolves one raster-DEM tile through
   * the FULL protocol path (digest-checked cache read → compute
   * → persisted append — exactly a MapLibre fetch minus the PNG encode) and
   * returns compact numeric stats over the raw int lattice. HEIGHTS are the
   * determinism surface — the FNV-1a hash lets a gate compare lattices across
   * regenerate / cache delete without hauling 65k ints through an eval. */
  async demTileReport(
    z: number,
    x: number,
    y: number
  ): Promise<{ res: number; min: number; max: number; nonZero: number; hash: string }> {
    if (!this.campaign) throw new Error("no campaign");
    const heights = await resolveDemTileForTest(this.campaign.id, z, x, y);
    let min = Infinity;
    let max = -Infinity;
    let nonZero = 0;
    let h = 0x811c9dc5;
    for (const v of heights) {
      if (v < min) min = v;
      if (v > max) max = v;
      if (v !== 0) nonZero++;
      // FNV-1a over the int stream (byte-order-free — ints, not bytes).
      h ^= v & 0xffff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return { res: Math.sqrt(heights.length), min, max, nonZero, hash: h.toString(16) };
  }

  /** Set (or clear, with `null`) a region's persisted generation center
   * (params.center, gen-space meters) via the full commit path — the
   * draggable-plaza feature. `centerDisplay` is in DISPLAY units. */
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
      registerTreeGlyphs(this.map!);
      registerParkGlyphs(this.map!);
        registerRiverGlyphs(this.map!);
      this.refreshSource();
      // setStyle bakes an EMPTY `generated` source (buildStyle's baseline), so
      // the generated fabric must be re-pushed here exactly as setCampaign's and
      // load's styledata handlers do — without this, a css-change on the
      // obsidian-native theme blanked every generated feature until the next
      // explicit generation.
      this.refreshGeneratedSource();
      this.applyFocusReveal();
      // css-change setStyle also resets hillshade/terrain — restore the toggle.
      if (this.terrainToggle.isEnabled()) this.setTerrainEnabled(true);
      // ...and recreates the empty terrain-contour source → repopulate it.
      this.refreshTerrainContours();
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
    // Sketch mode owns the click pipeline: every click is a
    // vertex/select action; the normal pin/popup grammar is suspended.
    if (this.sketchMode) {
      this.handleSketchClick(e);
      return;
    }
    const canon = this.pickFeatureNear(e.point, ["canon-point", "canon-label"]);
    // Connection lines only matter when no pin was hit — skip the query otherwise.
    const line = canon
      ? undefined
      : this.map.queryRenderedFeatures(e.point, {
          layers: this.map.getLayer("connection-line") ? ["connection-line"] : [],
        })[0];
    const action = resolveMapClickAction({
      sketchMode: false,
      canonHit: Boolean(canon),
      connectionHit: Boolean(line),
    });
    switch (action) {
      case "canon-noop":
        // Left-click on a location pin: no popup (Jonah 2026-07-15 — "it pops up
        // a little menu … annoying as hell"). The place card is retired from
        // left-click; its actions (Open note / Center / Connect to… /
        // Visibility) live on the right-click Menu. The hover tooltip already
        // shows the name, so a bare left-click is a deliberate no-op — and it
        // must NOT fall through to plant a dropped pin under the pin.
        return;
      case "connection":
        this.showConnectionCard(line!, e.lngLat);
        return;
      case "dropped-pin":
        this.showDroppedPin(e.lngLat);
        return;
      default:
        return;
    }
  }

  private handleContextMenu(e: MapMouseEvent): void {
    if (!this.map || !this.campaign) return;
    e.originalEvent.preventDefault();
    const lngLat = e.lngLat;
    const point: [number, number] = [lngLat.lng, lngLat.lat];
    const menu = new Menu();

    const canonId = this.hitTestCanonAt(e.point.x, e.point.y);
    const location = canonId
      ? this.plugin.getCampaignState(this.campaign.id).index.get(canonId)
      : undefined;
    const fabricId = this.fabricFeatureIdAt(e.point);
    const fabricFeature = fabricId ? this.controller.fabricFeature(fabricId) : undefined;
    const sections = resolveContextMenuSections({
      canonHit: Boolean(location),
      fabricHit: Boolean(fabricFeature),
      fictional: this.campaign.config.crs === "fictional",
    });

    // Right-click a location pin: the retired left-click place card's actions
    // now live here (Jonah 2026-07-15) — Open note / Center / Connect to… /
    // Visibility. Right-click is the one place location UI opens.
    if (sections.location && location) {
      this.addLocationMenuItems(menu, location);
      menu.addSeparator();
    }

    // Right-click a sketch feature (works OUTSIDE sketch mode too): "Edit
    // shape" enters sketch mode with it selected; a region also
    // gets "City settings…" (its procgen section in the same panel). The
    // dropped-pin grammar below is untouched.
    if (sections.fabric && fabricFeature) {
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
    // Explicit generation lives on the right-click grammar: the
    // only way procedural fabric appears, changes, or goes away is the GM
    // asking at a spot. Fictional campaigns only — real cities have basemaps.
    if (sections.generation) {
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

  /**
   * Location actions on the right-click Menu (Jonah 2026-07-15). This is the
   * home for what the left-click place card used to offer, now that a bare
   * left-click on a pin is a no-op: Open note · Center · Connect to… ·
   * Visibility. The card's note *preview* was display-only (not an action) — the
   * hover tooltip shows the name and "Open note" shows the body, so it is
   * dropped rather than reproduced in a menu.
   */
  private addLocationMenuItems(menu: Menu, location: ParsedLocation): void {
    const file = this.app.vault.getAbstractFileByPath(location.path);
    menu.addItem((item) =>
      item
        .setTitle("Open note")
        .setIcon("file-text")
        .onClick(() => {
          if (file instanceof TFile) {
            void this.app.workspace
              .getLeaf("split")
              .openFile(file, { state: { mode: "source" }, eState: { focus: true } });
          }
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Center")
        .setIcon("crosshair")
        .onClick(() => {
          if (location.point) this.map?.flyTo({ center: location.point });
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Connect to…")
        .setIcon("link")
        .onClick(() => {
          const others = this.plugin
            .getCampaignState(this.campaign!.id)
            .index.all()
            .filter((l) => l.path !== location.path && l.point);
          new LocationSearchModal(this.app, others, (target) => {
            void addConnection(this.app, location.path, target.name).then(() => {
              new Notice(`Campaign Map: connected ${location.name} → ${target.name}`);
            });
          }).open();
        })
    );
    // Retune label visibility mid-session — no frontmatter edit. Writes the
    // explicit `visibility` field; the metadataCache change re-reconciles and
    // the map updates. Flat checkable items (Obsidian's typed Menu has no
    // submenu), current value checked.
    const VIS_LABELS: Record<Visibility, string> = {
      wide: "Visibility: Wide — always shown",
      mid: "Visibility: Mid — from mid zoom",
      close: "Visibility: Close — only up close",
    };
    for (const v of VISIBILITY_VALUES) {
      menu.addItem((item) =>
        item
          .setTitle(VIS_LABELS[v])
          .setChecked(location.visibility === v)
          .onClick(() => {
            void setLocationVisibility(this.app, location, v).then(() => {
              new Notice(`Campaign Map: "${location.name}" visibility → ${v}`);
            });
          })
      );
    }
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

  /** Click-a-line-to-remove: the reciprocal gesture to "Connect to..." —
   * `from`/`to` on a `connection-line` feature are vault paths, so resolve them
   * to basenames the same way the frontmatter stores
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

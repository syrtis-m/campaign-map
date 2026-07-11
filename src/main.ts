import { Plugin, TFile, Notice, WorkspaceLeaf, FuzzySuggestModal } from "obsidian";
import { MapView, VIEW_TYPE_MAP } from "./view/MapView";
import { parseCampaignConfig, slugify, type ParsedCampaign } from "./model/campaignConfig";
import { CreateCampaignModal } from "./view/CreateCampaignModal";
import { CampaignControlModal } from "./view/CampaignControlModal";
import {
  parseLocationNote,
  type ParsedLocation,
  type LocationParseError,
  type Visibility,
} from "./model/locationNote";
import { LocationIndex } from "./map/locationIndex";
import { createLocationNote, createLocationNoteFromFeature, moveLocationNote } from "./vault/locationOps";
import { GenerationWorkerClient } from "./map/generation/workerClient";
import { readLog, campaignFolderFromConfigPath, type LogEntry } from "./model/mutationLog";

const MAP_CONFIG_SUFFIX = ".map.md";

class CampaignPickerModal extends FuzzySuggestModal<ParsedCampaign> {
  constructor(
    private plugin: CampaignMapPlugin,
    private onChoose: (campaign: ParsedCampaign) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Open map: choose a campaign...");
  }

  getItems(): ParsedCampaign[] {
    return this.plugin.listCampaigns();
  }

  getItemText(campaign: ParsedCampaign): string {
    return campaign.name;
  }

  onChooseItem(campaign: ParsedCampaign): void {
    this.onChoose(campaign);
  }
}

interface CampaignState {
  index: LocationIndex;
  invalid: Map<string, LocationParseError>;
}

export default class CampaignMapPlugin extends Plugin {
  private campaigns = new Map<string, ParsedCampaign>();
  private registeredCommandIds = new Set<string>();
  private campaignStates = new Map<string, CampaignState>();
  private rescanQueued = false;
  private workerClient: GenerationWorkerClient | null = null;
  private workerLastResultValue: GeoJSON.Feature[] | null = null;
  private lastRescanMs = 0;

  // Test API surface (docs/05): app.plugins.plugins['campaign-map']
  get map(): MapView["map"] {
    return this.activeMapView()?.map ?? null;
  }
  get index(): LocationIndex | null {
    const campaignId = this.activeMapView()?.campaign?.id;
    return campaignId ? this.getCampaignState(campaignId).index : null;
  }
  get log() {
    return { read: (campaignId: string) => this.readCampaignLog(campaignId) };
  }
  get generated(): GeoJSON.Feature[] {
    return this.activeMapView()?.generated ?? [];
  }
  // Web Worker smoke-test surface (docs/02 §5) — see DECISIONS.md for scope.
  get workerLastResult(): GeoJSON.Feature[] | null {
    return this.workerLastResultValue;
  }
  // Perf gate surface (docs/06 §2: "index rebuild time <1s for 500-note
  // campaigns") — wall-clock ms of the most recent rescanAll() pass.
  get rescanTimeMs(): number {
    return this.lastRescanMs;
  }
  // Phase 4 dispatcher surface: how many tile-store entries the active
  // view currently holds (viewport-windowed, not ever-growing — see MapView).
  get loadedTileCount(): number {
    return this.activeMapView()?.loadedTileCount ?? 0;
  }

  /** Lazily created, shared across the session; the Phase 4 viewport
   * dispatcher (MapView) and the smoke-test command both go through this
   * so there's exactly one worker instance. Returns null (rather than
   * throwing) on creation failure so callers can fall back to direct
   * main-thread generation instead of breaking the map. */
  async getGenerationWorker(): Promise<GenerationWorkerClient | null> {
    if (this.workerClient) return this.workerClient;
    try {
      this.workerClient = await GenerationWorkerClient.create(this.app);
      return this.workerClient;
    } catch (err) {
      console.error("Campaign Map: generation worker unavailable, falling back to main-thread generation", err);
      return null;
    }
  }

  private activeMapView(): MapView | null {
    const active = this.app.workspace.getActiveViewOfType(MapView);
    if (active) return active;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)[0];
    return leaf?.view instanceof MapView ? leaf.view : null;
  }

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf, this));

    this.addRibbonIcon("map", "Open campaign map", () => this.openMapCommand());
    this.addRibbonIcon("plus-circle", "Create new campaign", () => this.createCampaignFlow());
    this.addRibbonIcon("settings", "Campaign settings", () => this.openControlPanel());

    this.addCommand({ id: "open-map", name: "Open map", callback: () => this.openMapCommand() });

    this.addCommand({
      id: "create-new-campaign",
      name: "Create new campaign",
      callback: () => this.createCampaignFlow(),
    });

    this.addCommand({
      id: "campaign-settings",
      name: "Campaign settings (theme, naming, basemap)",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) this.openControlPanel();
        return true;
      },
    });

    this.addCommand({
      id: "search-locations",
      name: "Search locations",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) view.openSearch();
        return true;
      },
    });

    this.addCommand({
      id: "populate-area",
      name: "Populate area",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.populateArea();
        return true;
      },
    });

    this.addCommand({
      id: "export-map-poster",
      name: "Export map poster",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.exportPoster();
        return true;
      },
    });

    this.addCommand({
      id: "show-session-path",
      name: "Show session travel path",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) view.showSessionPath();
        return true;
      },
    });

    this.addCommand({
      id: "replay-campaign",
      name: "Replay campaign (mutation log)",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.replayCampaign();
        return true;
      },
    });

    this.addCommand({
      id: "import-geojson",
      name: "Import GeoJSON (Azgaar/Watabou export)",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.importGeojson();
        return true;
      },
    });

    this.addCommand({
      id: "export-map-atlas",
      name: "Export campaign atlas (PDF)",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.exportAtlas();
        return true;
      },
    });

    this.addCommand({
      id: "undo-last-map-edit",
      name: "Undo last map edit",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.undoLastEdit();
        return true;
      },
    });

    this.addCommand({
      id: "switch-campaign-theme",
      name: "Switch map theme",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) view.switchTheme();
        return true;
      },
    });

    this.addCommand({
      id: "generate-city-here",
      name: "Generate city fabric here",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.generateCityHere();
        return true;
      },
    });

    this.addCommand({
      id: "regenerate-city-here",
      name: "Regenerate city fabric here",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.generateCityHere(undefined, true);
        return true;
      },
    });

    this.addCommand({
      id: "generate-world-here",
      name: "Generate world fabric here",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.generateWorldHere();
        return true;
      },
    });

    this.addCommand({
      id: "regenerate-world-here",
      name: "Regenerate world fabric here",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.generateWorldHere(undefined, true);
        return true;
      },
    });

    this.addCommand({
      id: "canonize-nearest-generated",
      name: "Canonize nearest generated feature",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.canonizeGeneratedNear();
        return true;
      },
    });

    this.addCommand({
      id: "toggle-sketch-mode",
      name: "Toggle sketch mode (draw city fabric)",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) view.toggleSketchMode();
        return true;
      },
    });

    this.addCommand({
      id: "generate-from-sketch",
      name: "Generate street network from sketched corridors",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.generateFromSketch();
        return true;
      },
    });

    this.addCommand({
      id: "promote-fabric-feature",
      name: "Promote sketched fabric to location note",
      checkCallback: (checking) => {
        const view = this.activeMapView();
        if (!view?.campaign) return false;
        if (!checking) void view.promoteFabricFeature();
        return true;
      },
    });

    this.addCommand({
      id: "test-generation-worker",
      name: "Test generation worker (smoke test)",
      callback: async () => {
        try {
          const worker = await this.getGenerationWorker();
          if (!worker) throw new Error("worker unavailable");
          const features = await worker.generate(
            "city-street",
            4181,
            { minX: 0, minY: 0, maxX: 600, maxY: 600 },
            { worldBounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 } }
          );
          this.workerLastResultValue = features;
          new Notice(`Campaign Map: worker generated ${features.length} features`);
        } catch (err) {
          this.workerLastResultValue = null;
          new Notice(`Campaign Map: worker failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
        }
      },
    });

    this.app.workspace.onLayoutReady(() => this.rescanAll());

    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("rename", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.onVaultChange(f)));
  }

  onunload(): void {
    this.workerClient?.terminate();
  }

  getCampaign(id: string): ParsedCampaign | undefined {
    return this.campaigns.get(id);
  }

  listCampaigns(): ParsedCampaign[] {
    return [...this.campaigns.values()];
  }

  getCampaignState(campaignId: string): CampaignState {
    let state = this.campaignStates.get(campaignId);
    if (!state) {
      state = { index: new LocationIndex(campaignId), invalid: new Map() };
      this.campaignStates.set(campaignId, state);
    }
    return state;
  }

  async createLocation(
    campaignId: string,
    point: [number, number],
    name: string,
    type: string,
    visibility?: Visibility
  ): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown campaign: ${campaignId}`);
    await createLocationNote(this.app, campaign, point, name, type, visibility);
  }

  async moveLocation(campaignId: string, location: ParsedLocation, newPoint: [number, number]): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown campaign: ${campaignId}`);
    await moveLocationNote(this.app, campaign, location, newPoint);
  }

  /** Canonization entry point (docs/02 §5): Point → plain note, other geometry → note + sidecar .geojson. */
  async createLocationFromFeature(
    campaignId: string,
    feature: GeoJSON.Feature,
    name: string,
    type: string
  ): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown campaign: ${campaignId}`);
    await createLocationNoteFromFeature(this.app, campaign, feature, name, type);
  }

  private async readCampaignLog(campaignId: string): Promise<LogEntry[]> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) return [];
    return readLog(this.app, campaignFolderFromConfigPath(campaign.path));
  }

  private onVaultChange(file: unknown): void {
    if (this.rescanQueued) return;
    this.rescanQueued = true;
    // Coalesce bursts (e.g. rename touching multiple cache entries) into one pass;
    // still comfortably inside the 500ms reconcile budget (docs/06 §2).
    setTimeout(() => {
      this.rescanQueued = false;
      this.rescanAll();
    }, 50);
    void file;
  }

  private rescanAll(): void {
    const start = performance.now();
    this.rescanCampaigns();
    this.rescanLocations();
    this.lastRescanMs = performance.now() - start;
  }

  private rescanCampaigns(): void {
    const files = this.app.vault.getFiles().filter((f) => f.path.endsWith(MAP_CONFIG_SUFFIX));
    const next = new Map<string, ParsedCampaign>();

    for (const file of files) {
      const name = file.basename.replace(/\.map$/, "");
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const result = parseCampaignConfig(file.path, name, frontmatter);
      if (result.ok) {
        next.set(result.campaign.id, result.campaign);
      } else {
        new Notice(
          `Campaign Map: "${name}" has invalid map config — ${result.error.issues.join("; ")}`,
          8000
        );
      }
    }

    const previous = this.campaigns;
    this.campaigns = next;
    this.syncPerCampaignCommands();

    // Push config changes (e.g. theme switch) into any open views for that campaign;
    // cheap identity check so ordinary location-only rescans don't thrash map styles.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)) {
      if (!(leaf.view instanceof MapView) || !leaf.view.campaign) continue;
      const updated = next.get(leaf.view.campaign.id);
      const before = previous.get(leaf.view.campaign.id);
      if (updated && JSON.stringify(updated.config) !== JSON.stringify(before?.config)) {
        leaf.view.setCampaign(updated);
      }
    }
  }

  private rescanLocations(): void {
    // Location notes: any markdown file with a `map:` frontmatter key that isn't a
    // campaign config note itself. Full rebuild is O(files) but fine at yes-and scale.
    const byCampaign = new Map<string, ParsedLocation[]>();
    const invalidByCampaign = new Map<string, LocationParseError[]>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.endsWith(MAP_CONFIG_SUFFIX)) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!frontmatter || typeof frontmatter.map !== "string") continue;

      const result = parseLocationNote(file.path, file.basename, frontmatter);
      if (result.ok) {
        const list = byCampaign.get(result.location.campaignId) ?? [];
        list.push(result.location);
        byCampaign.set(result.location.campaignId, list);
      } else {
        const list = invalidByCampaign.get(String(frontmatter.map)) ?? [];
        list.push(result.error);
        invalidByCampaign.set(String(frontmatter.map), list);
      }
    }

    const touchedCampaigns = new Set([...byCampaign.keys(), ...invalidByCampaign.keys(), ...this.campaignStates.keys()]);
    for (const campaignId of touchedCampaigns) {
      const state = this.getCampaignState(campaignId);
      const seen = new Set<string>();
      for (const loc of byCampaign.get(campaignId) ?? []) {
        state.index.upsert(loc);
        seen.add(loc.id);
      }
      for (const existingId of state.index.all().map((l) => l.id)) {
        if (!seen.has(existingId)) state.index.remove(existingId);
      }
      state.invalid.clear();
      for (const err of invalidByCampaign.get(campaignId) ?? []) {
        state.invalid.set(err.path, err);
      }
    }

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)) {
      if (leaf.view instanceof MapView) leaf.view.onIndexUpdated();
    }
  }

  private syncPerCampaignCommands(): void {
    for (const campaign of this.campaigns.values()) {
      const cmdId = `open-map-${campaign.id}`;
      if (this.registeredCommandIds.has(cmdId)) continue;
      this.addCommand({
        id: cmdId,
        name: `Open map: ${campaign.name}`,
        callback: () => this.openCampaign(campaign),
      });
      this.registeredCommandIds.add(cmdId);
    }
  }

  private openMapCommand(): void {
    const campaigns = this.listCampaigns();
    if (campaigns.length === 0) {
      new Notice("Campaign Map: no campaign notes found (create a *.map.md note)");
      return;
    }
    if (campaigns.length === 1) {
      this.openCampaign(campaigns[0]);
      return;
    }
    new CampaignPickerModal(this, (campaign) => this.openCampaign(campaign)).open();
  }

  private createCampaignFlow(): void {
    new CreateCampaignModal(this.app, (path) => void this.openNewlyCreatedCampaign(path)).open();
  }

  /** `vault.create()` resolving doesn't mean metadataCache has parsed the new
   * file's frontmatter yet — that lags by an event-loop tick or more via a
   * separate "changed" event. Calling rescanCampaigns() immediately raced
   * that gap and silently found no campaign to open (confirmed live: the
   * note was written correctly but nothing opened, no error). Wait for the
   * cache to actually catch up instead of assuming it already has. */
  private async openNewlyCreatedCampaign(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file && !this.app.metadataCache.getFileCache(file)?.frontmatter) {
      await new Promise<void>((resolve) => {
        const ref = this.app.metadataCache.on("changed", (f) => {
          if (f.path === path) {
            this.app.metadataCache.offref(ref);
            resolve();
          }
        });
        setTimeout(() => {
          this.app.metadataCache.offref(ref);
          resolve();
        }, 3000);
      });
    }

    this.rescanCampaigns();
    const campaign = [...this.campaigns.values()].find((c) => c.path === path);
    if (campaign) {
      void this.openCampaign(campaign);
    } else {
      console.error(`Campaign Map: created "${path}" but couldn't auto-open it — config didn't parse in time`);
      new Notice(`Campaign Map: created "${path}" — open it from the command palette (config still indexing)`, 6000);
    }
  }

  openControlPanel(): void {
    const view = this.activeMapView();
    if (!view?.campaign) {
      new Notice("Campaign Map: open a campaign map first");
      return;
    }
    new CampaignControlModal(this.app, this, view.campaign).open();
  }

  private async openCampaign(campaign: ParsedCampaign): Promise<void> {
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_MAP)
      .find((leaf) => leaf.view instanceof MapView && leaf.view.campaign?.id === campaign.id);

    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_MAP, active: true, state: { campaignId: campaign.id } });
    if (leaf.view instanceof MapView) leaf.view.setCampaign(campaign);
    this.app.workspace.revealLeaf(leaf);
  }
}

// exported for tests
export { slugify };

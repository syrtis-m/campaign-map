import { Plugin, TFile, Notice, WorkspaceLeaf, FuzzySuggestModal } from "obsidian";
import { MapView, VIEW_TYPE_MAP } from "./view/MapView";
import { parseCampaignConfig, slugify, type ParsedCampaign } from "./model/campaignConfig";
import {
  parseLocationNote,
  type ParsedLocation,
  type LocationParseError,
} from "./model/locationNote";
import { LocationIndex } from "./map/locationIndex";
import { createLocationNote, moveLocationNote } from "./vault/locationOps";
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

  // Test API surface (docs/05): app.plugins.plugins['campaign-map']
  get map(): MapView["map"] {
    return this.activeMapView()?.map ?? null;
  }
  get index(): LocationIndex | null {
    const campaignId = this.activeMapView()?.campaign?.id;
    return campaignId ? this.getCampaignState(campaignId).index : null;
  }
  get themes() {
    // Handcrafted genre themes (parchment/ink-soot/modern-clean/neon-sprawl) land Phase 2;
    // obsidian-native is generated at runtime — see src/map/theme.ts.
    return null;
  }
  get log() {
    return { read: (campaignId: string) => this.readCampaignLog(campaignId) };
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

    this.addCommand({ id: "open-map", name: "Open map", callback: () => this.openMapCommand() });

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

    this.app.workspace.onLayoutReady(() => this.rescanAll());

    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("rename", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.onVaultChange(f)));
  }

  onunload(): void {
    // Views are torn down by Obsidian; nothing else to release.
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
    type: string
  ): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown campaign: ${campaignId}`);
    await createLocationNote(this.app, campaign, point, name, type);
  }

  async moveLocation(campaignId: string, location: ParsedLocation, newPoint: [number, number]): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    if (!campaign) throw new Error(`Unknown campaign: ${campaignId}`);
    await moveLocationNote(this.app, campaign, location, newPoint);
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
    this.rescanCampaigns();
    this.rescanLocations();
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

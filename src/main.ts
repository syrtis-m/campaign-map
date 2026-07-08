import { Plugin, TFile, Notice, WorkspaceLeaf, FuzzySuggestModal } from "obsidian";
import { MapView, VIEW_TYPE_MAP } from "./view/MapView";
import { parseCampaignConfig, slugify, type ParsedCampaign } from "./model/campaignConfig";

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

export default class CampaignMapPlugin extends Plugin {
  private campaigns = new Map<string, ParsedCampaign>();
  private registeredCommandIds = new Set<string>();

  // Test API surface (docs/05): app.plugins.plugins['campaign-map']
  get map(): MapView["map"] {
    return this.activeMapView()?.map ?? null;
  }

  private activeMapView(): MapView | null {
    const active = this.app.workspace.getActiveViewOfType(MapView);
    if (active) return active;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAP)[0];
    return leaf?.view instanceof MapView ? leaf.view : null;
  }
  get index() {
    // Populated in Phase 1 (vault reconciliation → flatbush index).
    return null;
  }
  get themes() {
    // Populated in Phase 1/2 (obsidian-native + handcrafted themes).
    return null;
  }
  get log() {
    // Populated in Phase 1 (.mapcache/log.jsonl mutation log).
    return null;
  }

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_MAP, (leaf) => new MapView(leaf));

    this.addRibbonIcon("map", "Open campaign map", () => this.openMapCommand());

    this.addCommand({
      id: "open-map",
      name: "Open map",
      callback: () => this.openMapCommand(),
    });

    this.app.workspace.onLayoutReady(() => this.rescanCampaigns());

    this.registerEvent(
      this.app.vault.on("create", (f) => this.onFileChange(f))
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => this.onFileChange(f))
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.onFileChange(f))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f) => this.onFileChange(f))
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => this.onFileChange(f))
    );
  }

  onunload(): void {
    // Views are torn down by Obsidian; nothing else to release in Phase 0.
  }

  getCampaign(id: string): ParsedCampaign | undefined {
    return this.campaigns.get(id);
  }

  listCampaigns(): ParsedCampaign[] {
    return [...this.campaigns.values()];
  }

  private onFileChange(file: unknown): void {
    if (file instanceof TFile && file.path.endsWith(MAP_CONFIG_SUFFIX)) {
      this.rescanCampaigns();
    } else if (!(file instanceof TFile)) {
      // Renamed-from path (string) or other event shapes: cheap to just rescan.
      this.rescanCampaigns();
    }
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

    this.campaigns = next;
    this.syncPerCampaignCommands();
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

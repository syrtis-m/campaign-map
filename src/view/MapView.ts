import { ItemView, WorkspaceLeaf, ViewStateResult } from "obsidian";
import maplibregl, { Map as MapLibreMap } from "maplibre-gl";
import type { ParsedCampaign } from "../model/campaignConfig";
import { blankWorldStyle } from "../map/style";
import { computeScaleBar, defaultFictionalBounds } from "../map/fictionalCRS";

export const VIEW_TYPE_MAP = "campaign-map-view";

interface MapViewState extends Record<string, unknown> {
  campaignId?: string;
}

export class MapView extends ItemView {
  map: MapLibreMap | null = null;
  campaign: ParsedCampaign | null = null;
  private mapContainer!: HTMLDivElement;
  private scaleBarEl!: HTMLDivElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
      const plugin = (this.app as unknown as { plugins: { plugins: Record<string, unknown> } })
        .plugins.plugins["campaign-map"] as { getCampaign?: (id: string) => ParsedCampaign | undefined } | undefined;
      const campaign = plugin?.getCampaign?.(campaignId);
      if (campaign) this.setCampaign(campaign);
    }
    return super.setState(state, result);
  }

  getState(): MapViewState {
    return { campaignId: this.campaign?.id };
  }

  setCampaign(campaign: ParsedCampaign): void {
    this.campaign = campaign;
    this.refreshHeaderTitle();
    if (this.map) this.applyCampaign();
  }

  private refreshHeaderTitle(): void {
    // Obsidian snapshots getDisplayText() when the tab/header DOM is first built and
    // doesn't re-query it on setState/updateHeader(); patch both title nodes directly.
    // tabHeaderInnerTitleEl is undocumented but stable (used by many community plugins).
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

    this.map = new maplibregl.Map({
      container: this.mapContainer,
      style: blankWorldStyle(),
      center: [0, 0],
      zoom: 3,
      attributionControl: false,
      // fake CRS: no world wraparound past the fictional box
      renderWorldCopies: false,
    });

    this.map.on("load", () => {
      if (this.campaign) this.applyCampaign();
      this.updateScaleBar();
    });
    this.map.on("move", () => this.updateScaleBar());
    this.map.on("zoom", () => this.updateScaleBar());

    this.resizeObserver = new ResizeObserver(() => this.map?.resize());
    this.resizeObserver.observe(this.mapContainer);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.map?.remove();
    this.map = null;
  }

  private applyCampaign(): void {
    if (!this.map || !this.campaign) return;
    const { config } = this.campaign;
    const bounds =
      config.crs === "fictional" ? config.bounds ?? defaultFictionalBounds() : undefined;
    if (bounds) {
      this.map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 40, animate: false }
      );
    }
  }

  private updateScaleBar(): void {
    if (!this.map || !this.campaign) return;
    const { widthPx, label } = computeScaleBar(
      this.map.getZoom(),
      this.campaign.config.scaleMetersPerUnit,
      120
    );
    this.scaleBarEl.setText(label);
    this.scaleBarEl.style.width = `${Math.max(20, widthPx)}px`;
  }
}

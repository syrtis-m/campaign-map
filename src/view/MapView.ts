import { ItemView, WorkspaceLeaf, ViewStateResult, Menu, MarkdownRenderer, Notice, TFile } from "obsidian";
import maplibregl, { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import type { ParsedCampaign } from "../model/campaignConfig";
import type { ParsedLocation } from "../model/locationNote";
import { computeScaleBar, defaultFictionalBounds } from "../map/fictionalCRS";
import { obsidianNativeStyle, readObsidianCssTokens } from "../map/theme";
import { glyphsUrlTemplate, createTransformRequest } from "../map/glyphs";
import { registerVaultBasemap, vaultBasemapBounds } from "../map/pmtilesVaultProtocol";
import { buildThemeStyle, isHandcraftedTheme, HANDCRAFTED_THEMES } from "../map/themes";
import { genreForCampaign } from "../gen/naming/cultures";
import { cultureAt } from "../gen/naming/regions";
import { generateCityStreets, generateDistricts, generateCityBlocks } from "../gen/city";
import { generateWorldRegions, generateSettlements, generateRoutes } from "../gen/world";
import { tileXYForPoint } from "../gen/cache/tileGrid";
import type { BBox } from "../gen/spatialHash";
import { generateTile, regenerateTile, canonizeFeature, type GenerationContext } from "../map/generation/generationService";
import { QuickAddModal } from "./QuickAddModal";
import { LocationSearchModal } from "./LocationSearchModal";
import { ThemeSwitcherModal } from "./ThemeSwitcherModal";
import type CampaignMapPlugin from "../main";

export const VIEW_TYPE_MAP = "campaign-map-view";

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
  private generatedFeatures: GeoJSON.Feature[] = [];

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
    if (this.campaign && this.campaign.id !== campaign.id) this.generatedFeatures = [];
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
      if (this.campaign) this.applyCampaign();
      this.refreshSource();
      this.updateScaleBar();
    });
    this.map.on("move", () => this.updateScaleBar());
    this.map.on("zoom", () => this.updateScaleBar());
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

  async onClose(): Promise<void> {
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
    const culture = cultureAt(config.seed, point[0], point[1], worldBounds, genre);
    new QuickAddModal(this.app, culture, this.campaign.config.seed, ({ name, type }) => {
      void this.plugin.createLocation(this.campaign!.id, point, name, type);
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

  /** `this.generatedFeatures` stays in generation-space (meters) — the same
   * space the cache keys tiles in — and is only converted to the campaign's
   * display units when handed to MapLibre. */
  private mergeGeneratedFeatures(newFeatures: GeoJSON.Feature[]): void {
    const byId = new Map(this.generatedFeatures.map((f) => [f.id, f]));
    for (const f of newFeatures) byId.set(f.id, f);
    this.generatedFeatures = [...byId.values()];
    this.refreshGeneratedSource();
  }

  private refreshGeneratedSource(): void {
    if (!this.map || !this.campaign) return;
    const source = this.map.getSource("generated") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const scale = this.campaign.config.scaleMetersPerUnit;
    const display = this.generatedFeatures.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
    source.setData({ type: "FeatureCollection", features: display });
  }

  /** Display-space (fictional units) — matches what's actually rendered/queryable on the map. */
  get generated(): GeoJSON.Feature[] {
    if (!this.campaign) return this.generatedFeatures;
    const scale = this.campaign.config.scaleMetersPerUnit;
    return this.generatedFeatures.map((f) => transformFeatureUnits(f, (n) => metersToUnits(n, scale)));
  }

  private mapCenterUnits(): [number, number] {
    const { lng, lat } = this.map!.getCenter();
    return [lng, lat];
  }

  /** "Generate city fabric here" (docs/03 3b/3d) — streets/districts/blocks
   * for the tile at `point` (display-space; defaults to the map center).
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
    this.mergeGeneratedFeatures(newFeatures);
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
    this.mergeGeneratedFeatures(newFeatures);
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
    for (const f of this.generatedFeatures) {
      if (f.geometry.type !== "Point") continue;
      const [fx, fy] = f.geometry.coordinates as [number, number];
      const d = Math.hypot(fx - atMeters[0], fy - atMeters[1]);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    if (!best || bestDist > maxDistanceMeters) return false;

    const props = (best.properties ?? {}) as Record<string, unknown>;
    const name = String(props.name ?? "Unnamed");
    const type = String(props.type ?? "custom");
    const noteFeature = transformFeatureUnits(best, (n) => metersToUnits(n, scale));
    await canonizeFeature(this.generationContext(), this.plugin, best, name, type, noteFeature);
    this.generatedFeatures = this.generatedFeatures.filter((f) => f.id !== best!.id);
    this.refreshGeneratedSource();
    return true;
  }

  private applyCampaign(): void {
    if (!this.map || !this.campaign) return;
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

  private handleClick(e: MapMouseEvent): void {
    if (!this.map || !this.campaign) return;
    const features = this.map.queryRenderedFeatures(e.point, { layers: ["canon-point"] });
    if (features.length > 0) {
      this.showPlaceCard(features[0]);
    } else {
      this.showDroppedPin(e.lngLat);
    }
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
    const feature = this.map.queryRenderedFeatures(e.point, { layers: ["canon-point"] })[0];
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
    actions.createEl("button", { text: "Open note" }).onclick = () => {
      if (file instanceof TFile) void this.app.workspace.getLeaf("split").openFile(file);
    };
    actions.createEl("button", { text: "Edit" }).onclick = () => {
      if (file instanceof TFile) void this.app.workspace.getLeaf("split").openFile(file, { eState: { focus: true } });
    };
    actions.createEl("button", { text: "Center" }).onclick = () => {
      if (location.point) this.map?.flyTo({ center: location.point });
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

  private pulseFeature(loc: ParsedLocation): void {
    if (!this.map || !loc.point) return;
    const el = document.createElement("div");
    el.addClass("campaign-map-pulse");
    const marker = new maplibregl.Marker({ element: el }).setLngLat(loc.point).addTo(this.map);
    setTimeout(() => marker.remove(), 900);
  }
}

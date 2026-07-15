import { App, Modal, Notice, Setting } from "obsidian";
import type CampaignMapPlugin from "../main";
import type { MapView } from "./MapView";
import type { ParsedCampaign } from "../model/campaignConfig";
import { THEME_IDS } from "../model/campaignConfig";
import { genreForCampaign, culturesForGenre } from "../gen/naming/cultures";

/**
 * Single discoverable entry point for everything that previously had no UI at
 * all (Jonah: "how do i ... change themes of a map, etc? no UIUX right now" /
 * "how do i change what the naming generator is doing"): theme, naming
 * culture selection, basemap status/acquisition, plus the occasional/heavy
 * "Generate & export" actions moved off the on-map toolbar. All in
 * one place. Reachable via the "settings" ribbon icon or the campaign-settings
 * command.
 */
export class CampaignControlModal extends Modal {
  constructor(
    app: App,
    private plugin: CampaignMapPlugin,
    private campaign: ParsedCampaign,
    private view: MapView
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Campaign settings — ${this.campaign.name}` });

    this.renderGenerateAndExport(contentEl);
    this.renderTheme(contentEl);
    this.renderNamingCultures(contentEl);
    if (this.campaign.config.crs === "real") this.renderBasemap(contentEl);
  }

  /**
   * Occasional/heavy builder actions relocated from the on-map toolbar (plan
   * 018) so the map surface stays clean and fast to read. "Generate fabric
   * here" stays viewport-relative: it calls the same MapView method the
   * toolbar did, which reads the live map center / zoom — the modal is just a
   * new trigger, the "here" semantics are unchanged. Every action here is
   * also on the command palette.
   */
  private renderGenerateAndExport(root: HTMLElement): void {
    new Setting(root).setName("Generate & export").setHeading();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "Occasional/heavy actions. Generate acts on the current map center and zoom (position the view first). All are also in the command palette.",
    });

    new Setting(root)
      .setName("Generate fabric here")
      .setDesc("Paints procedural fabric around the map center — world or city tier, chosen from the current zoom. Durable: the area repaints on every open until cleared.")
      .addButton((btn) =>
        btn.setButtonText("Generate").onClick(() => {
          void this.view.generateFabricHere();
          this.close();
        })
      );

    new Setting(root)
      .setName("Regenerate fabric here")
      .setDesc("Re-runs generation at the map center against current constraints (locations + sketched fabric).")
      .addButton((btn) =>
        btn.setButtonText("Regenerate").onClick(() => {
          void this.view.regenerateFabricHere();
          this.close();
        })
      );

    new Setting(root)
      .setName("Clear generated fabric")
      .setDesc("Remove generated fabric at the map center, or all of it. Sketched fabric and locations are never touched.")
      .addButton((btn) =>
        btn.setButtonText("Clear here").onClick(() => {
          void this.view.clearGeneratedHere();
          this.close();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Clear all").onClick(() => {
          void this.view.clearAllGenerated();
          this.close();
        })
      );

    new Setting(root)
      .setName("Export map poster")
      .setDesc("High-res PNG of the current view.")
      .addButton((btn) =>
        btn.setButtonText("Export poster").onClick(() => {
          void this.view.exportPoster();
          this.close();
        })
      );

    new Setting(root)
      .setName("Export campaign atlas (PDF)")
      .setDesc("Map renders plus your location notes as a gazetteer.")
      .addButton((btn) =>
        btn.setButtonText("Export atlas").onClick(() => {
          void this.view.exportAtlas();
          this.close();
        })
      );
  }

  private file() {
    return this.app.vault.getFileByPath(this.campaign.path);
  }

  private renderTheme(root: HTMLElement): void {
    new Setting(root)
      .setName("Theme")
      .setHeading();
    new Setting(root).setName("Map theme").addDropdown((dropdown) => {
      for (const t of THEME_IDS) dropdown.addOption(t, t);
      dropdown.setValue(this.campaign.config.theme);
      dropdown.onChange((v) => {
        const file = this.file();
        if (!file) return;
        void this.app.fileManager.processFrontMatter(file, (fm) => {
          fm.theme = v;
        });
      });
    });
  }

  private renderNamingCultures(root: HTMLElement): void {
    new Setting(root).setName("Naming cultures").setHeading();
    const genre = genreForCampaign(this.campaign.config.crs, this.campaign.config.theme);
    const allForGenre = culturesForGenre(genre);
    const configured = this.campaign.config.namingCultures;
    const active = new Set(configured && configured.length > 0 ? configured : allForGenre.map((c) => c.id));

    root.createEl("p", {
      cls: "setting-item-description",
      text: `Genre "${genre}" (derived from world type + theme). Uncheck a culture to stop it generating new names — existing canon notes are never touched.`,
    });

    for (const culture of allForGenre) {
      new Setting(root).setName(culture.id).addToggle((toggle) => {
        toggle.setValue(active.has(culture.id));
        toggle.onChange((checked) => {
          if (checked) {
            active.add(culture.id);
          } else if (active.size > 1) {
            active.delete(culture.id);
          } else {
            // Never let the campaign end up with zero active cultures — revert
            // the toggle rather than silently falling back (culturesForGenre
            // does fall back safely, but a UI that visibly shows "all
            // unchecked" while secretly using all cultures is worse).
            toggle.setValue(true);
            new Notice("Campaign Map: at least one naming culture must stay active");
            return;
          }
          this.writeNamingCultures(active, allForGenre);
        });
      });
    }
  }

  private writeNamingCultures(active: Set<string>, allForGenre: { id: string }[]): void {
    const file = this.file();
    if (!file) return;
    const allIds = allForGenre.map((c) => c.id);
    const isFullSet = active.size === allIds.length;
    void this.app.fileManager.processFrontMatter(file, (fm) => {
      // Omit the field entirely when it's the full set — keeps frontmatter
      // minimal (CLAUDE.md convention) and matches the "unset = default" rule
      // culturesForGenre already implements.
      if (isFullSet) delete fm.namingCultures;
      else fm.namingCultures = [...active];
    });
  }

  private renderBasemap(root: HTMLElement): void {
    new Setting(root).setName("Basemap").setHeading();
    const current = this.campaign.config.basemap;
    root.createEl("p", {
      cls: "setting-item-description",
      text: current ? `Attached: ${current}` : "No basemap attached — the map will render without real-world tiles.",
    });

    const pmtilesFiles = this.app.vault.getFiles().filter((f) => f.extension === "pmtiles");
    new Setting(root)
      .setName("Attach a .pmtiles file already in the vault")
      .setDesc(pmtilesFiles.length === 0 ? "None found in the vault yet." : "")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "— none —");
        for (const f of pmtilesFiles) dropdown.addOption(f.path, f.path);
        dropdown.setValue(current ?? "");
        dropdown.setDisabled(pmtilesFiles.length === 0);
        dropdown.onChange((v) => {
          const file = this.file();
          if (!file) return;
          void this.app.fileManager.processFrontMatter(file, (fm) => {
            if (v) fm.basemap = v;
            else delete fm.basemap;
          });
        });
      });

    this.renderBasemapDownloadHelper(root);
  }

  /**
   * Not a one-click download: cutting a PMTiles extract requires the
   * `pmtiles extract` CLI (a compiled Go binary — no pure-JS/npm equivalent
   * exists for writing PMTiles, only reading, see node_modules/pmtiles). Auto-
   * downloading and executing an external binary from inside the plugin is
   * exactly the risk category Jonah required explicit sign-off for last time
   * (DECISIONS.md, 2026-07-08) and conflicts with the locked "Vault/DataAdapter
   * APIs only, never Node fs" architecture. So this generates the correct
   * command for Jonah to run himself, same as the London basemap was cut,
   * instead of running it automatically.
   */
  private renderBasemapDownloadHelper(root: HTMLElement): void {
    new Setting(root).setName("Get a basemap extract").setHeading();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "Generates a pmtiles extract command for a bounding box, using Protomaps' daily build. Run it yourself in a terminal (requires the pmtiles CLI: github.com/protomaps/go-pmtiles) — the plugin never downloads or executes external binaries.",
    });

    const bounds = this.plugin.map?.getBounds();
    let west = bounds ? bounds.getWest() : -0.2;
    let south = bounds ? bounds.getSouth() : 51.46;
    let east = bounds ? bounds.getEast() : -0.05;
    let north = bounds ? bounds.getNorth() : 51.54;

    const commandEl = root.createEl("code", { cls: "campaign-map-basemap-command" });
    commandEl.style.display = "block";
    commandEl.style.whiteSpace = "pre-wrap";
    commandEl.style.userSelect = "all";
    commandEl.style.margin = "0.5em 0";

    const campaignFolder = this.campaign.path.slice(0, this.campaign.path.lastIndexOf("/"));
    const today = new Date();
    const buildDate = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(today.getUTCDate()).padStart(2, "0")}`;

    const renderCommand = () => {
      commandEl.setText(
        `pmtiles extract https://build.protomaps.com/${buildDate}.pmtiles ${campaignFolder}/basemap.pmtiles --bbox=${west},${south},${east},${north}`
      );
    };
    renderCommand();

    const bboxSetting = new Setting(root).setName("Bounding box (west, south, east, north)");
    for (const [label, get, set] of [
      ["west", () => west, (v: number) => (west = v)],
      ["south", () => south, (v: number) => (south = v)],
      ["east", () => east, (v: number) => (east = v)],
      ["north", () => north, (v: number) => (north = v)],
    ] as const) {
      bboxSetting.addText((text) => {
        text.setPlaceholder(label).setValue(String(get()));
        text.inputEl.style.width = "5.5em";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) {
            set(n);
            renderCommand();
          }
        });
      });
    }
    if (!bounds) {
      root.createEl("p", {
        cls: "setting-item-description",
        text: "(Defaulted to central London — open the map and position the view before opening this panel to prefill your current viewport instead.)",
      });
    }

    new Setting(root).addButton((btn) =>
      btn.setButtonText("Copy command").onClick(() => {
        void navigator.clipboard.writeText(commandEl.textContent ?? "");
        new Notice("Campaign Map: command copied");
      })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

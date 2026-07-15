import { App, Modal, Notice, Setting } from "obsidian";
import type CampaignMapPlugin from "../main";
import type { MapView } from "./MapView";
import type { ParsedCampaign } from "../model/campaignConfig";
import { THEME_IDS } from "../model/campaignConfig";
import { genreForCampaign, culturesForGenre } from "../gen/naming/cultures";
import { normalizeTerrainBlock, terrainBlockOrDefaults } from "./terrainSettings";

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
    this.renderUnderlay(contentEl);
    if (this.campaign.config.crs === "fictional") this.renderBaseTerrain(contentEl);
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

  /**
   * Base terrain (plan 036-D): the campaign-wide elevation base that the DEM
   * (hillshade + 3D) and terrain-reading generators compose over. Edited behind
   * an EXPLICIT Apply (never a live slider): a base-param change re-derives every
   * DEM tile — a real cost the notice names. Fictional campaigns only (the DEM
   * source is fictional-only). All-default ⇒ the frontmatter key is omitted.
   */
  private renderBaseTerrain(root: HTMLElement): void {
    new Setting(root).setName("Base terrain").setHeading();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "The campaign-wide elevation base under your mountains/relief. Apply is explicit: changing it re-derives every terrain tile (hillshade + 3D). Leave at 0 for a flat base.",
    });

    const current = terrainBlockOrDefaults(this.campaign.config.terrain);
    const draft = { ...current };

    new Setting(root)
      .setName("Continental amplitude (m)")
      .setDesc("Broad continental relief added under everything. 0 = flat base.")
      .addText((text) => {
        text.setValue(String(draft.campAmp));
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) draft.campAmp = Math.max(0, n);
        });
      });

    new Setting(root)
      .setName("Sea datum (m)")
      .setDesc("Sea-level height for the flat base and the `sea` landform target.")
      .addText((text) => {
        text.setValue(String(draft.seaDatum));
        text.inputEl.type = "number";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) draft.seaDatum = n;
        });
      });

    new Setting(root)
      .setName("City-site grading")
      .setDesc("Level each district's interior toward its center elevation (per-district opt-in still required).")
      .addToggle((toggle) => {
        toggle.setValue(draft.grade);
        toggle.onChange((v) => (draft.grade = v));
      });

    new Setting(root)
      .setName("Apply base terrain")
      .setDesc("Persists these values and re-derives the elevation surface.")
      .addButton((btn) =>
        btn
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            void this.view.applyTerrainSettings(normalizeTerrainBlock(draft));
            this.close();
          })
      );
  }

  /**
   * Reference-image underlay (plan 041 "trace mode"): attach a positioned raster
   * the GM traces the reference map onto. The image is read through the
   * DataAdapter (never Node fs); corners are two anchor points (SW/NE) in display
   * units. Opacity is a LIVE slider (display-only, no regen — ratified fine);
   * everything else persists on Apply, which restyles to splice the layer in below
   * all fabric. Available for both fictional and real campaigns.
   */
  private renderUnderlay(root: HTMLElement): void {
    new Setting(root).setName("Reference underlay").setHeading();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "Drop an image in the vault and place it under the fabric to trace a reference map's coastline, ridges, and regions. Display-only — it never generates anything. Give a vault-relative image path and two corners (south-west, north-east) in map units.",
    });

    const current = this.campaign.config.underlay;
    // Seed corners from the current viewport if there's no underlay yet (a sensible
    // "drop it over what I'm looking at"), else from the persisted placement.
    const bounds = this.plugin.map?.getBounds();
    const draft = {
      image: current?.image ?? "",
      sw: current?.sw ?? ([bounds ? bounds.getWest() : 0, bounds ? bounds.getSouth() : 0] as [number, number]),
      ne: current?.ne ?? ([bounds ? bounds.getEast() : 1, bounds ? bounds.getNorth() : 1] as [number, number]),
      opacity: current?.opacity ?? 0.6,
      visible: current?.visible ?? true,
    };

    new Setting(root)
      .setName("Image (vault-relative path)")
      .setDesc("e.g. Campaigns/Cradle/reference.png — the file must already be in the vault.")
      .addText((text) => {
        text.setPlaceholder("Campaigns/…/reference.png").setValue(draft.image);
        text.onChange((v) => (draft.image = v.trim()));
      });

    const corner = (label: string, get: () => number, set: (n: number) => void) =>
      new Setting(root).setName(label).addText((text) => {
        text.setValue(String(get()));
        text.inputEl.type = "number";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) set(n);
        });
      });
    corner("SW corner — X (min longitude)", () => draft.sw[0], (n) => (draft.sw[0] = n));
    corner("SW corner — Y (min latitude)", () => draft.sw[1], (n) => (draft.sw[1] = n));
    corner("NE corner — X (max longitude)", () => draft.ne[0], (n) => (draft.ne[0] = n));
    corner("NE corner — Y (max latitude)", () => draft.ne[1], (n) => (draft.ne[1] = n));

    new Setting(root)
      .setName("Opacity")
      .setDesc("Live — dims the reference so the fabric you trace stays legible.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 1, 0.05)
          .setValue(draft.opacity)
          .setDynamicTooltip()
          .onChange((v) => {
            draft.opacity = v;
            this.view.setUnderlayOpacityLive(v); // display-only feedback
          });
      });

    new Setting(root)
      .setName("Visible")
      .addToggle((toggle) => {
        toggle.setValue(draft.visible);
        toggle.onChange((v) => (draft.visible = v));
      });

    new Setting(root)
      .setName("Apply / remove reference")
      .setDesc("Apply persists the placement and restyles; Remove detaches it.")
      .addButton((btn) =>
        btn
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            if (!draft.image) {
              new Notice("Campaign Map: enter a vault-relative image path first.");
              return;
            }
            if (!this.app.vault.getFileByPath(draft.image)) {
              new Notice(`Campaign Map: no vault file at "${draft.image}".`);
              return;
            }
            void this.view.applyUnderlay({
              image: draft.image,
              sw: [draft.sw[0], draft.sw[1]],
              ne: [draft.ne[0], draft.ne[1]],
              opacity: draft.opacity,
              visible: draft.visible,
            });
            this.close();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Remove").onClick(() => {
          void this.view.applyUnderlay(undefined);
          this.close();
        })
      );
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

import { App, Modal, Notice, Setting } from "obsidian";
import { THEME_IDS } from "../model/campaignConfig";
import type { CampaignConfig } from "../model/campaignConfig";
import { createCampaignNote, DEFAULT_FICTIONAL_BOUNDS } from "../vault/campaignOps";
import { normalizeTerrainBlock, TERRAIN_DEFAULTS, type TerrainBlock } from "./terrainSettings";

/** Named scale presets (meters per fake map unit) + a Custom escape hatch.
 * Scale is creation-only (it re-anchors every stored coordinate), so it MUST
 * be settable here — there is no later UI for it (ratified: NOT-A-GAP only
 * because it lives at creation). Vailmarch uses 500 (1 unit = 500 m). */
const SCALE_PRESETS: { label: string; value: number }[] = [
  { label: "1 m / unit (1:1)", value: 1 },
  { label: "100 m / unit (city block)", value: 100 },
  { label: "500 m / unit (region / march)", value: 500 },
  { label: "1 km / unit (world overview)", value: 1000 },
];

type StarterTemplate = "blank" | "terrain-native";

/** Continental amplitude the terrain-native starter seeds (m). A gentle rolling
 * base — the GM adds dramatic relief via sketched stamps later. */
const TERRAIN_STARTER_CAMP_AMP = 150;

/** The campaign-creation entry point that didn't exist before (Jonah: "how do
 * i create a new map... no UIUX right now") — until now the only way in was
 * hand-authoring a *.map.md note with the right frontmatter from memory. Now
 * covers the full creation surface: name, world type, scale, theme, seed
 * (re-rollable), and an optional base-terrain block (fictional). */
export class CreateCampaignModal extends Modal {
  private name = "";
  private template: StarterTemplate = "blank";
  private crs: CampaignConfig["crs"] = "fictional";
  private theme: CampaignConfig["theme"] = "obsidian-native";
  private seed = randomSeed();
  private scalePreset: number | "custom" = 1;
  private scaleMetersPerUnit = 1;
  private terrain: TerrainBlock = { ...TERRAIN_DEFAULTS };

  private seedInput?: HTMLInputElement;
  private customScaleSetting?: Setting;
  private terrainSection?: HTMLElement;
  private boundsNotice?: HTMLElement;

  constructor(
    app: App,
    private onCreated: (path: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Create new campaign" });

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setPlaceholder("My Campaign").onChange((v) => (this.name = v));
      text.inputEl.focus();
    });

    new Setting(contentEl)
      .setName("Starter template")
      .setDesc("Blank: inert flat base. Terrain-native: a gentle continental base turned on, ready for sketched relief (the showcase idiom).")
      .addDropdown((dropdown) => {
        dropdown.addOption("blank", "Blank");
        dropdown.addOption("terrain-native", "Terrain-native starter");
        dropdown.setValue(this.template);
        dropdown.onChange((v) => {
          this.template = v as StarterTemplate;
          this.applyTemplate();
        });
      });

    new Setting(contentEl)
      .setName("World type")
      .setDesc("Fictional: fake bounded coordinate space. Real: attach a real-city basemap after creating.")
      .addDropdown((dropdown) => {
        dropdown.addOption("fictional", "Fictional");
        dropdown.addOption("real", "Real city");
        dropdown.setValue(this.crs);
        dropdown.onChange((v) => {
          this.crs = v as CampaignConfig["crs"];
          this.renderCrsVisibility();
        });
      });

    new Setting(contentEl)
      .setName("Scale")
      .setDesc("Meters per map unit — sets the physical size of your world. Creation-only.")
      .addDropdown((dropdown) => {
        for (const p of SCALE_PRESETS) dropdown.addOption(String(p.value), p.label);
        dropdown.addOption("custom", "Custom…");
        dropdown.setValue(String(this.scalePreset));
        dropdown.onChange((v) => {
          if (v === "custom") {
            this.scalePreset = "custom";
          } else {
            this.scalePreset = Number(v);
            this.scaleMetersPerUnit = Number(v);
          }
          this.renderScaleVisibility();
        });
      });

    this.customScaleSetting = new Setting(contentEl)
      .setName("Custom scale (m / unit)")
      .addText((text) => {
        text.setValue(String(this.scaleMetersPerUnit));
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n) && n > 0) this.scaleMetersPerUnit = n;
        });
      });

    new Setting(contentEl).setName("Theme").addDropdown((dropdown) => {
      for (const t of THEME_IDS) dropdown.addOption(t, t);
      dropdown.setValue(this.theme);
      dropdown.onChange((v) => (this.theme = v as CampaignConfig["theme"]));
    });

    new Setting(contentEl)
      .setName("Seed")
      .setDesc("Determines all procedurally generated fabric — same seed always generates the same map.")
      .addText((text) => {
        this.seedInput = text.inputEl;
        text.setValue(String(this.seed)).onChange((v) => {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) this.seed = n;
        });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("dice")
          .setTooltip("Re-roll")
          .onClick(() => {
            this.seed = randomSeed();
            if (this.seedInput) this.seedInput.value = String(this.seed);
          })
      );

    this.terrainSection = contentEl.createDiv();
    this.renderTerrainSection();

    this.boundsNotice = contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Fictional campaigns start with a default ${DEFAULT_FICTIONAL_BOUNDS.join(", ")} bounded world — edit "bounds" in the note's frontmatter later to resize.`,
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create")
        .setCta()
        .onClick(() => void this.submit())
    );

    this.renderScaleVisibility();
    this.renderCrsVisibility();
  }

  /** The terrain draft + its live controls follow the starter-template choice. */
  private applyTemplate(): void {
    this.terrain =
      this.template === "terrain-native"
        ? { campAmp: TERRAIN_STARTER_CAMP_AMP, seaDatum: 0, grade: false }
        : { ...TERRAIN_DEFAULTS };
    this.renderTerrainSection();
  }

  /**
   * Optional base-terrain block, mirroring the campaign-settings modal's curated
   * labels (not schema-driven — the three fields need units/wording the generic
   * humanizer can't give, and the block is small). Fictional CRS only (the DEM
   * source is fictional-only). Defaults inert: a blank template leaves 0/0/off,
   * which `normalizeTerrainBlock` drops entirely at write time.
   */
  private renderTerrainSection(): void {
    const root = this.terrainSection;
    if (!root) return;
    root.empty();
    if (this.crs !== "fictional") return;

    new Setting(root).setName("Base terrain (optional)").setHeading();
    root.createEl("p", {
      cls: "setting-item-description",
      text: "The campaign-wide elevation base under your sketched relief. Leave at 0 for a flat, inert base (nothing generated). Adjustable later in campaign settings — but changing it then re-derives every terrain tile.",
    });

    new Setting(root)
      .setName("Continental amplitude (m)")
      .setDesc("Broad continental relief added under everything. 0 = flat base.")
      .addText((text) => {
        text.setValue(String(this.terrain.campAmp));
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) this.terrain.campAmp = Math.max(0, n);
        });
      });

    new Setting(root)
      .setName("Sea datum (m)")
      .setDesc("Sea-level height for the flat base and the `sea` landform target.")
      .addText((text) => {
        text.setValue(String(this.terrain.seaDatum));
        text.inputEl.type = "number";
        text.onChange((v) => {
          const n = Number.parseFloat(v);
          if (Number.isFinite(n)) this.terrain.seaDatum = n;
        });
      });

    new Setting(root)
      .setName("City-site grading")
      .setDesc("Level each district's interior toward its center elevation (per-district opt-in still required).")
      .addToggle((toggle) => {
        toggle.setValue(this.terrain.grade);
        toggle.onChange((v) => (this.terrain.grade = v));
      });
  }

  private renderScaleVisibility(): void {
    this.customScaleSetting?.settingEl.toggle(this.scalePreset === "custom");
  }

  private renderCrsVisibility(): void {
    const fictional = this.crs === "fictional";
    if (this.boundsNotice) this.boundsNotice.style.display = fictional ? "" : "none";
    this.renderTerrainSection();
  }

  private async submit(): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      new Notice("Campaign Map: name is required");
      return;
    }
    if (!(this.scaleMetersPerUnit > 0)) {
      new Notice("Campaign Map: scale must be a positive number");
      return;
    }
    try {
      const result = await createCampaignNote(this.app, {
        name,
        crs: this.crs,
        theme: this.theme,
        seed: this.seed,
        scaleMetersPerUnit: this.scaleMetersPerUnit,
        bounds: this.crs === "fictional" ? DEFAULT_FICTIONAL_BOUNDS : undefined,
        terrain: this.crs === "fictional" ? normalizeTerrainBlock(this.terrain) : undefined,
      });
      this.close();
      new Notice(`Campaign Map: created "${name}"`);
      this.onCreated(result.path);
    } catch (err) {
      // console.error too, not just the Notice — Notices auto-dismiss and
      // leave no trace, which made a real failure unreproducible during
      // live verification of this exact flow.
      console.error("Campaign Map: campaign creation failed", err);
      new Notice(`Campaign Map: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

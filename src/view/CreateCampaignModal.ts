import { App, Modal, Notice, Setting } from "obsidian";
import { THEME_IDS } from "../model/campaignConfig";
import type { CampaignConfig } from "../model/campaignConfig";
import { createCampaignNote } from "../vault/campaignOps";

const DEFAULT_FICTIONAL_BOUNDS: [number, number, number, number] = [-8, -6, 8, 6];

/** The campaign-creation entry point that didn't exist before (Jonah: "how do
 * i create a new map... no UIUX right now") — until now the only way in was
 * hand-authoring a *.map.md note with the right frontmatter from memory. */
export class CreateCampaignModal extends Modal {
  private name = "";
  private crs: CampaignConfig["crs"] = "fictional";
  private theme: CampaignConfig["theme"] = "obsidian-native";
  private seed = Math.floor(Math.random() * 1_000_000);
  private scaleMetersPerUnit = 1;

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

    let nameInput: HTMLInputElement;
    new Setting(contentEl).setName("Name").addText((text) => {
      nameInput = text.inputEl;
      text.setPlaceholder("My Campaign").onChange((v) => (this.name = v));
      text.inputEl.focus();
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
          renderBoundsVisibility();
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
        text.setValue(String(this.seed)).onChange((v) => {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n)) this.seed = n;
        });
      });

    const boundsNotice = contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Fictional campaigns start with a default ${DEFAULT_FICTIONAL_BOUNDS.join(", ")} bounded world — edit "bounds" in the note's frontmatter later to resize.`,
    });
    const renderBoundsVisibility = () => {
      boundsNotice.style.display = this.crs === "fictional" ? "" : "none";
    };
    renderBoundsVisibility();

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create")
        .setCta()
        .onClick(() => void this.submit())
    );
  }

  private async submit(): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      new Notice("Campaign Map: name is required");
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

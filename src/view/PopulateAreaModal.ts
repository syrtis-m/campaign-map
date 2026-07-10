import { App, Modal, Setting } from "obsidian";
import { LOCATION_TYPES } from "../model/locationNote";

export interface PopulateAreaResult {
  type: string;
  count: number;
}

const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 20;

/**
 * Phase 5 "populate this district with N shops" (docs/03), offline and
 * deterministic (plan 010): just a type + count, no LLM/API. Modeled on
 * QuickAddModal.
 */
export class PopulateAreaModal extends Modal {
  private type = "shop/tavern/venue";
  private count = DEFAULT_COUNT;

  constructor(
    app: App,
    private onSubmit: (result: PopulateAreaResult) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Populate area" });

    new Setting(contentEl).setName("Type").addDropdown((dropdown) => {
      for (const t of LOCATION_TYPES) dropdown.addOption(t, t);
      dropdown.setValue(this.type);
      dropdown.onChange((v) => (this.type = v));
    });

    new Setting(contentEl).setName("Count").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(MIN_COUNT);
      text.inputEl.max = String(MAX_COUNT);
      text.setValue(String(this.count));
      text.onChange((v) => {
        const n = Number.parseInt(v, 10);
        if (!Number.isNaN(n)) this.count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
      });
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Populate")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({ type: this.type, count: this.count });
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

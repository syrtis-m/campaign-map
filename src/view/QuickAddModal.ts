import { App, Modal, Setting } from "obsidian";
import { LOCATION_TYPES } from "../model/locationNote";
import { generateNameSuggestions } from "../gen/naming/culture";
import type { NamingCulture } from "../gen/naming/culture";

export interface QuickAddResult {
  name: string;
  type: string;
}

/**
 * The ≤5s yes-and flow (architecture §3b): name + type, with 3 culture-consistent
 * suggestions offered up front (tab/click to accept — faster than typing).
 */
export class QuickAddModal extends Modal {
  private name = "";
  private type = "custom";

  constructor(
    app: App,
    private culture: NamingCulture,
    private seed: number,
    private onSubmit: (result: QuickAddResult) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Add location here" });

    const suggestions = generateNameSuggestions(this.seed, this.culture, 3, Date.now());

    let nameInput: HTMLInputElement;
    new Setting(contentEl).setName("Name").addText((text) => {
      nameInput = text.inputEl;
      text.setPlaceholder(suggestions[0] ?? "Name").onChange((v) => (this.name = v));
      text.inputEl.focus();
    });

    const suggestionsEl = contentEl.createDiv({ cls: "campaign-map-quickadd-suggestions" });
    for (const suggestion of suggestions) {
      const btn = suggestionsEl.createEl("button", { text: suggestion, cls: "campaign-map-suggestion-chip" });
      btn.onclick = () => {
        this.name = suggestion;
        nameInput.value = suggestion;
        nameInput.focus();
      };
    }

    new Setting(contentEl).setName("Type").addDropdown((dropdown) => {
      for (const t of LOCATION_TYPES) dropdown.addOption(t, t);
      dropdown.setValue(this.type);
      dropdown.onChange((v) => (this.type = v));
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          const name = this.name.trim() || suggestions[0] || "New location";
          this.close();
          this.onSubmit({ name, type: this.type });
        })
    );

    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const name = this.name.trim() || suggestions[0] || "New location";
        this.close();
        this.onSubmit({ name, type: this.type });
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

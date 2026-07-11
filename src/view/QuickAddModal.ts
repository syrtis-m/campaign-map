import { App, Modal, Setting } from "obsidian";
import {
  LOCATION_TYPES,
  VISIBILITY_VALUES,
  defaultVisibilityForType,
  type Visibility,
} from "../model/locationNote";
import { generateNameSuggestions } from "../gen/naming/culture";
import type { NamingCulture } from "../gen/naming/culture";

export interface QuickAddResult {
  name: string;
  type: string;
  visibility: Visibility;
}

/** Self-explanatory picker labels (plan 015) — the value maps 1:1 to a focus
 * level, so the GM never reasons from `type`. */
const VISIBILITY_LABELS: Record<Visibility, string> = {
  wide: "Wide — name always shown",
  mid: "Mid — name from mid zoom",
  close: "Close — name only up close",
};

/**
 * The ≤5s yes-and flow (architecture §3b): name + type + visibility, with 3
 * culture-consistent name suggestions offered up front (tab/click to accept —
 * faster than typing). Label visibility is set here EXPLICITLY (plan 015) so the
 * GM never has to remember which type is legible at which focus level.
 */
export class QuickAddModal extends Modal {
  private name = "";
  private type = "custom";
  private visibility: Visibility = defaultVisibilityForType("custom");
  /** Once the GM touches the picker, `type` changes stop re-seeding it — the
   * explicit choice wins, `type` is only ever a first-guess hint. */
  private visibilityTouched = false;

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

    let visibilityDropdown: import("obsidian").DropdownComponent | null = null;

    new Setting(contentEl).setName("Type").addDropdown((dropdown) => {
      for (const t of LOCATION_TYPES) dropdown.addOption(t, t);
      dropdown.setValue(this.type);
      dropdown.onChange((v) => {
        this.type = v;
        // `type` is only a pre-selection hint (plan 015): re-seed the picker
        // until the GM sets it themselves, then leave their choice alone.
        if (!this.visibilityTouched) {
          this.visibility = defaultVisibilityForType(v);
          visibilityDropdown?.setValue(this.visibility);
        }
      });
    });

    new Setting(contentEl)
      .setName("Visibility")
      .setDesc("When the label's name appears as you zoom in — independent of type.")
      .addDropdown((dropdown) => {
        visibilityDropdown = dropdown;
        for (const v of VISIBILITY_VALUES) dropdown.addOption(v, VISIBILITY_LABELS[v]);
        dropdown.setValue(this.visibility);
        dropdown.onChange((v) => {
          this.visibility = v as Visibility;
          this.visibilityTouched = true;
        });
      });

    const submit = (): void => {
      const name = this.name.trim() || suggestions[0] || "New location";
      this.close();
      this.onSubmit({ name, type: this.type, visibility: this.visibility });
    };

    new Setting(contentEl).addButton((btn) => btn.setButtonText("Add").setCta().onClick(submit));

    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

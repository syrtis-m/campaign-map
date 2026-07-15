import { App, Modal, Setting } from "obsidian";
import type { ProcgenAlgorithm } from "../gen/procgen/registry";
import { matchingPresetId, presetById } from "../gen/procgen/registry";

export interface RegionProcgenChoice {
  params: Record<string, unknown>;
}

/**
 * Region procgen picker: shown when a district
 * sketch finishes and the sketch-kind has a registry algorithm. The form is
 * driven by the algorithm entry — a **Template** dropdown lists the
 * algorithm's presets (city's four profiles), pre-selected via
 * `defaultPresetId(theme)` (parchment/ink-soot → euro-medieval, modern/neon →
 * na-grid) so the common case is one Enter keypress. Picking a template seeds
 * `params` from that preset. (City has no further per-param controls yet —
 * the template IS the profile; future algorithms render their zod-schema
 * knobs below the dropdown.) There is NO radius control: the sketched polygon
 * IS the size. "Generate" attaches the procgen block and runs the generator;
 * "Keep as plain shape" leaves the district inert (procgen can be enabled
 * later from the edit menu).
 */
export class RegionProcgenModal extends Modal {
  private params: Record<string, unknown>;
  private submitted = false;

  constructor(
    app: App,
    private algorithm: ProcgenAlgorithm,
    themeId: string | undefined,
    private onSubmit: (choice: RegionProcgenChoice | null) => void
  ) {
    super(app);
    this.params = { ...algorithm.defaultParams(themeId ?? "") };
  }

  onOpen(): void {
    const label = this.algorithm.label.toLowerCase();
    this.titleEl.setText(`Generate ${label} from this sketch?`);
    this.contentEl.createEl("p", {
      text: `A ${label} is generated along the shape you drew and adapts to your sketches — nothing spills past it. Pick a template, then generate.`,
      cls: "setting-item-description",
    });

    // Template (preset) dropdown — the primary control. Selecting a template
    // seeds `params` from the preset. Pre-selected from the theme default.
    if (this.algorithm.presets.length > 0) {
      const selected = matchingPresetId(this.algorithm, this.params) ?? this.algorithm.presets[0].id;
      new Setting(this.contentEl).setName("Template").addDropdown((dd) => {
        for (const preset of this.algorithm.presets) dd.addOption(preset.id, preset.label);
        dd.setValue(selected);
        dd.onChange((id) => {
          const preset = presetById(this.algorithm, id);
          if (preset) this.params = { ...preset.params };
        });
      });
    }

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(`Generate ${this.algorithm.label.toLowerCase()}`)
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit({ params: this.params });
          })
      )
      .addButton((btn) => btn.setButtonText("Keep as plain shape").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit(null);
  }
}

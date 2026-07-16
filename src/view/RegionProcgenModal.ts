import { App, Modal, Setting } from "obsidian";
import type { ProcgenAlgorithm } from "../gen/procgen/registry";
import { matchingPresetId, presetById } from "../gen/procgen/registry";
import { presentedParamSpecs, presentedParams, presentedParamPatch, renderParamControls } from "./paramControls";

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

    // PRESENTED specs/values (relief: one `width` control — the field reads
    // only halfWidth+apron's sum, so the raw split never surfaces in the GUI).
    const paramKind = this.algorithm.appliesTo[0];
    const specs = presentedParamSpecs(paramKind, this.algorithm.paramsSchema);
    // The per-param container is filled AFTER the Template dropdown (below), but
    // `renderParams` is closed over by the dropdown's onChange, so declare it here.
    let paramsEl: HTMLDivElement | null = null;
    const renderParams = (): void => {
      if (!paramsEl) return;
      paramsEl.empty();
      renderParamControls(paramsEl, specs, presentedParams(paramKind, this.params), (key, value) => {
        this.params = { ...this.params, ...presentedParamPatch(paramKind, key, value) };
      });
    };

    // Template (preset) dropdown — the quick-fill. Selecting a template seeds
    // `params` from the preset bundle, then re-renders the per-param controls so
    // they reflect the new values. Pre-selected from the theme default.
    if (this.algorithm.presets.length > 0) {
      const selected = matchingPresetId(this.algorithm, this.params) ?? this.algorithm.presets[0].id;
      new Setting(this.contentEl)
        .setName("Template")
        .setTooltip(
          "Quick-fill: picking a template sets every knob below to that preset\u2019s values \u2014 you can still tweak them before generating."
        )
        .addDropdown((dd) => {
        for (const preset of this.algorithm.presets) dd.addOption(preset.id, preset.label);
        dd.setValue(selected);
        dd.onChange((id) => {
          const preset = presetById(this.algorithm, id);
          if (preset) {
            this.params = { ...this.params, ...preset.params };
            renderParams();
          }
        });
      });
    }
    // Per-param controls, derived from the algorithm's zod schema (river
    // windiness, wall towerSpacing, relief height, …) — every knob beyond the
    // preset discriminator, so nothing is preset-only anymore.
    paramsEl = this.contentEl.createDiv({ cls: "campaign-map-param-controls" });
    renderParams();

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(`Generate ${this.algorithm.label.toLowerCase()}`)
          .setTooltip("Generate inside the drawn boundary \u2014 you can re-roll, tweak or remove it any time from the shape\u2019s edit panel.")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit({ params: this.params });
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Keep as plain shape")
          .setTooltip("No generation \u2014 the drawn shape stays as plain fabric; you can generate later from its edit panel.")
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit(null);
  }
}

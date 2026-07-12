import { App, Modal, Setting } from "obsidian";
import type { ProcgenAlgorithm } from "../gen/procgen/registry";
import { CITY_PROFILE_IDS } from "../gen/procgen/registry";
import type { ProfileId } from "../gen/citynet";

export interface RegionProcgenChoice {
  params: Record<string, unknown>;
}

const PROFILE_LABELS: Record<ProfileId, string> = {
  "euro-medieval": "European medieval — organic warren, plaza, T-junctions",
  "euro-continental": "European continental — regular blocks, wide angles",
  "na-grid": "North American grid — right angles, jogged grids",
  "na-suburb": "North American suburb — curving streets, cul-de-sacs",
};

/**
 * Region procgen picker (plan 020 §8.1): shown when a district sketch finishes
 * and the sketch-kind has a registry algorithm. The form is driven by the
 * algorithm entry — v1's `city` algorithm renders a profile dropdown seeded
 * from `defaultParams(theme)` (parchment/ink-soot → euro-medieval, modern/neon
 * → na-grid) so the common case is one Enter keypress. There is NO radius
 * control: the sketched polygon IS the size. "Generate" attaches the procgen
 * block and runs the generator; "Keep as plain shape" leaves the district
 * inert (procgen can be enabled later from the edit menu).
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
    this.titleEl.setText(`Generate ${this.algorithm.label.toLowerCase()} in this district?`);
    this.contentEl.createEl("p", {
      text: `Streets, blocks, and buildings generate inside the shape you drew and adapt to your sketches. The outline is the ${this.algorithm.label.toLowerCase()} limit — nothing spills past it.`,
      cls: "setting-item-description",
    });

    // v1: the only city param is `profile`. Rendered from the pre-filled
    // defaults so the theme-appropriate choice is already selected.
    if ("profile" in this.params) {
      new Setting(this.contentEl).setName(`${this.algorithm.label} profile`).addDropdown((dd) => {
        for (const id of CITY_PROFILE_IDS) dd.addOption(id, PROFILE_LABELS[id]);
        dd.setValue(String(this.params.profile));
        dd.onChange((v) => (this.params.profile = v));
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

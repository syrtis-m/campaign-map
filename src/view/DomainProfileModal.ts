import { App, Modal, Setting } from "obsidian";
import {
  DOMAIN_DEFAULT_RADIUS_M,
  DOMAIN_MAX_RADIUS_M,
  DOMAIN_MIN_RADIUS_M,
  defaultProfileForTheme,
  type ProfileId,
} from "../gen/citynet";

export interface DomainChoice {
  profile: ProfileId;
  radius: number;
}

const PROFILE_LABELS: Record<ProfileId, string> = {
  "euro-medieval": "European medieval — organic warren, plaza, T-junctions",
  "euro-continental": "European continental — regular blocks, wide angles",
  "na-grid": "North American grid — right angles, jogged grids",
  "na-suburb": "North American suburb — curving streets, cul-de-sacs",
};

/**
 * Profile picker shown when "Generate fabric here" (city tier) lands outside
 * any existing city domain (procgen v3, design §3.1): the click becomes a new
 * domain — a bounded disc the whole city network is grown for. Defaults by
 * campaign theme (parchment/ink-soot → euro-medieval, modern/neon → na-grid)
 * so the common case is one Enter keypress. Cancelling creates nothing.
 */
export class DomainProfileModal extends Modal {
  private profile: ProfileId;
  private radius = DOMAIN_DEFAULT_RADIUS_M;
  private submitted = false;

  constructor(
    app: App,
    theme: string | undefined,
    private onSubmit: (choice: DomainChoice | null) => void
  ) {
    super(app);
    this.profile = defaultProfileForTheme(theme);
  }

  onOpen(): void {
    this.titleEl.setText("New city here");
    this.contentEl.createEl("p", {
      text: "This spot isn't inside an existing city. Pick the kind of town to grow — streets, blocks, and buildings generate inside this radius and adapt to your sketches.",
      cls: "setting-item-description",
    });

    new Setting(this.contentEl).setName("City profile").addDropdown((dd) => {
      for (const [id, label] of Object.entries(PROFILE_LABELS)) dd.addOption(id, label);
      dd.setValue(this.profile);
      dd.onChange((v) => (this.profile = v as ProfileId));
    });

    new Setting(this.contentEl)
      .setName("Radius (meters)")
      .setDesc(`${DOMAIN_MIN_RADIUS_M}–${DOMAIN_MAX_RADIUS_M} m of city, centered on your click`)
      .addSlider((slider) => {
        slider
          .setLimits(DOMAIN_MIN_RADIUS_M, DOMAIN_MAX_RADIUS_M, 50)
          .setValue(this.radius)
          .setDynamicTooltip()
          .onChange((v) => (this.radius = v));
      });

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Generate city")
          .setCta()
          .onClick(() => {
            this.submitted = true;
            this.close();
            this.onSubmit({ profile: this.profile, radius: this.radius });
          })
      )
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onSubmit(null);
  }
}

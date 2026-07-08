import { App, FuzzySuggestModal } from "obsidian";
import { THEME_IDS } from "../model/campaignConfig";

export class ThemeSwitcherModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private current: string,
    private onChoose: (themeId: string) => void
  ) {
    super(app);
    this.setPlaceholder(`Switch theme (current: ${current})...`);
  }

  getItems(): string[] {
    return [...THEME_IDS];
  }

  getItemText(themeId: string): string {
    return themeId === this.current ? `${themeId} (current)` : themeId;
  }

  onChooseItem(themeId: string): void {
    this.onChoose(themeId);
  }
}

import { App, FuzzySuggestModal } from "obsidian";
import type { ParsedLocation } from "../model/locationNote";

export class LocationSearchModal extends FuzzySuggestModal<ParsedLocation> {
  constructor(
    app: App,
    private locations: ParsedLocation[],
    private onChoose: (location: ParsedLocation) => void
  ) {
    super(app);
    this.setPlaceholder("Search locations...");
  }

  getItems(): ParsedLocation[] {
    return this.locations;
  }

  getItemText(loc: ParsedLocation): string {
    return [loc.name, ...loc.aliases].join(" ");
  }

  onChooseItem(loc: ParsedLocation): void {
    this.onChoose(loc);
  }
}

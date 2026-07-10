import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Picks a vault `.geojson`/`.json` file to import (plan 011) — the vault is
 * the only source (no network, no Node fs): the GM drops an Azgaar/Watabou
 * export into it first, then picks it here. */
export class ImportFileModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private files: TFile[],
    private onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Import GeoJSON: choose a file...");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

/**
 * FakeHost (plan 021 §2.4) — an in-memory ControllerHost for headless
 * MapController integration tests. It backs the vault gateway with an
 * in-memory DataAdapter (a `Map<string,string>`) wrapped as a synthetic
 * Obsidian `App`, so the REAL store / generation-service / tileCache functions
 * run unchanged against in-memory bytes — no Obsidian, no MapLibre, no DOM,
 * no temp dir. Render/notice/note sinks record what happened so a test can
 * assert on paints, notices, selection callbacks, etc.
 *
 * Only ever imported by `*.test.ts`, so it never enters the plugin bundle.
 */
import type { App } from "obsidian";
import type { ParsedCampaign, CampaignConfig } from "../model/campaignConfig";
import { loadFabric, saveFabric } from "../vault/fabricStore";
import { loadGeneratedManifest, saveGeneratedManifest } from "../vault/generatedManifestStore";
import { readCachedTiles, removeCachedTiles, type CachedTile } from "../model/tileCache";
import {
  appendLogEntry,
  readLog,
  campaignFolderFromConfigPath,
  type LogEntry,
} from "../model/mutationLog";
import { MapController } from "./MapController";
import { generateTile, generateRegionTile } from "../map/generation/generationService";

/** In-memory DataAdapter — implements exactly the six methods every store /
 * cache / log function touches (`app.vault.adapter.*`). Files and directories
 * are tracked separately so `exists()` answers for both. */
export class MemAdapter {
  readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`MemAdapter: no such file ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async append(path: string, data: string): Promise<void> {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  /** A byte-for-byte snapshot of every file (for determinism assertions). */
  snapshot(): Map<string, string> {
    return new Map(this.files);
  }
}

let fakeHostSeq = 0;

export interface FakeHostOptions {
  seed?: number;
  scaleMetersPerUnit?: number;
  bounds?: [number, number, number, number];
  crs?: "fictional" | "real";
  /** Camera zoom the "…here" actions read (≥8 ⇒ city tier, else world). */
  zoom?: number;
  /** Camera center in display units for point-less "…here" actions. */
  center?: [number, number];
  /** Reuse an existing adapter + campaign to simulate reopening the same vault
   * (fresh controller, persisted bytes) — for replay / determinism tests. */
  share?: { adapter: MemAdapter; campaign: ParsedCampaign };
}

/** Recorded render-sink `featureChanged` call. */
export interface FeatureChange {
  id: string;
  reselect?: boolean;
  panel?: boolean;
}

export class FakeHost {
  readonly adapter: MemAdapter;
  readonly campaign: ParsedCampaign;
  readonly controller: MapController;

  // Recorded side effects (assertion surface).
  readonly notices: { message: string; timeoutMs?: number }[] = [];
  readonly featureChanges: FeatureChange[] = [];
  readonly selectionInvalidations: string[] = [];
  readonly selectionKeptPanel: string[] = [];
  readonly undoneNotes: LogEntry[] = [];
  repaintGeneratedCount = 0;
  repaintFabricCount = 0;
  regenArmedCount = 0;

  // Live camera the viewport gateway reads.
  zoom: number;
  center: [number, number];
  /** Canon (location) features fed to generators as constraints. */
  canon: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

  constructor(opts: FakeHostOptions = {}) {
    this.adapter = opts.share?.adapter ?? new MemAdapter();
    this.zoom = opts.zoom ?? 10; // default: city tier
    this.center = opts.center ?? [18, -18];
    this.campaign = opts.share?.campaign ?? makeFakeCampaign(opts);
    const app = { vault: { adapter: this.adapter } } as unknown as App;
    const folder = campaignFolderFromConfigPath(this.campaign.path);

    this.controller = new MapController({
      vault: {
        loadFabric: (c) => loadFabric(app, c),
        saveFabric: (c, f) => saveFabric(app, c, f),
        loadManifest: (c) => loadGeneratedManifest(app, c),
        saveManifest: (c, m) => saveGeneratedManifest(app, c, m),
        appendLog: (f, e) => appendLogEntry(app, f, e),
        readLog: () => readLog(app, folder),
        readCached: (f) => readCachedTiles(app, f),
        removeCached: (f, keys) => removeCachedTiles(app, f, keys),
      },
      gen: {
        getWorker: async () => null, // direct (deterministic) main-thread generation
        generateTile: (ctx, tx, ty, gid, gen, o) => generateTile({ ...ctx, app }, tx, ty, gid, gen, o),
        generateRegionTile: (ctx, region, ids, tx, ty, compute, o) =>
          generateRegionTile({ ...ctx, app }, region, ids, tx, ty, compute, o),
      },
      canon: { canonFeatureCollection: () => this.canon },
      notes: {
        undoNoteEntry: async (e) => {
          this.undoneNotes.push(e);
        },
      },
      notices: {
        notify: (message, timeoutMs) => {
          this.notices.push({ message, timeoutMs });
        },
      },
      render: {
        repaintGenerated: () => {
          this.repaintGeneratedCount++;
        },
        repaintFabric: () => {
          this.repaintFabricCount++;
        },
        loadingChanged: () => {},
        featureChanged: (id, o) => {
          this.featureChanges.push({ id, ...o });
        },
        selectionInvalidated: (id, opts) => {
          this.selectionInvalidations.push(id);
          if (opts?.keepPanel) this.selectionKeptPanel.push(id);
        },
        armRegenFlush: () => {
          this.regenArmedCount++;
        },
      },
      viewport: {
        zoom: () => this.zoom,
        centerUnits: () => this.center,
      },
    });
  }

  /** Point the controller at the campaign (as MapView.setCampaign does). */
  begin(): { switched: boolean } {
    return this.controller.beginCampaign(this.campaign);
  }

  /** A fresh controller over the SAME persisted bytes — simulates closing and
   * reopening the map on the same vault (replay / determinism tests). */
  reopen(overrides: Partial<FakeHostOptions> = {}): FakeHost {
    return new FakeHost({ ...overrides, share: { adapter: this.adapter, campaign: this.campaign } });
  }

  // ─── Vault inspection (reads through the real store functions) ──────────

  private get app(): App {
    return { vault: { adapter: this.adapter } } as unknown as App;
  }
  private get folder(): string {
    return campaignFolderFromConfigPath(this.campaign.path);
  }

  cache(): Promise<Map<string, CachedTile>> {
    return readCachedTiles(this.app, this.folder);
  }
  async manifest() {
    return (await loadGeneratedManifest(this.app, this.campaign)).manifest;
  }
  async fabric() {
    return (await loadFabric(this.app, this.campaign)).fabric;
  }
  log(): Promise<LogEntry[]> {
    return readLog(this.app, this.folder);
  }
  /** The persisted cache-file path (for delete-and-regen determinism tests). */
  cachePath(): string {
    return `${this.folder}/.mapcache/generated.jsonl`;
  }
}

function makeFakeCampaign(opts: FakeHostOptions): ParsedCampaign {
  const id = `fh_${++fakeHostSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const config: CampaignConfig = {
    "map-campaign": true,
    crs: opts.crs ?? "fictional",
    theme: "obsidian-native",
    seed: opts.seed ?? 7741,
    scaleMetersPerUnit: opts.scaleMetersPerUnit ?? 50,
    bounds: opts.bounds ?? [-48, -36, 48, 36],
  };
  // A UNIQUE campaign folder per FakeHost keeps the module-global cache/log
  // write-chains (keyed by file path in tileCache/mutationLog) from
  // interleaving across parallel Vitest tests.
  return { id, name: id, path: `Campaigns/${id}/${id}.map.md`, config };
}

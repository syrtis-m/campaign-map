/**
 * FakeHost — an in-memory ControllerHost for headless MapController
 * integration tests. It backs the vault gateway with an
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
import { cacheShardBasename, readCachedTiles, removeCachedTiles, type CachedTile } from "../model/tileCache";
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

  /** IO tap for batching assertions (031-B): every read/write/append records
   * its path, so a test can count e.g. how many times the `.mapcache` file was
   * read across one flush/cascade batch. */
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly appends: string[] = [];
  readonly removes: string[] = [];

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async read(path: string): Promise<string> {
    this.reads.push(path);
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`MemAdapter: no such file ${path}`);
    return v;
  }
  async write(path: string, data: string): Promise<void> {
    this.writes.push(path);
    this.files.set(path, data);
  }
  async append(path: string, data: string): Promise<void> {
    this.appends.push(path);
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async remove(path: string): Promise<void> {
    this.removes.push(path);
    this.files.delete(path);
  }

  /** Obsidian DataAdapter.list: files + folders directly under `path` (full
   * vault-relative paths), needed by the sharded tileCache to enumerate cache
   * shards in `.mapcache/` (plan 032-A). */
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const files: string[] = [];
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) files.push(f);
    }
    const folders: string[] = [];
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== path && !d.slice(prefix.length).includes("/")) folders.push(d);
    }
    return { files, folders };
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
  /** Adoption-prompt calls, in order. `confirmResponse` is what each returns
   * (tests flip it, or use the controller's queued test responses instead). */
  readonly confirms: string[] = [];
  confirmResponse = true;
  readonly featureChanges: FeatureChange[] = [];
  readonly selectionInvalidations: string[] = [];
  readonly selectionKeptPanel: string[] = [];
  readonly undoneNotes: LogEntry[] = [];
  repaintGeneratedCount = 0;
  /** The `stage` of each `repaintGenerated` call in order (032-D): a number for
   * a staged repaint, "all" for a full one. A batch fires one entry per touched
   * stage, upstream-first — the staged-repaint assertion surface. */
  readonly repaintGeneratedStages: (number | "all")[] = [];
  repaintFabricCount = 0;
  regenArmedCount = 0;
  /** Gateway-level cache IO counters (031-B): count host.vault.readCached /
   * removeCached CALLS (not the adapter reads removeCached does internally), so
   * a test can assert a batch reads the shared cache view exactly once. */
  readCachedCount = 0;
  removeCachedCount = 0;

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
        readCached: (f) => {
          this.readCachedCount++;
          return readCachedTiles(app, f);
        },
        removeCached: (f, keys) => {
          this.removeCachedCount++;
          return removeCachedTiles(app, f, keys);
        },
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
      confirm: {
        confirm: async (message) => {
          this.confirms.push(message);
          return this.confirmResponse;
        },
      },
      render: {
        repaintGenerated: (stage?: number) => {
          this.repaintGeneratedCount++;
          this.repaintGeneratedStages.push(stage ?? "all");
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
  /** The `.mapcache` directory (cache shards live here — plan 032-A). */
  cacheDir(): string {
    return `${this.folder}/.mapcache`;
  }

  /** The shard file a record key persists to (plan 032-A). */
  cacheShardPath(key: string): string {
    return `${this.cacheDir()}/${cacheShardBasename(key)}`;
  }

  /** Raw text of the shard holding `key` (for raw-line-count assertions that
   * `readCachedTiles` dedup would otherwise hide). */
  cacheShardText(key: string): string {
    return this.adapter.files.get(this.cacheShardPath(key)) ?? "";
  }

  /** Delete every cache shard on disk (plan 032-A replacement for removing the
   * old monolith) — the delete-`.mapcache`-and-regenerate determinism tests.
   * Removes `region-*.jsonl` + `world.jsonl` (and a leftover monolith), leaving
   * `log.jsonl` / `dem.jsonl` intact. */
  async clearCacheOnDisk(): Promise<void> {
    const dir = `${this.cacheDir()}/`;
    for (const path of [...this.adapter.files.keys()]) {
      if (!path.startsWith(dir)) continue;
      const base = path.slice(dir.length);
      if (base === "world.jsonl" || base === "generated.jsonl" || (base.startsWith("region-") && base.endsWith(".jsonl"))) {
        this.adapter.files.delete(path);
      }
    }
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

import type { App } from "obsidian";
import { PMTiles, Protocol, type Source, type RangeResponse } from "pmtiles";
import maplibregl from "maplibre-gl";

/**
 * Real-city basemaps are a PMTiles file in the vault (CLAUDE.md locked decision:
 * "Protomaps PMTiles file in vault, custom protocol, byte-range reads"). The `pmtiles`
 * npm library's Source interface is fetch-agnostic — we back it with the Vault adapter
 * instead of HTTP. Obsidian's DataAdapter has no partial-read primitive, so we read the
 * local file once into memory and slice from there; there's no bandwidth cost to save on
 * a local disk file the way there would be over HTTP, so this still satisfies the intent
 * (logical byte-range access, format-correct) without needing true OS-level pread.
 */
class VaultPMTilesSource implements Source {
  private bufferPromise: Promise<ArrayBuffer> | null = null;

  constructor(
    private app: App,
    private vaultPath: string
  ) {}

  getKey(): string {
    return `vault://${this.vaultPath}`;
  }

  private loadBuffer(): Promise<ArrayBuffer> {
    if (!this.bufferPromise) {
      this.bufferPromise = this.app.vault.adapter.readBinary(this.vaultPath);
    }
    return this.bufferPromise;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = await this.loadBuffer();
    return { data: buf.slice(offset, offset + length) };
  }
}

let sharedProtocol: Protocol | null = null;

function ensureProtocol(): Protocol {
  if (!sharedProtocol) {
    sharedProtocol = new Protocol();
    maplibregl.addProtocol("pmtiles", sharedProtocol.tile);
  }
  return sharedProtocol;
}

/** Registers (idempotently) a vault-local PMTiles file and returns its `pmtiles://` source URL. */
export function registerVaultBasemap(app: App, vaultPath: string): string {
  const protocol = ensureProtocol();
  const source = new VaultPMTilesSource(app, vaultPath);
  const key = source.getKey();
  if (!protocol.get(key)) {
    protocol.add(new PMTiles(source));
  }
  return `pmtiles://${key}`;
}

/** Bounds of a registered vault basemap, for fitBounds on campaign open. */
export async function vaultBasemapBounds(
  app: App,
  vaultPath: string
): Promise<[number, number, number, number] | null> {
  const protocol = ensureProtocol();
  const key = `vault://${vaultPath}`;
  const instance = protocol.get(key) ?? new PMTiles(new VaultPMTilesSource(app, vaultPath));
  if (!protocol.get(key)) protocol.add(instance);
  const header = await instance.getHeader();
  return [header.minLon, header.minLat, header.maxLon, header.maxLat];
}

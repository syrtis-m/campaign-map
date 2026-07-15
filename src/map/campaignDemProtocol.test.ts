import { describe, it, expect, beforeEach } from "vitest";
import type { App } from "obsidian";
import {
  registerDemProvider,
  unregisterDemProvider,
  resolveDemTileForTest,
  resolveDemPngForTest,
  type DemProvider,
} from "./campaignDemProtocol";
import { demTileLattice, type ElevationField } from "../gen/fields";
import type { SerializableTerrainInputs } from "../gen/worker/generationWorker";

/**
 * Protocol-handler retryability (the "disappears and doesn't reliably reappear"
 * report). These drive the FULL resolve path (`resolveDemTileForTest`, the
 * modal-free twin of one MapLibre tile fetch): a failed persist must never poison
 * the served tile, concurrent requests for one tile dedupe, and the in-flight
 * entry always clears so a later request is re-derivable. Numeric lattice only —
 * PNG bytes are outside the determinism contract.
 */

const SCALE = 50;
const K = 25;

/** Fake vault adapter; `failAppend` forces every append to throw (vault
 * contention under heavy panning), the transient failure that used to reject the
 * handler and mark the MapLibre tile permanently errored. */
function fakeApp(opts: { failAppend?: boolean } = {}): App {
  const files = new Map<string, string>();
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p) ?? "",
    write: async (p: string, data: string) => {
      if (opts.failAppend) throw new Error("simulated write failure");
      files.set(p, data);
    },
    append: async (p: string, data: string) => {
      if (opts.failAppend) throw new Error("simulated append failure");
      files.set(p, (files.get(p) ?? "") + data);
    },
    mkdir: async () => {},
    remove: async (p: string) => void files.delete(p),
  };
  return { vault: { adapter } } as unknown as App;
}

const FIELD: ElevationField = (x, y) => ({ v: 100 + Math.sin(x * 0.001) * 40 + Math.cos(y * 0.001) * 40, dx: 0, dy: 0 });
const INPUTS: SerializableTerrainInputs = {
  features: [],
  base: { campAmp: 0, seaDatum: 0 },
  campaignSeed: 7,
  include: { relief: true, landform: true, carve: true, grade: false },
};

interface HarnessOpts {
  failAppend?: boolean;
  /** Override the terrain inputs — the per-tile digest is derived from these
   * (base params are always in it), so a distinct `base` yields a distinct
   * digest ⇒ a stale miss. */
  inputs?: SerializableTerrainInputs;
  /** When set, an off-thread fill that resolves via this hook (to count/dedupe/
   * delay); return null to force the main-thread fallback. */
  offThread?: DemProvider["computeLatticeOffThread"];
}

function makeProvider(app: App, opts: HarnessOpts = {}): DemProvider {
  const inputs = opts.inputs ?? INPUTS;
  return {
    app,
    campaignFolder: "Campaigns/Test",
    scaleMetersPerUnit: SCALE,
    k: K,
    snapshot: () => ({ field: FIELD, digest: "unused", inputs }),
    ...(opts.offThread ? { computeLatticeOffThread: opts.offThread } : {}),
  };
}

let counter = 0;
function uid(): string {
  return `camp-${counter++}`;
}

describe("campaigndem protocol — retryability (reappear bug)", () => {
  const registered: string[] = [];
  beforeEach(() => {
    for (const id of registered.splice(0)) unregisterDemProvider(id);
  });
  function register(app: App, opts?: HarnessOpts): string {
    const id = uid();
    registerDemProvider(id, makeProvider(app, opts));
    registered.push(id);
    return id;
  }

  it("serves the lattice even when the cache write throws (a failed persist never errors the tile)", async () => {
    const id = register(fakeApp({ failAppend: true }));
    // resolveLattice must RESOLVE (never reject) with the correct main-thread
    // lattice despite every persist attempt throwing.
    const heights = await resolveDemTileForTest(id, 6, 24, 36);
    expect(heights).toEqual(demTileLattice(FIELD, 6, 24, 36, 256, SCALE, K));
    // And it stays re-derivable: a second request also serves correctly.
    const again = await resolveDemTileForTest(id, 6, 24, 36);
    expect(again).toEqual(heights);
  });

  it("worker fill and main-thread fallback are byte-identical", async () => {
    const workerId = register(fakeApp(), {
      offThread: async (inputs, z, x, y, res, scale, k) => demTileLattice(FIELD, z, x, y, res, scale, k),
    });
    const fallbackId = register(fakeApp()); // no offThread ⇒ main thread
    const w = await resolveDemTileForTest(workerId, 6, 24, 36);
    const f = await resolveDemTileForTest(fallbackId, 6, 24, 36);
    expect(w).toEqual(f);
  });

  it("a rejecting off-thread fill falls back to the main thread (worker error never breaks the map)", async () => {
    const id = register(fakeApp(), {
      offThread: async () => {
        throw new Error("worker exploded");
      },
    });
    const heights = await resolveDemTileForTest(id, 6, 24, 36);
    expect(heights).toEqual(demTileLattice(FIELD, 6, 24, 36, 256, SCALE, K));
  });

  it("concurrent requests for the same tile dedupe to ONE compute", async () => {
    let computes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const id = register(fakeApp(), {
      offThread: async (inputs, z, x, y, res, scale, k) => {
        computes++;
        await gate; // hold both callers in-flight together
        return demTileLattice(FIELD, z, x, y, res, scale, k);
      },
    });
    const a = resolveDemTileForTest(id, 6, 24, 36);
    const b = resolveDemTileForTest(id, 6, 24, 36);
    release();
    const [ha, hb] = await Promise.all([a, b]);
    expect(computes).toBe(1); // deduped
    expect(ha).toEqual(hb);
  });

  it("the in-flight entry clears on completion — cache hit next, and a new digest re-derives", async () => {
    let computes = 0;
    const app = fakeApp();
    const count: DemProvider["computeLatticeOffThread"] = async (inputs, z, x, y, res, scale, k) => {
      computes++;
      return demTileLattice(FIELD, z, x, y, res, scale, k);
    };
    const idA = register(app, { offThread: count });
    await resolveDemTileForTest(idA, 6, 24, 36); // computes → 1, persists
    await resolveDemTileForTest(idA, 6, 24, 36); // cache hit (entry cleared, warm) → still 1
    expect(computes).toBe(1);

    // Same app+tile but moved base params ⇒ new per-tile digest ⇒ stale miss ⇒
    // recompute, proving no stale in-flight entry blocks the re-derive.
    const idB = register(app, {
      inputs: { ...INPUTS, base: { campAmp: 999, seaDatum: 0 } },
      offThread: count,
    });
    await resolveDemTileForTest(idB, 6, 24, 36);
    expect(computes).toBe(2);
  });
});

describe("campaigndem protocol — revisit is a pure serve (retention half)", () => {
  const registered: string[] = [];
  beforeEach(() => {
    for (const id of registered.splice(0)) unregisterDemProvider(id);
  });

  it("a re-request re-encodes ZERO times and recomputes ZERO lattices (the encoded-PNG memo)", async () => {
    let computes = 0;
    let encodes = 0;
    const id = uid();
    registered.push(id);
    registerDemProvider(
      id,
      makeProvider(fakeApp(), {
        offThread: async (inputs, z, x, y, res, scale, k) => {
          computes++;
          return demTileLattice(FIELD, z, x, y, res, scale, k);
        },
      })
    );
    const encode = async (rgba: Uint8ClampedArray): Promise<ArrayBuffer> => {
      encodes++;
      return rgba.buffer.slice(0) as ArrayBuffer;
    };
    // Derive a few distinct tiles.
    const tiles: [number, number, number][] = [
      [6, 24, 36],
      [6, 25, 36],
      [6, 24, 37],
    ];
    for (const [z, x, y] of tiles) await resolveDemPngForTest(id, z, x, y, encode);
    expect(computes).toBe(3);
    expect(encodes).toBe(3);
    // Simulate MapLibre evicting + re-requesting every tile (pan away and back).
    const first = await resolveDemPngForTest(id, 6, 24, 36, encode);
    for (const [z, x, y] of tiles) await resolveDemPngForTest(id, z, x, y, encode);
    expect(computes).toBe(3); // lattice served from the in-memory view / cache
    expect(encodes).toBe(3); // PNG served from the memo — no re-encode
    // Byte-identical bytes on revisit (same memoized buffer).
    const again = await resolveDemPngForTest(id, 6, 24, 36, encode);
    expect(new Uint8Array(again)).toEqual(new Uint8Array(first));
  });
});

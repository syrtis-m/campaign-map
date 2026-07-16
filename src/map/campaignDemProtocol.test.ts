import { describe, it, expect, beforeEach } from "vitest";
import type { App } from "obsidian";
import {
  registerDemProvider,
  unregisterDemProvider,
  resolveDemTileForTest,
  resolveDemPngForTest,
  DEM_TILE_RES,
  type DemProvider,
} from "./campaignDemProtocol";
import { demTileLattice, perTileTerrainDigest, type ElevationField } from "../gen/fields";
import { appendDemTile, demTileKey } from "../model/demCache";
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
    expect(heights).toEqual(demTileLattice(FIELD, 6, 24, 36, DEM_TILE_RES, SCALE, K));
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
    expect(heights).toEqual(demTileLattice(FIELD, 6, 24, 36, DEM_TILE_RES, SCALE, K));
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

describe("campaigndem protocol — encode concurrency is BOUNDED (Cradle: cold-fill jank)", () => {
  const registered: string[] = [];
  beforeEach(() => {
    for (const id of registered.splice(0)) unregisterDemProvider(id);
  });

  it("a cold-fill burst never runs more than the encode cap concurrently (leaves the main thread for input)", async () => {
    const id = uid();
    registered.push(id);
    registerDemProvider(id, makeProvider(fakeApp()));

    // A controllable encoder: each call blocks on a deferred we release manually,
    // so we can observe how many serves sit in the encode critical section at once.
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const encode = async (rgba: Uint8ClampedArray): Promise<ArrayBuffer> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return rgba.buffer.slice(0) as ArrayBuffer;
    };

    // Flush pending microtasks + the async persist path so every job that CAN
    // acquire an encode slot has reached (and blocked in) the encoder.
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    // Fire 20 DISTINCT tiles at once (a cold Cradle viewport fill) — none cached.
    const jobs: Promise<ArrayBuffer>[] = [];
    for (let i = 0; i < 20; i++) jobs.push(resolveDemPngForTest(id, 6, 24 + i, 36, encode));

    await settle();
    // The semaphore caps concurrent encodes at 3 — the other 17 jobs are parked
    // awaiting a slot, so only 3 sit in the synchronous-fill + encode section.
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(active).toBe(3);

    // Drain: releasing one encode admits exactly one waiter, never exceeding the cap.
    while (releases.length > 0) {
      releases.shift()!();
      await settle();
    }
    await Promise.all(jobs);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe("campaigndem protocol — PNG LRU is digest-keyed (never serves a stale tile)", () => {
  const registered: string[] = [];
  beforeEach(() => {
    for (const id of registered.splice(0)) unregisterDemProvider(id);
  });

  it("a field change (new digest) re-encodes and never serves the old-digest PNG", async () => {
    const app = fakeApp();
    const id = uid();
    registered.push(id);
    let encodes = 0;
    const encode = async (rgba: Uint8ClampedArray): Promise<ArrayBuffer> => {
      encodes++;
      return rgba.buffer.slice(0) as ArrayBuffer;
    };
    const fieldA: ElevationField = () => ({ v: 100, dx: 0, dy: 0 });
    const fieldB: ElevationField = () => ({ v: 900, dx: 0, dy: 0 });
    const inputsA = INPUTS;
    // A distinct base ⇒ a distinct per-tile digest (the terrain-refresh signal a
    // landform edit produces): the PNG key carries the digest, so the new field
    // MUST re-encode instead of serving the retained old-digest bytes.
    const inputsB: SerializableTerrainInputs = { ...INPUTS, base: { campAmp: 777, seaDatum: 0 } };
    const mk = (field: ElevationField, inputs: SerializableTerrainInputs): DemProvider => ({
      app,
      campaignFolder: "Campaigns/Test",
      scaleMetersPerUnit: SCALE,
      k: K,
      snapshot: () => ({ field, digest: "unused", inputs }),
    });

    registerDemProvider(id, mk(fieldA, inputsA));
    const a1 = new Uint8Array(await resolveDemPngForTest(id, 6, 24, 36, encode));
    expect(encodes).toBe(1);

    // The elevation surface moved (landform edit) — new digest ⇒ cache MISS, not a
    // stale serve of A's memo.
    registerDemProvider(id, mk(fieldB, inputsB));
    const b1 = new Uint8Array(await resolveDemPngForTest(id, 6, 24, 36, encode));
    expect(encodes).toBe(2);
    expect(b1).not.toEqual(a1); // the new field's bytes, never A's

    // Revisit the SAME (new) digest — pure serve, no re-encode.
    const b2 = new Uint8Array(await resolveDemPngForTest(id, 6, 24, 36, encode));
    expect(encodes).toBe(2);
    expect(b2).toEqual(b1);

    // Back to the OLD digest — its memo is intact and served on its own key, never
    // crossed with B's bytes (no re-encode; the surviving A memo answers).
    registerDemProvider(id, mk(fieldA, inputsA));
    const a2 = new Uint8Array(await resolveDemPngForTest(id, 6, 24, 36, encode));
    expect(a2).toEqual(a1);
    expect(encodes).toBe(2);
  });
});

describe("campaigndem protocol — DEM_TILE_RES flip (128) + res-mismatch handling", () => {
  const registered: string[] = [];
  beforeEach(() => {
    for (const id of registered.splice(0)) unregisterDemProvider(id);
  });

  it("serves a res² lattice at the current DEM_TILE_RES", async () => {
    const id = uid();
    registered.push(id);
    registerDemProvider(id, makeProvider(fakeApp()));
    const heights = await resolveDemTileForTest(id, 6, 24, 36);
    expect(heights.length).toBe(DEM_TILE_RES * DEM_TILE_RES);
  });

  it("an OLD record at a different res is a stale miss — re-derives at DEM_TILE_RES (never serves 256 at 128)", async () => {
    const app = fakeApp();
    const id = uid();
    registered.push(id);
    const provider = makeProvider(app);
    registerDemProvider(id, provider);
    // Pre-seed a cache record with the CURRENT per-tile digest but the WRONG res
    // (a leftover from before the flip) — resolveLattice must reject it on res.
    const digest = perTileTerrainDigest(INPUTS.features, INPUTS.base, INPUTS.campaignSeed, INPUTS.include.grade, 6, 24, 36, SCALE, K);
    const wrongRes = (DEM_TILE_RES as number) === 256 ? 128 : 256;
    await appendDemTile(app, provider.campaignFolder, {
      key: demTileKey(6, 24, 36),
      z: 6,
      x: 24,
      y: 36,
      res: wrongRes,
      k: K,
      digest,
      heights: new Array(wrongRes * wrongRes).fill(1234),
      generatedAt: Date.now(),
    });
    const heights = await resolveDemTileForTest(id, 6, 24, 36);
    expect(heights.length).toBe(DEM_TILE_RES * DEM_TILE_RES); // re-derived, not the seeded stale one
    expect(heights).toEqual(demTileLattice(FIELD, 6, 24, 36, DEM_TILE_RES, SCALE, K));
  });
});

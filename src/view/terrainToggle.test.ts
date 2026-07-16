/**
 * Terrain-toggle lifecycle tests (the "show 3D toggle is a massive perf hit +
 * unreliable" fix). Drives the FULL lifecycle headlessly against a fake port —
 * no MapLibre, no Obsidian — asserting:
 *  1. PERF: a plain re-enable reuses retained tiles (NO `setTiles` bust); the bust
 *     fires only when the elevation digest moved while terrain was off.
 *  2. LEAKS: no monotonic growth of listeners / mesh calls across 20 on/off cycles.
 *  3. RELIABILITY: a `setTerrain` throw (source not ready) is retried ONCE on
 *     source-ready, and relief converges idempotently from `enabled` + pitch.
 *  4. RAPID TOGGLES: off-while-retry-pending never resurrects the mesh.
 */
import { describe, it, expect } from "vitest";
import { TerrainToggle, type TerrainTogglePort, type MeshMode } from "./terrainToggle";

/** A fake map+field port with settable pitch/digest/source-readiness and full
 * call/listener accounting — the terrain equivalent of terrainRefresh's spy
 * harness. `sourceReady=false` makes `setMesh(true)` throw exactly as MapLibre's
 * `setTerrain` does before the DEM source loads. */
function fakePort(opts: { digest?: string | null; pitch?: number; sourceReady?: boolean } = {}) {
  const state = {
    hasLayer: true,
    digest: opts.digest ?? "d1",
    pitch: opts.pitch ?? 0,
    sourceReady: opts.sourceReady ?? true,
    meshMode: "off" as MeshMode,
    hillshadeVisible: false,
  };
  const calls = { bust: 0, register: 0, setMeshOn: 0, setMeshFlat: 0, setMeshOff: 0, setHillshade: 0 };
  const pitchHandlers = new Set<() => void>();
  const sourceReadyHandlers = new Set<() => void>();
  const port: TerrainTogglePort = {
    hasHillshadeLayer: () => state.hasLayer,
    setHillshadeVisible: (v) => {
      calls.setHillshade++;
      state.hillshadeVisible = v;
    },
    getPitch: () => state.pitch,
    meshMode: () => state.meshMode,
    setMesh: (mode) => {
      if (mode !== "off") {
        if (!state.sourceReady) throw new Error("terrain source not loaded");
        if (mode === "on") calls.setMeshOn++;
        else calls.setMeshFlat++;
        state.meshMode = mode;
      } else {
        calls.setMeshOff++;
        state.meshMode = "off";
      }
    },
    bustDemTiles: () => void calls.bust++,
    registerProvider: () => void calls.register++,
    readDigest: () => state.digest,
    addPitchHandler: (fn) => void pitchHandlers.add(fn),
    removePitchHandler: (fn) => void pitchHandlers.delete(fn),
    onceSourceReady: (fn) => {
      sourceReadyHandlers.add(fn);
      return () => sourceReadyHandlers.delete(fn);
    },
  };
  /** Simulate the DEM source finishing its load: fire every pending one-shot. */
  const fireSourceReady = () => {
    state.sourceReady = true;
    for (const fn of [...sourceReadyHandlers]) {
      sourceReadyHandlers.delete(fn);
      fn();
    }
  };
  return { state, calls, port, pitchHandlers, sourceReadyHandlers, fireSourceReady };
}

describe("TerrainToggle — digest-gated tile bust (the perf fix)", () => {
  it("busts on the FIRST enable, then a plain off/on reuses retained tiles", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);

    expect(t.setEnabled(true)).toBe(true);
    expect(h.calls.bust).toBe(1); // first enable: retained-digest was null

    t.setEnabled(false);
    t.setEnabled(true);
    t.setEnabled(false);
    t.setEnabled(true);
    // Field never moved ⇒ no further busts across three more enables.
    expect(h.calls.bust).toBe(1);
  });

  it("busts again when the field moved while terrain was OFF", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    expect(h.calls.bust).toBe(1);

    t.setEnabled(false);
    h.state.digest = "d2"; // a landform edit landed while terrain was off
    t.setEnabled(true);
    expect(h.calls.bust).toBe(2); // stale retained tiles → one bust
    // ...and stable again afterwards.
    t.setEnabled(false);
    t.setEnabled(true);
    expect(h.calls.bust).toBe(2);
  });

  it("markDemTilesFresh (on-terrain edit bust) prevents a redundant toggle bust", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    expect(h.calls.bust).toBe(1);

    // Simulate the render-chokepoint bust after an edit made WHILE terrain is on:
    // the field moved and terrainRefresh already busted + refreshed those tiles.
    h.state.digest = "d2";
    t.markDemTilesFresh();

    // A subsequent plain off/on must NOT bust again (tiles already reflect d2).
    t.setEnabled(false);
    t.setEnabled(true);
    expect(h.calls.bust).toBe(1);
  });
});

describe("TerrainToggle — no leaks across N cycles", () => {
  it("20 on/off cycles leave zero residual listeners and bounded calls", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    for (let i = 0; i < 20; i++) {
      t.setEnabled(true);
      t.setEnabled(false);
    }
    // Pitch handler removed on every disable; no source-ready retry outstanding.
    expect(h.pitchHandlers.size).toBe(0);
    expect(h.sourceReadyHandlers.size).toBe(0);
    expect(t.listenerCount).toBe(0);
    // The bust fired exactly once (first enable) — never per cycle.
    expect(h.calls.bust).toBe(1);
  });

  it("a single pitch handler is registered while enabled (never stacked)", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    t.setEnabled(true); // idempotent re-enable
    t.setEnabled(true);
    expect(h.pitchHandlers.size).toBe(1);
    t.setEnabled(false);
    expect(h.pitchHandlers.size).toBe(0);
  });
});

describe("TerrainToggle — pitch-adaptive relief convergence", () => {
  it("top-down shows hillshade over a FLAT resident mesh; pitched raises it + hides hillshade", () => {
    const h = fakePort({ digest: "d1", pitch: 0 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    expect(h.state.hillshadeVisible).toBe(true);
    expect(h.state.meshMode).toBe("flat"); // resident, exaggeration 0 — caches stay warm

    // Pitch the camera → the registered pitch handler re-applies relief: the
    // SAME resident mesh is raised (an exaggeration flip, never a rebuild).
    h.state.pitch = 40;
    for (const fn of h.pitchHandlers) fn();
    expect(h.state.hillshadeVisible).toBe(false);
    expect(h.state.meshMode).toBe("on");

    // Back to top-down: flat again — no teardown (the pop-in-delay fix).
    h.state.pitch = 0;
    for (const fn of h.pitchHandlers) fn();
    expect(h.state.hillshadeVisible).toBe(true);
    expect(h.state.meshMode).toBe("flat");
    expect(h.calls.setMeshOff).toBe(0); // never torn down while enabled

    // Disable → torn down.
    t.setEnabled(false);
    expect(h.state.hillshadeVisible).toBe(false);
    expect(h.state.meshMode).toBe("off");
  });

  it("pitch crossings while enabled NEVER tear the mesh down (the pop-in-delay fix)", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    for (let i = 0; i < 10; i++) {
      h.state.pitch = i % 2 === 0 ? 0 : 45;
      for (const fn of h.pitchHandlers) fn();
    }
    expect(h.calls.setMeshOff).toBe(0);
    expect(h.state.meshMode).toBe("on"); // ended pitched
  });

  it("applyReliefMode is idempotent (repeat calls don't re-set the mesh)", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    const on1 = h.calls.setMeshOn;
    t.applyReliefMode();
    t.applyReliefMode();
    expect(h.calls.setMeshOn).toBe(on1); // already converged ⇒ no re-set
  });
});

describe("TerrainToggle — reliability (source-not-ready retry)", () => {
  it("retries the mesh once when the source becomes ready", () => {
    const h = fakePort({ digest: "d1", pitch: 30, sourceReady: false });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    // setMesh threw (source not loaded) ⇒ mesh not up yet, one retry pending.
    expect(h.state.meshMode).toBe("off");
    expect(h.sourceReadyHandlers.size).toBe(1);

    h.fireSourceReady();
    // Retry fired → mesh is now up, no residual listener.
    expect(h.state.meshMode).toBe("on");
    expect(h.sourceReadyHandlers.size).toBe(0);
    expect(t.listenerCount).toBe(1); // just the pitch handler
  });

  it("a disable while a retry is pending never resurrects the mesh", () => {
    const h = fakePort({ digest: "d1", pitch: 30, sourceReady: false });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    expect(h.sourceReadyHandlers.size).toBe(1);

    // Toggle OFF before the source ever loaded — the pending retry must be canceled.
    t.setEnabled(false);
    expect(h.sourceReadyHandlers.size).toBe(0);

    // Source finally loads: no stray handler, mesh stays down.
    h.fireSourceReady();
    expect(h.state.meshMode).toBe("off");
    expect(t.listenerCount).toBe(0);
  });

  it("bounded retries — a permanently-wedged source can't spin unbounded listeners", () => {
    const h = fakePort({ digest: "d1", pitch: 30, sourceReady: false });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    // Fire source-ready repeatedly while it still can't set the mesh (stays not-
    // ready in the fake). Each retry re-schedules; the cap stops it.
    for (let i = 0; i < 20; i++) {
      for (const fn of [...h.sourceReadyHandlers]) {
        h.sourceReadyHandlers.delete(fn);
        fn();
      }
    }
    expect(h.sourceReadyHandlers.size).toBe(0); // gave up cleanly, no residual
    expect(t.listenerCount).toBe(1); // pitch handler only
  });
});

describe("TerrainToggle — guards", () => {
  it("no-ops (returns false) when the hillshade layer is absent", () => {
    const h = fakePort();
    h.state.hasLayer = false;
    const t = new TerrainToggle(h.port);
    expect(t.setEnabled(true)).toBe(false);
    expect(t.isEnabled()).toBe(false);
    expect(h.calls.bust).toBe(0);
  });

  it("reset() forces off and clears the retained-tile digest (campaign switch)", () => {
    const h = fakePort({ digest: "d1", pitch: 30 });
    const t = new TerrainToggle(h.port);
    t.setEnabled(true);
    expect(h.calls.bust).toBe(1);

    t.reset();
    expect(t.isEnabled()).toBe(false);
    expect(h.pitchHandlers.size).toBe(0);

    // After a reset the digest is cleared, so the next enable busts afresh even at
    // the same digest (a new campaign's tiles must be fetched).
    t.setEnabled(true);
    expect(h.calls.bust).toBe(2);
  });
});

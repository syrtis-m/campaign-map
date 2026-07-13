# 021-B — Renderer-degradation investigation (plan 021 §2.2)

**Outcome: EVIDENCE DOCUMENTED, not root-caused.** The prime suspect (MapLibre
`Map`/GL context leaking across `plugin:reload`) is **refuted** by a 50-cycle
repro; the catastrophic `isStyleLoaded()=false` degradation did **not** reproduce
in a single fresh-launched, CLI-driven process across 50 reload cycles or 12
generation-heavy cycles. The board's probe-driven restart (plan 021 §2.3) stays
as the shipped mitigation. This is a legitimate, planned timebox outcome
(HEARTBEAT rule), not a failure.

## Repro recipe (the instrument)

`scripts/rendererSoak.ts` (`npm run soak`): N cycles of `plugin:reload` → detach
leaves → open map → `flyTo` → `dev:screenshot`, probing each cycle:
- `isStyleLoaded()`, `map.loaded()`, `getLayer('background')`, `queryRenderedFeatures()` sanity
- **GL-canvas count**: `document.querySelectorAll('canvas.maplibregl-canvas')` filtered to
  live (non-`isContextLost()`) WebGL contexts — the direct leak proxy
- **idle latency**: ms to reach `idle` after a `flyTo` (frame-time proxy; 8000ms cap = "never idled")

```
npm run soak -- --cycles=50              # reload/open/screenshot (fixture-safe, ashfall)
npm run soak -- --cycles=20 --generate   # + createRegionForTest per cycle (vespergate; git-restored on exit)
```

## Results

### Baseline: 50 reload/open/screenshot cycles (ashfall)
```
GL-canvas count: min=1 max=1 last=1
idle latency: stable ~260–300ms every cycle
isStyleLoaded/loaded/background/query: true every cycle
NO DEGRADATION across 50 cycles
```
**GL-canvas count is flat at 1 for all 50 cycles.** The view teardown path is
clean: gates (and the soak) `detachLeavesOfType('campaign-map-view')` at start,
which fires `MapView.onClose()` → `this.map.remove()` → the old GL context is
released before the next open. No accumulation, no leak, no degradation.

### Generation load: 20 `--generate` cycles (vespergate)
Crashed at cycle ~12 with a **CLI eval `ETIMEDOUT`** — but not from renderer
degradation: `isStyleLoaded` stayed **true** and GL-canvas count stayed **1**
right up to the crash. The soak re-adds a `__soak_test__` city network to the
same `Fabric.geojson` every cycle, so features **accumulate** (12 whole city
networks by cycle 12); regenerating all of them on cycle 12 exceeded the 30s CLI
eval timeout. The rising idle latency (180ms → 1150ms → 3150ms) tracks the
growing feature count, **not** a renderer leak — a confound of the harness, not a
degradation signal. `styleLoaded` never went false.

## Ruled out

- **GL-context leak on `plugin:reload`** — refuted: GL-canvas count flat at 1
  over 50 cycles. `MapView.onClose()` does `map.remove()` and it runs on the
  detach that precedes every open.
- **`window` event-listener leak** — `grep window.addEventListener src/` finds
  exactly one (`keydown` sketch handler in `MapView`), removed symmetrically in
  `onClose` and on mode exit (`window.removeEventListener` at MapView:967/2112).
  All vault/metadata listeners use Obsidian's `registerEvent` (auto-cleaned on
  unload). The worker is `terminate()`d in `Plugin.onunload`.
- **Style/glyph-image cache survival** — not *directly* probed, but showed no
  functional symptom: `isStyleLoaded` and `getStyle()` stayed healthy across all
  50 reloads; a surviving-cache corruption would have surfaced there.

## Methodological caveats (for the next investigator)

- The soak's `issueOpen` detaches leaves each cycle, so it tests the **gate
  pattern** (detach→open), which is representative of real gates — but it does
  **not** isolate `plugin:reload` *without* a preceding detach. A leak that only
  manifests when a leaf is orphaned (reload without detach) would be missed here.
- A single fresh CLI-launched process was used; the historical degradation was
  observed during **long multi-gate board runs** (DECISIONS 2026-07-12: onset ≈
  4th gate-scale workload, 3 gates clean then the 4th stalled with zero output).
  My harness did not reach that regime (50 light + 12 heavy cycles, one process).

## Best remaining hypothesis

Cumulative **GPU/driver memory pressure** across *many heavy generation gates*
in one long-lived process (whole-collection `setData` of thousands of
footprint/parcel/street features per city, repeated across procgen40–43 +
phase3/4), **not** reload count — consistent with "onset ≈ 4th gate-scale
workload" and with reload cycles alone being harmless. A secondary contributor
may be **macOS compositor suspension** of the unfocused Obsidian window during
long unattended CLI-only sessions (the App-Nap-adjacent effect already documented
in `scripts/lib/cli.ts` for screenshots) — which would explain "`idle` stops
firing" without any in-app leak. Neither is a plugin-layer bug we can fix by
teardown changes.

## Cheap defensive candidate (NOT implemented — deliberately)

`Plugin.onunload` (`src/main.ts:325`) terminates the worker but does **not**
`detachLeavesOfType(VIEW_TYPE_MAP)`. On a bare `plugin:reload` (no preceding
detach), Obsidian may orphan the map leaf without calling `onClose`, so
`map.remove()` would not run. The soak refutes this being the active cause
(gates always detach first, GL count stayed flat), so **adding the detach now
would touch src/, force a rebuild + phase1 regression, and be unprovable** —
logged here as a one-line hardening for a future session, not a fix for a bug we
can reproduce.

## Shipped mitigation

`scripts/board.ts` (`npm run board`) runs the board in one process and relaunches
Obsidian only when a post-gate health probe fails, re-running the suspect gate in
the fresh process. Because degradation produces *vacuous passes* as well as
failures, the probe is the discriminator, not the gate's own exit code. Even if
the root cause is an Obsidian/Electron/driver issue outside our layer, this keeps
the board correct and cuts process boots from ~12 (one-per-gate) to ~2–4.

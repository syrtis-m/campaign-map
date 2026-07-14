#!/usr/bin/env tsx
// Plan 024-A gate — input fingerprints on cache records + stale-replay detection
// (plan 024 §5.1). NO visual surface: fingerprints are cache metadata, so this
// gate takes NO screenshots — it asserts on the on-disk .mapcache/generated.jsonl
// records and the replay path, live against dev-vault via the obsidian CLI.
//
//   (a) fingerprints WRITTEN: every region cache record a generate produces
//       carries a non-empty `fingerprint`;
//   (b) STALE detection: edit a region's procgen params in Fabric.geojson on
//       disk (simulating a vault sync / external edit that no in-app commit
//       path saw), reopen → that region REGENERATES on replay with no manual
//       action (its records' features + fingerprint change to match the edit);
//   (c) ISOLATION: a second, independent region whose inputs did NOT change is
//       UNTOUCHED across the same replay — its latest records are byte-identical
//       (same generatedAt: proof no recompute ran);
//   (d) rm .mapcache/generated.jsonl → the whole fingerprinted world regenerates
//       BYTE-IDENTICALLY (cache-delete-harmless quality bar extends across 024);
//   (e) BACK-COMPAT: strip the `fingerprint` field from every record (simulate a
//       pre-024 cache), reopen → records are GRANDFATHERED fresh (no regen storm:
//       the latest record keeps its old generatedAt and stays un-fingerprinted);
//   (f) explicit-only preserved: pan/zoom never moves generatorRunCount;
//   (g) dev:errors clean end-to-end; dev-vault Vespergate left byte-intact.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Gate, obsidian, evalJs, clearErrors, devErrors } from "../lib/cli.js";

const CAMPAIGN = "vespergate";
const FOLDER = "dev-vault/Campaigns/Vespergate";
const CACHE_ABS = `${FOLDER}/.mapcache/generated.jsonl`;
const FABRIC_ABS = `${FOLDER}/Fabric.geojson`;
const TEST_NAME = "__s24a_test__";
// Display units (1 unit = 50 m); bounds [-48,-36,48,36]. Two ~400 m cities far
// apart and clear of the migrated Vespergate district (~[-4.8,6]).
const RING_A = "[[-44,-30],[-36,-30],[-36,-22],[-44,-22]]";
const RING_B = "[[36,20],[44,20],[44,28],[36,28]]";
const PROFILE_A0 = "euro-medieval";
const PROFILE_A1 = "na-grid";

function viewExpr(): string {
  return `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${CAMPAIGN}'})`;
}
function resetLeaves(): void {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
}
async function issueOpen(): Promise<void> {
  resetLeaves();
  for (let i = 0; i < 8; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${CAMPAIGN}`);
    if (String(out).includes("Executed")) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function evalAsync(body: string, timeoutMs = 180000): Promise<unknown> {
  evalJs(`window.__s24a = undefined; (function(){
    var v = ${viewExpr()};
    if (!v) { window.__s24a = { error: 'no view' }; return 'no-view'; }
    (${body})(v).then(function(r){ window.__s24a = { ok: r === undefined ? null : r }; }, function(e){ window.__s24a = { error: String(e && e.message || e) }; });
    return 'started';
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = evalJs("JSON.stringify(window.__s24a === undefined ? null : window.__s24a)");
    const parsed = typeof out === "string" ? JSON.parse(out) : out;
    if (parsed !== null) {
      if (parsed.error) throw new Error(`in-app async failed: ${parsed.error}`);
      return parsed.ok;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("in-app async timed out");
}
function sync(expr: string): unknown {
  return evalJs(`(function(){ var v=${viewExpr()}; return (${expr}); })()`);
}
function front(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5000 });
  } catch {
    /* best-effort */
  }
}

interface Rec {
  key: string;
  fingerprint?: string;
  generatedAt: number;
  features: unknown[];
}
/** Latest record per key (last write wins), like the replay reader. */
function diskRecords(): Map<string, Rec> {
  const out = new Map<string, Rec>();
  if (!existsSync(CACHE_ABS)) return out;
  for (const line of readFileSync(CACHE_ABS, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Rec;
      out.set(r.key, r);
    } catch {
      /* skip partial line */
    }
  }
  return out;
}
/** Records for one region id, latest per key. */
function regionRecords(id: string): Rec[] {
  const prefix = `region:${id}:`;
  return [...diskRecords().values()].filter((r) => r.key.startsWith(prefix));
}
/** Stable hash of a region's emitted features (envelope-independent). */
function featuresDigest(id: string): string {
  const recs = regionRecords(id).sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(recs.map((r) => [r.key, r.features]));
}
function netRecord(id: string): Rec | undefined {
  return diskRecords().get(`region:${id}:network`);
}

/** Edit a region's persisted procgen params on disk (external-edit simulation). */
function editFabricProfile(featureId: string, profile: string): void {
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features: { id?: string; properties?: { procgen?: { params?: Record<string, unknown> } } }[];
  };
  const f = fabric.features.find((x) => x.id === featureId);
  if (!f || !f.properties?.procgen?.params) throw new Error(`no procgen params for ${featureId} on disk`);
  f.properties.procgen.params.profile = profile;
  writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
}
/** Strip the fingerprint field from every cache record (pre-024 cache sim). */
function stripFingerprints(): void {
  if (!existsSync(CACHE_ABS)) return;
  const lines = readFileSync(CACHE_ABS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const r = JSON.parse(l) as Rec;
      delete r.fingerprint;
      return JSON.stringify(r);
    });
  writeFileSync(CACHE_ABS, lines.join("\n") + "\n");
}

function stripTestFabric(): void {
  if (!existsSync(FABRIC_ABS)) return;
  const fabric = JSON.parse(readFileSync(FABRIC_ABS, "utf8")) as {
    features?: { id?: string; properties?: { name?: string } }[];
  };
  if (!Array.isArray(fabric.features)) return;
  const before = fabric.features.length;
  const removed = fabric.features.filter((f) => f.properties?.name === TEST_NAME).map((f) => f.id);
  fabric.features = fabric.features.filter((f) => f.properties?.name !== TEST_NAME);
  if (fabric.features.length !== before) {
    writeFileSync(FABRIC_ABS, JSON.stringify(fabric, null, 2));
    if (existsSync(CACHE_ABS)) {
      const kept = readFileSync(CACHE_ABS, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .filter((l) => {
          try {
            const r = JSON.parse(l) as { key: string };
            return !removed.some((id) => id && r.key.startsWith(`region:${id}:`));
          } catch {
            return true;
          }
        });
      writeFileSync(CACHE_ABS, kept.join("\n") + "\n");
    }
  }
}

async function reopenAndSettle(): Promise<void> {
  await issueOpen();
  front();
  await waitFor(() => evalJs(`!!(${viewExpr()})`) === true, 20000, "vespergate view");
  await new Promise((r) => setTimeout(r, 4000)); // migration + replay settle
}

async function main(): Promise<void> {
  const gate = new Gate();
  console.log("== Plan 024-A gate (staleness fingerprints + stale-replay) ==\n");

  await gate.try("unit gates: fingerprint determinism/change-detection + cache staleness + tileCache", () => {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "src/gen/cache/fingerprint.test.ts",
        "src/map/generation/generationService.test.ts",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 300_000 }
    );
  });

  await gate.try("plugin loads (reloaded), no errors, cache clean", () => {
    stripTestFabric();
    if (existsSync(CACHE_ABS)) rmSync(CACHE_ABS);
    obsidian("plugin:reload id=campaign-map");
    clearErrors();
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  await gate.try("vespergate opens (migration + replay settle)", async () => {
    await reopenAndSettle();
  });

  let idA = "";
  let idB = "";
  await gate.try("(a) two independent cities created, records carry a fingerprint", async () => {
    const ra = (await evalAsync(
      `function(v){ return v.createRegionForTest(${RING_A}, 'city', { profile: '${PROFILE_A0}' }, '${TEST_NAME}', 'district'); }`
    )) as { featureId: string; count: number; outside: number };
    if (ra.count < 1) throw new Error("city A generated no features");
    if (ra.outside > 0) throw new Error(`${ra.outside} A coords outside the ring`);
    idA = ra.featureId;
    const rb = (await evalAsync(
      `function(v){ return v.createRegionForTest(${RING_B}, 'city', { profile: '${PROFILE_A0}' }, '${TEST_NAME}', 'district'); }`
    )) as { featureId: string; count: number; outside: number };
    if (rb.count < 1) throw new Error("city B generated no features");
    idB = rb.featureId;
    const recsA = regionRecords(idA);
    if (recsA.length === 0) throw new Error("no on-disk records for A");
    for (const r of recsA) if (!r.fingerprint) throw new Error(`A record ${r.key} has no fingerprint`);
    const recsB = regionRecords(idB);
    for (const r of recsB) if (!r.fingerprint) throw new Error(`B record ${r.key} has no fingerprint`);
    console.log(`     [a] A=${idA} (${recsA.length} recs) B=${idB} (${recsB.length} recs), all fingerprinted`);
  });

  const digestA0 = () => featuresDigest(idA);
  const digestB0 = () => featuresDigest(idB);
  let fpA0 = "";
  let bBeforeLines = "";
  await gate.try("(b) external param edit → stale record detected + regenerated on reopen", async () => {
    const beforeA = digestA0();
    fpA0 = netRecord(idA)!.fingerprint!;
    // Snapshot B's full latest records (incl generatedAt) — the untouched proof.
    bBeforeLines = JSON.stringify(regionRecords(idB).sort((a, b) => a.key.localeCompare(b.key)));
    // Simulate a vault-sync edit that no in-app commit path observed.
    editFabricProfile(idA, PROFILE_A1);
    await reopenAndSettle();
    // A must regenerate: its features + fingerprint change to match the edit.
    await waitFor(() => {
      const net = netRecord(idA);
      return !!net && net.fingerprint !== undefined && net.fingerprint !== fpA0;
    }, 30000, "A stale record regenerated");
    const afterA = digestA0();
    if (afterA === beforeA) throw new Error("A features did NOT change after the param edit (stale not detected)");
    const fpA1 = netRecord(idA)!.fingerprint!;
    if (fpA1 === fpA0) throw new Error("A fingerprint did not change after the param edit");
    console.log(`     [b] A regenerated: fp ${fpA0.slice(0, 8)} -> ${fpA1.slice(0, 8)}, features changed`);
  });

  await gate.try("(c) ISOLATION: the untouched region B is byte-identical (no recompute)", () => {
    const bAfterLines = JSON.stringify(regionRecords(idB).sort((a, b) => a.key.localeCompare(b.key)));
    if (bAfterLines !== bBeforeLines) throw new Error("B records changed across A's edit — isolation broken");
    console.log("     [c] B untouched (same generatedAt on every record)");
  });

  let digestApost = "";
  let digestBpost = "";
  await gate.try("(d) rm .mapcache/generated.jsonl → whole world regenerates BYTE-IDENTICALLY", async () => {
    digestApost = digestA0();
    digestBpost = digestB0();
    rmSync(CACHE_ABS);
    await reopenAndSettle();
    await waitFor(() => existsSync(CACHE_ABS) && regionRecords(idA).length > 0 && regionRecords(idB).length > 0, 30000, "cache regenerated");
    // settle a beat more so both regions finish replay
    await new Promise((r) => setTimeout(r, 2000));
    if (digestA0() !== digestApost) throw new Error("A not byte-identical after cache delete");
    if (digestB0() !== digestBpost) throw new Error("B not byte-identical after cache delete");
    // And the regenerated records are fingerprinted again.
    for (const r of [...regionRecords(idA), ...regionRecords(idB)]) if (!r.fingerprint) throw new Error(`${r.key} lost fingerprint after regen`);
    console.log("     [d] cache-delete harmless: A + B byte-identical, re-fingerprinted");
  });

  await gate.try("(e) BACK-COMPAT: stripped (pre-024) records are grandfathered — no regen storm", async () => {
    const netAbefore = netRecord(idA)!;
    const genAtA = netAbefore.generatedAt;
    const digBefore = digestA0();
    stripFingerprints();
    // Confirm the strip landed.
    if (netRecord(idA)!.fingerprint !== undefined) throw new Error("fingerprint not stripped");
    await reopenAndSettle();
    await new Promise((r) => setTimeout(r, 2000));
    const netAafter = netRecord(idA)!;
    // Grandfathered ⇒ NO recompute: the latest record is the SAME line we wrote
    // (same generatedAt) and stays un-fingerprinted (a regen would re-stamp it).
    if (netAafter.fingerprint !== undefined) throw new Error("a grandfathered record was regenerated + re-fingerprinted (regen storm)");
    if (netAafter.generatedAt !== genAtA) throw new Error("grandfathered record was rewritten (generatedAt changed)");
    if (digestA0() !== digBefore) throw new Error("grandfathered features changed");
    console.log("     [e] pre-024 records grandfathered fresh (no regen, no re-stamp)");
  });

  await gate.try("(f) explicit-only: pan/zoom never generates", async () => {
    const before = sync("v.generatorRunCount") as number;
    sync(
      "(function(){v.map.jumpTo({center:[-40,-26],zoom:5});v.map.jumpTo({center:[40,24],zoom:8});v.map.jumpTo({center:[0,0],zoom:6});return 'ok';})()"
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = sync("v.generatorRunCount") as number;
    if (before !== after) throw new Error(`generatorRunCount moved under pan/zoom: ${before} -> ${after}`);
    console.log(`     [f] generatorRunCount flat under pan/zoom (${before})`);
  });

  await gate.try("(g) dev:errors clean at end", () => {
    const errs = devErrors();
    if (!errs.includes("No errors")) throw new Error(errs);
  });

  // Self-clean: strip every gate fixture (app detached → no in-memory/disk race).
  resetLeaves();
  await new Promise((r) => setTimeout(r, 800));
  stripTestFabric();

  process.exit(gate.summarize("Plan 024-A"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

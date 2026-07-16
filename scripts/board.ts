#!/usr/bin/env tsx
// One board runner with health-probed restarts (plan 021 §2.3 + §2.4b item 2).
//
// The whole gate board runs in ONE persistent Obsidian process. Each live gate
// is a client script (`tsx scripts/gates/<id>.ts`) driving that shared app via
// the CLI; the board never relaunches Obsidian between gates UNLESS a health
// probe says the renderer degraded (the long-session bug: `isStyleLoaded()` →
// false everywhere, `idle` stops firing — see docs/dev-workflow.md §pitfalls). Process
// quit+relaunch is delegated to `scripts/relaunch-obsidian.sh`.
//
// RETRY ATTRIBUTION (the crux — plan 021 §2.3, advisor 2026-07-12):
// degradation produces not just spurious FAILs but *vacuous PASSes* (an
// "≤N collisions" check passes when nothing is drawn). So the discriminator is
// the PROBE AFTER each gate, not merely "between" gates:
//   - pre-gate probe unhealthy  → relaunch + re-probe (start each gate healthy)
//   - run gate, then probe:
//       post unhealthy          → result untrustworthy → relaunch, re-run gate
//                                 (capped, so a dead renderer can't loop forever)
//       post healthy + failed   → GENUINE RED (do not retry)
//       post healthy + passed   → real pass
// The between-gates probe is just gate N's post-probe serving as N+1's pre-probe.
//
// FIXTURE HYGIENE (plan 021 §2.4b item 2): after EVERY live gate, assert
// `git status --short dev-vault/` is empty. A gate that passes its own
// assertions while dirtying committed fixtures is a RED gate; the board restores
// cleanliness before continuing so one offender doesn't cascade.
//
// Usage:
//   npm run board                          # full board (prologue + every live gate)
//   npm run board -- --changed             # change-scoped: unit + selectGates() live gates
//   npm run board -- --gates=phase1,styleLoad   # explicit live-gate subset (demo/verify)
//   npm run board -- --no-prologue         # skip unit/fuzz/tsc/build (live gates only)
//   npm run board -- --probe-fail-at=1     # inject ONE probe failure at the Nth gate to
//                                          #   exercise the relaunch/resume path (verify only)
//   npm run board -- --report=path.md      # override the report path
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { obsidian, obsidianRaw, evalJs, ObsidianCliError } from "./lib/cli.js";
import { selectGates } from "./changed-gates.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_PATH = join(REPO_ROOT, "scripts/gates/coverage.json");
const RELAUNCH_SH = join(REPO_ROOT, "scripts/relaunch-obsidian.sh");
const DEFAULT_REPORT = join(REPO_ROOT, "shots/board-report.md");

const PROBE_CAMPAIGN = "ashfall"; // fictional-fantasy: always present in dev-vault
const PROBE_TIMEOUT_MS = 5000; // a healthy style settles in 1–2s (styleLoad waitForStyle) — short = fast detection
const MAX_RELAUNCH_RETRIES = 3; // per gate, before declaring the renderer un-recoverable

interface GateEntry {
  script: string;
  globs: string[];
}
interface Coverage {
  determinismCritical: string[];
  gates: Record<string, GateEntry>;
}

interface PrologueStep {
  id: string;
  cmd: string[];
}

interface ProbeReading {
  healthy: boolean;
  detail: string;
  ms: number;
  injected?: boolean;
}

interface StepResult {
  id: string;
  kind: "prologue" | "gate";
  pass: boolean;
  wallMs: number;
  detail?: string;
  probeAfter?: ProbeReading;
  relaunches: number;
  dirtied?: string; // non-empty `git status --short dev-vault/` if the gate dirtied fixtures
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

// ── process-independent prologue steps (no Obsidian needed) ──────────────────
function runShell(cmd: string[]): { status: number; ms: number } {
  const t0 = Date.now();
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd: REPO_ROOT, stdio: "inherit" });
  return { status: res.status ?? 1, ms: Date.now() - t0 };
}

// ── health probe ─────────────────────────────────────────────────────────────
// A single global tripwire the --probe-fail-at flag flips to force ONE probe
// unhealthy; it falls through to the real relaunch/resume path (advisor #2), and
// the retry runs the genuine probe. Same code path, one injected failure.
// `probeInjectionUsed` latches so the injection fires exactly ONCE total, not
// once per gate attempt (else the retry re-injects and loops to the cap).
let forceUnhealthyOnce = false;
let probeInjectionUsed = false;

/** Ensure the probe campaign's map is open (gates detach leaves at start, so a
 * probe cannot assume one is present — mirror styleLoad.issueOpen). */
async function issueOpen(campaign: string): Promise<void> {
  evalJs("app.workspace.detachLeavesOfType('campaign-map-view'); 'reset'");
  for (let i = 0; i < 6; i++) {
    const out = obsidian(`command id=campaign-map:open-map-${campaign}`);
    if (out.includes("Executed")) break;
    await sleep(1200);
  }
}

/** One instantaneous reading of the live map's render health. `queryRenderedFeatures`
 * is wrapped: a degraded renderer either returns isStyleLoaded=false or throws here. */
function readHealth(campaign: string): { healthy: boolean } & Record<string, unknown> {
  const viewExpr = `app.workspace.getLeavesOfType('campaign-map-view').map(function(l){return l.view;}).find(function(v){return v&&v.campaign&&v.campaign.id==='${campaign}'})`;
  const raw = evalJs(`(function(){
    var v = ${viewExpr};
    if (!v || !v.map) return JSON.stringify({ healthy:false, reason:'no-view' });
    var m = v.map;
    var s, loaded=false, styleLoaded=false, bg=false, querySane=false;
    try { styleLoaded = m.isStyleLoaded(); } catch(e){}
    try { s = m.getStyle(); } catch(e){ s = null; }
    try { loaded = m.loaded(); } catch(e){}
    try { bg = !!m.getLayer('background'); } catch(e){}
    try { var qr = m.queryRenderedFeatures(); querySane = Array.isArray(qr); } catch(e){ querySane = false; }
    var hasStyle = !!s && typeof s === 'object';
    return JSON.stringify({
      healthy: !!(styleLoaded && hasStyle && bg && loaded && querySane),
      styleLoaded: styleLoaded, hasStyle: hasStyle, background: bg, loaded: loaded, querySane: querySane
    });
  })()`);
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed as { healthy: boolean } & Record<string, unknown>;
}

/** Poll render health until healthy or timeout (~5s). Honors the one-shot inject. */
async function probe(label: string): Promise<ProbeReading> {
  const t0 = Date.now();
  if (forceUnhealthyOnce) {
    forceUnhealthyOnce = false;
    const r: ProbeReading = { healthy: false, detail: "INJECTED probe failure (--probe-fail-at)", ms: 0, injected: true };
    console.log(`  [probe:${label}] INJECTED unhealthy (exercising relaunch/resume path)`);
    return r;
  }
  let last: { healthy: boolean } & Record<string, unknown> = { healthy: false, reason: "not-run" };
  try {
    await issueOpen(PROBE_CAMPAIGN);
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    for (;;) {
      last = readHealth(PROBE_CAMPAIGN);
      if (last.healthy || Date.now() >= deadline) break;
      await sleep(700);
    }
  } catch (err) {
    // A CLI/eval failure here (app crashed, socket gone) is itself a degraded signal.
    last = { healthy: false, error: err instanceof ObsidianCliError ? err.message : String(err) };
  }
  const reading: ProbeReading = { healthy: !!last.healthy, detail: JSON.stringify(last), ms: Date.now() - t0 };
  console.log(`  [probe:${label}] ${reading.healthy ? "healthy" : "UNHEALTHY"} in ${reading.ms}ms — ${reading.detail}`);
  return reading;
}

// ── process control ──────────────────────────────────────────────────────────
function relaunchObsidian(): void {
  console.log("  [relaunch] quitting + relaunching Obsidian (renderer degraded) …");
  const res = spawnSync("bash", [RELAUNCH_SH], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) console.error("  [relaunch] WARN: relaunch-obsidian.sh did not confirm ready");
}

/** Reload the plugin so live gates test the freshly-built bundle (no-op-safe). */
function reloadPlugin(): void {
  try {
    obsidian("plugin:reload id=campaign-map");
  } catch (err) {
    console.error(`  [reload] plugin:reload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── fixture hygiene ──────────────────────────────────────────────────────────
/** `git status --short dev-vault/` — empty string when clean. */
function devVaultStatus(): string {
  return execFileSync("git", ["status", "--short", "--", "dev-vault/"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/** Restore dev-vault to its committed state: revert tracked edits + remove
 * untracked (non-ignored) gate leftovers. `git clean` respects .gitignore, so
 * `.mapcache/` is never touched. Vespergate real data is committed → restoring
 * to HEAD keeps it byte-intact. */
function restoreDevVault(): void {
  spawnSync("git", ["checkout", "--", "dev-vault/"], { cwd: REPO_ROOT, stdio: "inherit" });
  spawnSync("git", ["clean", "-fdq", "--", "dev-vault/"], { cwd: REPO_ROOT, stdio: "inherit" });
}

// ── live gate execution with probe-attributed retries ────────────────────────
// Hard per-gate cap: the slowest gate (procgen41) runs ~80s; 10 min means a
// wedged gate (e.g. a CLI call whose IPC reply was lost, 2026-07-13) fails
// loudly instead of hanging an unattended board forever. SIGKILL because a
// stuck obsidian CLI child ignores SIGTERM.
const GATE_TIMEOUT_MS = 600_000;
function runGateScript(script: string): { status: number; ms: number } {
  const t0 = Date.now();
  const res = spawnSync("npx", ["tsx", script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    timeout: GATE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    console.log(`  [board] gate ${script} exceeded ${GATE_TIMEOUT_MS / 1000}s cap — killed`);
  }
  return { status: res.status ?? 1, ms: Date.now() - t0 };
}

interface BoardState {
  relaunches: number;
  processBoots: number; // Obsidian (re)launches the board performed (initial process pre-exists)
}

async function runLiveGate(
  id: string,
  script: string,
  ordinal: number,
  probeFailAt: number | null,
  state: BoardState
): Promise<StepResult> {
  let relaunchesForThisGate = 0;

  for (let attempt = 0; ; attempt++) {
    // Pre-gate: every gate must START on a known-good renderer.
    const pre = await probe(`${id}:pre`);
    if (!pre.healthy) {
      relaunchObsidian();
      state.relaunches++;
      state.processBoots++;
      relaunchesForThisGate++;
      const rePre = await probe(`${id}:pre-reprobe`);
      if (!rePre.healthy) {
        if (relaunchesForThisGate >= MAX_RELAUNCH_RETRIES) {
          return { id, kind: "gate", pass: false, wallMs: 0, detail: "renderer would not recover before gate (un-recoverable)", relaunches: relaunchesForThisGate };
        }
        continue; // try relaunching again
      }
    }

    console.log(`\n--- gate ${id} (attempt ${attempt + 1}) ---`);
    const { status, ms } = runGateScript(script);
    const gatePassed = status === 0;

    // Hygiene: a gate that dirtied committed fixtures is RED regardless of status.
    const dirty = devVaultStatus();
    if (dirty) {
      console.error(`  [hygiene] gate ${id} DIRTIED dev-vault:\n${dirty}`);
      restoreDevVault();
    }

    // Post-gate probe: the discriminator. Inject a one-shot failure here if asked
    // (exactly once total, so the retry runs the genuine probe).
    if (probeFailAt !== null && ordinal === probeFailAt && !probeInjectionUsed) {
      forceUnhealthyOnce = true;
      probeInjectionUsed = true;
    }
    const post = await probe(`${id}:post`);

    if (!post.healthy) {
      // Result (pass OR fail) is untrustworthy — relaunch and re-run the gate.
      if (relaunchesForThisGate >= MAX_RELAUNCH_RETRIES) {
        return { id, kind: "gate", pass: false, wallMs: ms, detail: `renderer degraded and would not recover after ${relaunchesForThisGate} relaunch(es)`, probeAfter: post, relaunches: relaunchesForThisGate };
      }
      relaunchObsidian();
      state.relaunches++;
      state.processBoots++;
      relaunchesForThisGate++;
      continue;
    }

    // Healthy post-probe: the gate's own verdict is now trustworthy.
    if (dirty) {
      return { id, kind: "gate", pass: false, wallMs: ms, detail: `RED (fixture hygiene): dirtied dev-vault — ${dirty.split("\n").length} path(s)`, probeAfter: post, relaunches: relaunchesForThisGate, dirtied: dirty };
    }
    return { id, kind: "gate", pass: gatePassed, wallMs: ms, detail: gatePassed ? undefined : `gate exited ${status}`, probeAfter: post, relaunches: relaunchesForThisGate };
  }
}

// ── report ───────────────────────────────────────────────────────────────────
function writeReport(path: string, opts: {
  mode: string;
  results: StepResult[];
  totalMs: number;
  state: BoardState;
}): void {
  const { mode, results, totalMs, state } = opts;
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const passCount = results.filter((r) => r.pass).length;
  const lines: string[] = [];
  lines.push(`# Board report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- **Mode:** ${mode}`);
  lines.push(`- **Result:** ${passCount}/${results.length} steps passed`);
  lines.push(`- **Total wall-clock:** ${fmt(totalMs)}`);
  lines.push(`- **Probe-driven relaunches:** ${state.relaunches}`);
  lines.push(`- **Obsidian process boots (by board):** ${state.processBoots} (initial process pre-existing)`);
  lines.push("");
  lines.push("| step | kind | result | wall | relaunches | post-probe | notes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    const probe = r.probeAfter ? (r.probeAfter.healthy ? "healthy" : "UNHEALTHY") : "—";
    const notes = r.detail ? r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ") : "";
    lines.push(`| ${r.id} | ${r.kind} | ${r.pass ? "PASS" : "**FAIL**"} | ${fmt(r.wallMs)} | ${r.relaunches} | ${probe} | ${notes} |`);
  }
  lines.push("");
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    lines.push("## Failures");
    for (const f of failed) lines.push(`- **${f.id}**: ${f.detail ?? "failed"}`);
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"));
  console.log(`\nBoard report written to ${path}`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  const coverage: Coverage = JSON.parse(readFileSync(COVERAGE_PATH, "utf8"));
  const reportPath = typeof argv.report === "string" ? argv.report : DEFAULT_REPORT;
  const probeFailAt = typeof argv["probe-fail-at"] === "string" ? Number(argv["probe-fail-at"]) : null;

  // Decide the live-gate set and mode.
  let liveGateIds: string[];
  let mode: string;
  if (typeof argv.gates === "string") {
    liveGateIds = argv.gates.split(",").map((s) => s.trim()).filter(Boolean);
    mode = `explicit subset (${liveGateIds.join(", ")})`;
  } else if (argv.changed) {
    // Change-scoped: consume selectGates(). Respect its full-board escalation.
    const changed = gitChangedFiles();
    const sel = selectGates(changed, coverage);
    if (sel.escalate) {
      console.log(`== board --changed: ESCALATED to FULL board — ${sel.reason} ==`);
      liveGateIds = Object.keys(coverage.gates);
      mode = `changed→FULL (${sel.reason})`;
    } else {
      liveGateIds = sel.gates;
      mode = `changed-scope ${sel.gates.length}/${Object.keys(coverage.gates).length} — ${sel.reason}`;
    }
  } else {
    liveGateIds = Object.keys(coverage.gates);
    mode = "full board";
  }

  // Validate gate ids.
  const unknown = liveGateIds.filter((id) => !coverage.gates[id]);
  if (unknown.length) {
    console.error(`Unknown gate id(s): ${unknown.join(", ")}. Known: ${Object.keys(coverage.gates).join(", ")}`);
    process.exit(2);
  }

  // Prologue selection: full board runs everything; --changed drops the fuzz tier
  // (a scoped run isn't a generator-behavior checkpoint) but keeps build so live
  // gates test current code. `build` already runs `tsc --noEmit`; we keep tsc
  // explicit for fast-feedback ordering. `test:app` is intentionally EXCLUDED —
  // it is a single-gate wrapper fully subsumed by running gates from coverage.json.
  const noPrologue = argv["no-prologue"] === true;
  const prologue: PrologueStep[] = noPrologue
    ? []
    : argv.changed
      ? [
          { id: "unit", cmd: ["npm", "test"] },
          { id: "tsc", cmd: ["npx", "tsc", "--noEmit"] },
          { id: "build", cmd: ["npm", "run", "build"] },
        ]
      : [
          { id: "unit", cmd: ["npm", "test"] },
          { id: "fuzz", cmd: ["npm", "run", "test:fuzz"] },
          { id: "tsc", cmd: ["npx", "tsc", "--noEmit"] },
          { id: "build", cmd: ["npm", "run", "build"] },
        ];

  console.log(`== board (${mode}) ==`);
  console.log(`prologue: ${prologue.map((p) => p.id).join(", ") || "(none)"}`);
  console.log(`live gates (${liveGateIds.length}): ${liveGateIds.join(", ") || "(none)"}`);
  if (probeFailAt !== null) console.log(`(--probe-fail-at=${probeFailAt}: will inject one probe failure at that gate ordinal)`);
  console.log("");

  const t0 = Date.now();
  const results: StepResult[] = [];
  const state: BoardState = { relaunches: 0, processBoots: 0 };

  // Prologue (process-independent).
  let prologueFailed = false;
  for (const step of prologue) {
    console.log(`\n=== prologue: ${step.id} (${step.cmd.join(" ")}) ===`);
    const { status, ms } = runShell(step.cmd);
    const pass = status === 0;
    results.push({ id: step.id, kind: "prologue", pass, wallMs: ms, detail: pass ? undefined : `exited ${status}`, relaunches: 0 });
    if (!pass) {
      console.error(`prologue step ${step.id} FAILED (exit ${status}) — live gates would test a broken build; stopping the board.`);
      prologueFailed = true;
      break;
    }
  }

  // Live gates only if the build is sound (a broken bundle makes every gate meaningless).
  if (!prologueFailed && liveGateIds.length) {
    // The freshly-built bundle needs a plugin reload so gates test current code.
    if (!noPrologue) reloadPlugin();
    let ordinal = 0;
    for (const id of liveGateIds) {
      const res = await runLiveGate(id, coverage.gates[id].script, ordinal, probeFailAt, state);
      results.push(res);
      ordinal++;
    }
  }

  const totalMs = Date.now() - t0;
  writeReport(reportPath, { mode, results, totalMs, state });

  // Console summary.
  const failed = results.filter((r) => !r.pass);
  console.log(`\n== board ${failed.length ? "RED" : "GREEN"}: ${results.length - failed.length}/${results.length} — ${(totalMs / 1000).toFixed(1)}s, ${state.relaunches} relaunch(es) ==`);
  for (const r of results) {
    console.log(`  ${r.pass ? "[pass]" : "[FAIL]"} ${r.id} (${(r.wallMs / 1000).toFixed(1)}s${r.relaunches ? `, ${r.relaunches} relaunch` : ""})${r.detail ? " — " + r.detail : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}

/** Tracked (vs last green board) + untracked-but-not-ignored changes. Mirrors
 * changed-gates.ts so `--changed` scopes against the same diff. */
function gitChangedFiles(): string[] {
  const greenboardFile = join(REPO_ROOT, ".lastgreenboard");
  let ref = "b8e6e04";
  if (existsSync(greenboardFile)) {
    const v = readFileSync(greenboardFile, "utf8").trim();
    if (v) ref = v;
  }
  const tracked = execFileSync("git", ["diff", "--name-only", ref, "--"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
  return [...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean);
}

main().catch((err) => {
  console.error("board.ts crashed:", err);
  process.exit(1);
});

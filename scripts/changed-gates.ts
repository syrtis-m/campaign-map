#!/usr/bin/env tsx
// Change-scoped gate selection (plan 021 §2.5). Prints the gate set whose
// coverage globs (scripts/gates/coverage.json) intersect a diff, and can run
// them serially. Determinism-critical shared code escalates to the FULL board.
//
// The full-board runner (`scripts/board.ts`) is plan 021 phase B — this script
// is its change-scoped front end: 21-B's board consumes `selectGates()`.
//
// Usage:
//   tsx scripts/changed-gates.ts                 # diff vs last green board (.lastgreenboard), print verdict
//   tsx scripts/changed-gates.ts --ref=<sha>     # diff vs an explicit ref
//   tsx scripts/changed-gates.ts --files=a,b,c   # score an explicit file list (no git; for demos/tests)
//   tsx scripts/changed-gates.ts --run           # also execute the selected gates serially (never the full board)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_PATH = join(REPO_ROOT, "scripts/gates/coverage.json");
const GREENBOARD_FILE = join(REPO_ROOT, ".lastgreenboard");
const FALLBACK_REF = "b8e6e04"; // v4.3 full-board commit (plan 020)

interface GateEntry {
  script: string;
  globs: string[];
}
interface Coverage {
  determinismCritical: string[];
  gates: Record<string, GateEntry>;
}

/** Glob → RegExp. `**` matches any path segments (incl. none, absorbing a
 * following slash); `*` matches any run of non-slash chars. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

export interface Selection {
  escalate: boolean;
  reason: string;
  gates: string[]; // gate ids, sorted; empty when nothing matched (and not escalated)
  determinismHits: string[]; // changed files that tripped escalation
  ignored: string[]; // unit-test files skipped for gate scoping (covered by the fast tier)
}

/** A `*.test.ts` (incl. `*.fuzz.test.ts`) file is the FAST unit tier's domain,
 * never a live gate's coverage — editing one must not trigger live gates. */
function isUnitTestFile(f: string): boolean {
  return /\.test\.ts$/.test(f);
}

/** Pure: given a changed-file list and the coverage manifest, decide the gate
 * set (or escalation). No git, no IO — unit-testable and demo-friendly.
 * Unit-test files are excluded from scoping (the fast tier already runs them). */
export function selectGates(changedFiles: string[], coverage: Coverage): Selection {
  const all = changedFiles.map((f) => f.trim()).filter(Boolean);
  const ignored = all.filter(isUnitTestFile);
  const files = all.filter((f) => !isUnitTestFile(f));
  const determinismHits = files.filter((f) => matchesAny(f, coverage.determinismCritical));
  if (determinismHits.length > 0) {
    return {
      escalate: true,
      reason: `determinism-critical path changed (${determinismHits.join(", ")}) → FULL board`,
      gates: Object.keys(coverage.gates).sort(),
      determinismHits,
      ignored,
    };
  }
  const gates = Object.entries(coverage.gates)
    .filter(([, entry]) => files.some((f) => matchesAny(f, entry.globs)))
    .map(([id]) => id)
    .sort();
  return {
    escalate: false,
    reason: gates.length ? `${gates.length} gate(s) cover the changed files` : "no gate covers the changed files",
    gates,
    determinismHits: [],
    ignored,
  };
}

function resolveRef(argv: Record<string, string | boolean>): string {
  if (typeof argv.ref === "string" && argv.ref) return argv.ref;
  if (existsSync(GREENBOARD_FILE)) {
    const v = readFileSync(GREENBOARD_FILE, "utf8").trim();
    if (v) return v;
  }
  return FALLBACK_REF;
}

/** Tracked (vs ref) + untracked-but-not-ignored changes, repo-relative paths. */
function gitChangedFiles(ref: string): string[] {
  const tracked = execFileSync("git", ["diff", "--name-only", ref, "--"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return [...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

function main(): void {
  const argv = parseArgs(process.argv.slice(2));
  const coverage: Coverage = JSON.parse(readFileSync(COVERAGE_PATH, "utf8"));

  let changed: string[];
  let source: string;
  if (typeof argv.files === "string") {
    changed = argv.files.split(",");
    source = "explicit --files";
  } else {
    const ref = resolveRef(argv);
    changed = gitChangedFiles(ref);
    source = `git diff vs ${ref}`;
  }

  const sel = selectGates(changed, coverage);

  console.log(`== changed-gates (${source}) ==`);
  console.log(`changed files (${changed.length}):`);
  for (const f of changed) console.log(`  ${f}`);
  if (sel.ignored.length) {
    console.log(`(${sel.ignored.length} unit-test file(s) ignored for gate scoping — covered by the fast tier)`);
  }
  console.log("");
  if (sel.escalate) {
    console.log(`VERDICT: FULL BOARD — ${sel.reason}`);
    console.log("(run the full board via `npm run board` — plan 021 phase B)");
    return; // never auto-run the full board here
  }
  console.log(`VERDICT: changed-scope ${sel.gates.length}/${Object.keys(coverage.gates).length} — ${sel.reason}`);
  console.log(`gates: ${sel.gates.length ? sel.gates.join(", ") : "(none — fast unit tier only)"}`);

  if (argv.run && sel.gates.length) {
    console.log("\n== running selected gates serially ==");
    for (const id of sel.gates) {
      const script = coverage.gates[id].script;
      console.log(`\n--- ${id} (${script}) ---`);
      const res = spawnSync("npx", ["tsx", script], { cwd: REPO_ROOT, stdio: "inherit" });
      if (res.status !== 0) {
        console.error(`gate ${id} FAILED (exit ${res.status})`);
        process.exit(res.status ?? 1);
      }
    }
    console.log(`\nAll ${sel.gates.length} changed-scope gates passed.`);
  }
}

// Only run the CLI when invoked directly (not when imported by 21-B's board.ts / tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

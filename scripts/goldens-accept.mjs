#!/usr/bin/env node
// Regenerate ONE algorithm's committed byte-golden fixture and print a diffstat.
//
// Usage: npm run goldens:accept -- <algorithm>
//   e.g. npm run goldens:accept -- river
//
// Under the versioned-determinism policy a generator's byte-golden is EXPECTED
// to change on a deliberate version bump (edit → bump → re-golden → adopt). This
// script is that explicit re-golden step: it runs the algorithm's test file with
// vitest's `-u` (update snapshots) and reports the byte-size / digest change of
// the affected `.snap` file so the diff is reviewable before commit.
//
// EXPLICIT-ONLY: never wire this into CI, the board, or any other script — a
// golden must only ever be re-accepted by a human running this on purpose.
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit algorithm → (test file, snapshot file) map. Built by hand rather than
// inferred, because `city`'s golden lives in fields/, not `city.test.ts`.
const GOLDENS = {
  river: { test: "src/gen/river.test.ts", snap: "src/gen/__snapshots__/river.test.ts.snap" },
  forest: { test: "src/gen/forest.test.ts", snap: "src/gen/__snapshots__/forest.test.ts.snap" },
  park: { test: "src/gen/park.test.ts", snap: "src/gen/__snapshots__/park.test.ts.snap" },
  wall: { test: "src/gen/wall.test.ts", snap: "src/gen/__snapshots__/wall.test.ts.snap" },
  farmland: { test: "src/gen/farmland.test.ts", snap: "src/gen/__snapshots__/farmland.test.ts.snap" },
  mountain: { test: "src/gen/mountain.test.ts", snap: "src/gen/__snapshots__/mountain.test.ts.snap" },
  city: { test: "src/gen/fields/cityGolden.test.ts", snap: "src/gen/fields/__snapshots__/cityGolden.test.ts.snap" },
};

function snapStat(absPath) {
  if (!existsSync(absPath)) return { exists: false, bytes: 0, sha256: "—" };
  const buf = readFileSync(absPath);
  return { exists: true, bytes: statSync(absPath).size, sha256: createHash("sha256").update(buf).digest("hex").slice(0, 12) };
}

const algo = process.argv[2];
if (!algo || !GOLDENS[algo]) {
  console.error(`usage: npm run goldens:accept -- <algorithm>\n  algorithms: ${Object.keys(GOLDENS).join(", ")}`);
  process.exit(1);
}

const { test, snap } = GOLDENS[algo];
const snapAbs = join(ROOT, snap);
const before = snapStat(snapAbs);

console.log(`goldens:accept — regenerating ${algo} golden (${test})`);
try {
  execFileSync("npx", ["vitest", "run", "--config", "vitest.config.ts", "-u", test], {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch {
  console.error(`\n✗ vitest failed — golden NOT accepted for ${algo}. Fix the test run first.`);
  process.exit(1);
}

const after = snapStat(snapAbs);
const delta = after.bytes - before.bytes;
const changed = before.sha256 !== after.sha256;

console.log("\n── diffstat ─────────────────────────────────────────");
console.log(`  file    ${snap}`);
console.log(`  bytes   ${before.bytes} → ${after.bytes} (${delta >= 0 ? "+" : ""}${delta})`);
console.log(`  sha256  ${before.sha256} → ${after.sha256}  ${changed ? "CHANGED" : "unchanged"}`);
console.log("─────────────────────────────────────────────────────");
console.log(
  changed
    ? `\n${algo} golden updated. Review the .snap diff, then commit alongside the version bump that motivated it.`
    : `\n${algo} golden is byte-identical — nothing to accept.`
);

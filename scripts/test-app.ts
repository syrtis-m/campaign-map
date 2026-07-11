#!/usr/bin/env tsx
// Runs a Tier A gate:
//   `npm run test:app -- 0`          → phase gate by number (defaults to highest)
//   `npm run test:app -- styleLoad`  → a named cross-cutting gate (gates/<name>.ts)
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const arg = process.argv[2];
const gatesDir = new URL("./gates/", import.meta.url);
const files = readdirSync(gatesDir).filter((f) => f.endsWith(".ts"));
const phases = files
  .filter((f) => /^phase\d+\.ts$/.test(f))
  .map((f) => Number(f.match(/\d+/)![0]))
  .sort((a, b) => a - b);
const named = files.filter((f) => !/^phase\d+\.ts$/.test(f)).map((f) => f.replace(/\.ts$/, ""));

// A non-numeric arg selects a named gate (e.g. `styleLoad`); anything else is a phase number.
if (arg !== undefined && Number.isNaN(Number(arg))) {
  if (!named.includes(arg)) {
    console.error(`No gate script "${arg}". Named gates: ${named.join(", ") || "(none)"}`);
    process.exit(1);
  }
  const result = spawnSync("tsx", [`scripts/gates/${arg}.ts`], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const phase = arg !== undefined ? Number(arg) : phases[phases.length - 1];
if (!phases.includes(phase)) {
  console.error(`No gate script for phase ${phase}. Available: ${phases.join(", ")}`);
  process.exit(1);
}

const result = spawnSync("tsx", [`scripts/gates/phase${phase}.ts`], { stdio: "inherit" });
process.exit(result.status ?? 1);

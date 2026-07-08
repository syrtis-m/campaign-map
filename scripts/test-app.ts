#!/usr/bin/env tsx
// Runs a phase's Tier A gate: `npm run test:app -- 0` (defaults to the highest gate present).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const arg = process.argv[2];
const gatesDir = new URL("./gates/", import.meta.url);
const available = readdirSync(gatesDir)
  .filter((f) => /^phase\d+\.ts$/.test(f))
  .map((f) => Number(f.match(/\d+/)![0]))
  .sort((a, b) => a - b);

const phase = arg !== undefined ? Number(arg) : available[available.length - 1];
if (!available.includes(phase)) {
  console.error(`No gate script for phase ${phase}. Available: ${available.join(", ")}`);
  process.exit(1);
}

const result = spawnSync("tsx", [`scripts/gates/phase${phase}.ts`], { stdio: "inherit" });
process.exit(result.status ?? 1);

import { execFileSync } from "node:child_process";

const VAULT = "vault=dev-vault";

export class ObsidianCliError extends Error {}

/** Runs a single obsidian CLI command against dev-vault and returns trimmed stdout. */
export function obsidian(args: string): string {
  try {
    return execFileSync("obsidian", [VAULT, ...args.split(" ")], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new ObsidianCliError(
      `obsidian ${args} failed: ${e.stderr || e.stdout || e.message}`
    );
  }
}

/** Runs JS in the app context and returns the raw "=> ..." payload, parsed as JSON when possible. */
export function evalJs(code: string): unknown {
  const out = obsidianRaw(["eval", `code=${code}`]);
  const marker = "=> ";
  const idx = out.indexOf(marker);
  const payload = idx >= 0 ? out.slice(idx + marker.length).trim() : out.trim();
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function obsidianRaw(argv: string[]): string {
  try {
    return execFileSync("obsidian", [VAULT, ...argv], { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new ObsidianCliError(
      `obsidian ${argv.join(" ")} failed: ${e.stderr || e.stdout || e.message}`
    );
  }
}

export function devErrors(): string {
  return obsidian("dev:errors");
}

export function clearErrors(): void {
  obsidian("dev:errors clear");
}

export function screenshot(path: string): void {
  obsidianRaw(["dev:screenshot", `path=${path}`]);
}

export interface GateResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export class Gate {
  results: GateResult[] = [];

  check(name: string, pass: boolean, detail?: string): void {
    this.results.push({ name, pass, detail });
    const icon = pass ? "[pass]" : "[FAIL]";
    console.log(`  ${icon} ${name}${detail ? " — " + detail : ""}`);
  }

  async try(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      this.check(name, true);
    } catch (err) {
      this.check(name, false, err instanceof Error ? err.message : String(err));
    }
  }

  summarize(phaseName: string): number {
    const failed = this.results.filter((r) => !r.pass);
    console.log(`\n${phaseName}: ${this.results.length - failed.length}/${this.results.length} checks passed`);
    if (failed.length > 0) {
      console.log("Failed:");
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ""}`);
      return 1;
    }
    return 0;
  }
}

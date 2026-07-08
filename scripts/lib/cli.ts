import { execFileSync } from "node:child_process";

const VAULT = "vault=dev-vault";
// Default is 1MB — a dense city-band tile easily produces hundreds of block/
// footprint polygons (Phase 3 advisor review: "blocks alone were 476/tile"),
// and gate checks that pull the full `generated` array (rather than an
// in-browser-aggregated summary) can legitimately exceed the default and
// have the eval round-trip fail outright rather than just being slow.
const MAX_BUFFER = 50 * 1024 * 1024;

export class ObsidianCliError extends Error {}

/** Runs a single obsidian CLI command against dev-vault and returns trimmed stdout. */
export function obsidian(args: string): string {
  try {
    return execFileSync("obsidian", [VAULT, ...args.split(" ")], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
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
    return execFileSync("obsidian", [VAULT, ...argv], { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_BUFFER });
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

/**
 * `dev:screenshot` captures the Electron window's composited back buffer —
 * macOS suspends compositing for an occluded/unfocused window (App Nap-
 * adjacent), so an agent driving Obsidian purely via CLI (never actually
 * clicking the window) can capture a frame frozen from whenever it was
 * last visually frontmost, silently stale relative to live DOM state.
 * Force it frontmost first so the buffer we capture is the one `eval`
 * just drove.
 */
export function screenshot(path: string): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Obsidian" to activate'], { timeout: 5_000 });
  } catch {
    // Best-effort — a missing/renamed app target shouldn't block the screenshot attempt itself.
  }
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

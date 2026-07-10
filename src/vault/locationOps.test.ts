import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import { addConnection, removeConnection } from "./locationOps";

/**
 * `addConnection`/`removeConnection` only touch `app.vault.getFileByPath` and
 * `app.fileManager.processFrontMatter` — no other Obsidian API surface — so a
 * minimal fake that runs the mutator over an in-memory frontmatter object is
 * enough to exercise the real regression surface (the mutation logic itself)
 * without needing the `obsidian` package at runtime.
 */
function fakeApp(initialFrontmatter: Record<string, unknown> = {}): {
  app: App;
  frontmatter: Record<string, unknown>;
} {
  const frontmatter = { ...initialFrontmatter };
  const file = { path: "Locations/Source.md" } as unknown as TFile;
  const app = {
    vault: {
      getFileByPath: (path: string) => (path === file.path ? file : null),
    },
    fileManager: {
      processFrontMatter: async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
        if (f !== file) return;
        fn(frontmatter);
      },
    },
  } as unknown as App;
  return { app, frontmatter };
}

describe("addConnection", () => {
  it("creates the connections array when none exists", async () => {
    const { app, frontmatter } = fakeApp();
    await addConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Target"]);
  });

  it("is idempotent — connecting to the same target twice does not duplicate", async () => {
    const { app, frontmatter } = fakeApp({ connections: ["Target"] });
    await addConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Target"]);
  });

  it("is idempotent against the object form too", async () => {
    const { app, frontmatter } = fakeApp({ connections: [{ to: "Target", label: "old road" }] });
    await addConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual([{ to: "Target", label: "old road" }]);
  });

  it("stores the object form when a label is given", async () => {
    const { app, frontmatter } = fakeApp();
    await addConnection(app, "Locations/Source.md", "Target", "1 day, dangerous");
    expect(frontmatter.connections).toEqual([{ to: "Target", label: "1 day, dangerous" }]);
  });

  it("appends alongside existing connections", async () => {
    const { app, frontmatter } = fakeApp({ connections: ["Other"] });
    await addConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Other", "Target"]);
  });

  it("does nothing when the source file can't be found", async () => {
    const { app, frontmatter } = fakeApp();
    await addConnection(app, "Locations/Missing.md", "Target");
    expect(frontmatter.connections).toBeUndefined();
  });
});

describe("removeConnection", () => {
  it("deletes the matching bare-string entry", async () => {
    const { app, frontmatter } = fakeApp({ connections: ["Target", "Other"] });
    await removeConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Other"]);
  });

  it("deletes the matching object-form entry", async () => {
    const { app, frontmatter } = fakeApp({ connections: [{ to: "Target", label: "old road" }, "Other"] });
    await removeConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Other"]);
  });

  it("deletes the whole connections key once the last entry is removed", async () => {
    const { app, frontmatter } = fakeApp({ connections: ["Target"] });
    await removeConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toBeUndefined();
    expect("connections" in frontmatter).toBe(false);
  });

  it("is a no-op when connections is absent", async () => {
    const { app, frontmatter } = fakeApp();
    await removeConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toBeUndefined();
  });

  it("is a no-op when the target isn't in the list (e.g. declared from the other end)", async () => {
    const { app, frontmatter } = fakeApp({ connections: ["Other"] });
    await removeConnection(app, "Locations/Source.md", "Target");
    expect(frontmatter.connections).toEqual(["Other"]);
  });
});

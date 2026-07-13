import { defineConfig } from "vitest/config";

// Slow fuzz/stress tier (`npm run test:fuzz`) — runs at phase checkpoints and
// pre-merge only, not on every inner-loop edit (plan 021 §2.1 / §2.6 T1+).
// Includes ONLY `*.fuzz.test.ts`, the exact complement of the fast tier.
export default defineConfig({
  test: {
    include: ["src/**/*.fuzz.test.ts"],
    environment: "node",
  },
});

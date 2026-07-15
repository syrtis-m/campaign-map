import { defineConfig, configDefaults } from "vitest/config";

// Fast unit tier (`npm test`) — target <30 s wall clock (plan 021 §2.1).
// The slow fuzz/stress tests live in `*.fuzz.test.ts` and run via
// `npm run test:fuzz` (vitest.fuzz.config.ts). Every test runs in exactly one
// tier; `npm test && npm run test:fuzz` together cover the identical set.
export default defineConfig({
  test: {
    // Generator/model units live under src; the perceptual rasterizer's units
    // live beside their module under scripts (it never ships in the bundle).
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.fuzz.test.ts"],
    environment: "node",
  },
});

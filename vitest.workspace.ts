import { defineWorkspace } from "vitest/config";

const alias = {
  "@": new URL("./src", import.meta.url).pathname,
};

/**
 * Two projects split the fast, hermetic default suite from the opt-in engine
 * integration suite (see `vitest.config.ts` for the rationale).
 */
export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "unit",
      environment: "node",
      globals: false,
      include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
      exclude: ["tests/e2e/**", "tests/integration/**", "node_modules", ".next"],
    },
  },
  {
    resolve: { alias },
    test: {
      name: "integration",
      environment: "node",
      globals: false,
      include: ["tests/integration/**/*.test.ts"],
      // Real OCR (model load + inference) can be slow on a cold cache.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);

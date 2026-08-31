import { defineConfig } from "vitest/config";

/**
 * Root Vitest config (shared resolve + coverage). Test projects are defined in
 * `vitest.workspace.ts`:
 *
 *  - `unit`        — the default `pnpm test`. Hermetic: no external binaries,
 *                    models, or network. OCR/enrichment run against stubs.
 *  - `integration` — opt-in `pnpm test:lib:integration`. Exercises the real
 *                    OCR engines (ocrs CLI, PP-OCRv6) to validate subprocess
 *                    wiring; slow + environment-dependent, so excluded by
 *                    default.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/lib/db/migrations/**"],
    },
  },
});

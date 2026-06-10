/**
 * Per-test temp directory + isolated DB/DATA_DIR config.
 *
 * Vitest setup helpers commonly mutate `process.env` BEFORE the lib/config
 * module loads. Because that module reads env once at import time, this file
 * sets the env vars and re-imports the relevant modules with `vi.resetModules`.
 *
 * Usage in a test:
 *
 *   import { withTmpEnv } from "../helpers/tmp-env";
 *
 *   const { runs, db } = await withTmpEnv(async () => ({
 *     runs: await import("../../src/lib/runs"),
 *     db: await import("../../src/lib/db/client"),
 *   }));
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

let currentTmpDir: string | undefined;
const originalEnv = { ...process.env };

export function useTmpEnv() {
  beforeEach(() => {
    currentTmpDir = mkdtempSync(join(tmpdir(), "r2c-test-"));
    const env = process.env as Record<string, string | undefined>;
    env.DATA_DIR = currentTmpDir;
    env.DATABASE_URL = join(currentTmpDir, "r2c.db");
    env.NODE_ENV = "test";
    env.LOG_LEVEL = "fatal"; // keep tests quiet
    // Master kill-switch for online enrichment in tests: keeps the queue
    // from fanning out to Google Books / Open Library while the suite
    // runs. Individual tests that exercise the live-call path opt back
    // in by setting `ENRICHMENT_ENABLED=true` before importing modules.
    env.ENRICHMENT_ENABLED = "false";
    vi.resetModules();
  });

  afterEach(async () => {
    // Make sure the DB handle is released before we remove the directory.
    try {
      const mod = await import("../../src/lib/db/client");
      mod.closeDb();
    } catch {
      // module may not have been imported in a given test — fine.
    }
    if (currentTmpDir) {
      rmSync(currentTmpDir, { recursive: true, force: true });
      currentTmpDir = undefined;
    }
    process.env = { ...originalEnv };
    vi.resetModules();
  });
}

export function getTmpDir(): string {
  if (!currentTmpDir) throw new Error("useTmpEnv() must be called in beforeEach");
  return currentTmpDir;
}

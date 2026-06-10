/**
 * Resolve filesystem paths under DATA_DIR. Centralized so we can change the
 * layout (e.g. when running inside Tauri in M4) without hunting through
 * call sites.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "@/lib/config";

export function dataRoot(): string {
  return resolve(process.cwd(), config.DATA_DIR);
}

export function runDir(runId: string): string {
  return resolve(dataRoot(), "runs", runId);
}

export function ensureRunDir(runId: string): string {
  const dir = runDir(runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function sourceCsvPath(runId: string): string {
  return resolve(runDir(runId), "source.csv");
}

export function exportCsvPath(runId: string): string {
  return resolve(runDir(runId), "export.csv");
}

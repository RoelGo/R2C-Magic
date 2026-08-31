/**
 * Small `execFile` wrapper shared by the OCR engine adapters. Enforces a
 * timeout, captures stdout/stderr, and turns non-zero exits / missing binaries
 * into descriptive errors the orchestrator can record.
 */
import { execFile } from "node:child_process";

export interface RunSubprocessOptions {
  args: string[];
  timeoutMs: number;
  /** Cap captured stdout so a runaway process can't exhaust memory. */
  maxBuffer?: number;
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
}

export function runSubprocess(
  command: string,
  { args, timeoutMs, maxBuffer = 32 * 1024 * 1024 }: RunSubprocessOptions,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean };
          if (err.code === "ENOENT") {
            reject(new Error(`OCR binary not found: ${command}`));
            return;
          }
          if (err.killed) {
            reject(new Error(`OCR timed out after ${timeoutMs}ms: ${command}`));
            return;
          }
          const detail = stderr.trim() || err.message;
          reject(new Error(`OCR command failed (${command}): ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

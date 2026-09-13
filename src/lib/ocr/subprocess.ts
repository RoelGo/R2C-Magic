/**
 * Small `spawn` wrapper shared by the OCR engine adapters. Enforces a timeout,
 * captures stdout/stderr, and turns non-zero exits / missing binaries into
 * descriptive errors the orchestrator can record.
 *
 * It deliberately uses `spawn` rather than `execFile` so that a **hanging**
 * subprocess is still diagnosable: PaddleOCR reports model downloads, missing
 * shared libraries and progress on stderr, and `execFile` throws all of that
 * away when it kills the child on timeout. Here, stderr is streamed line by
 * line to an optional callback (the adapters log it) and the tail is attached
 * to every error — including the timeout one.
 */
import { spawn } from "node:child_process";

export interface RunSubprocessOptions {
  args: string[];
  timeoutMs: number;
  /** Cap captured stdout/stderr so a runaway process can't exhaust memory. */
  maxBuffer?: number;
  /** Called for each complete stderr line as it arrives (live diagnostics). */
  onStderrLine?: (line: string) => void;
}

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  /** Wall-clock duration of the child process, in milliseconds. */
  durationMs: number;
}

/** How much stderr to quote back in an error message. */
const STDERR_TAIL_CHARS = 2000;

/**
 * An error from a subprocess run, carrying the diagnostic context the caller
 * needs to log (exit code, whether it timed out, and the stderr tail).
 */
export class SubprocessError extends Error {
  constructor(
    message: string,
    readonly detail: {
      command: string;
      args: string[];
      durationMs: number;
      timedOut: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderrTail: string;
    },
  ) {
    super(message);
    this.name = "SubprocessError";
  }
}

export function runSubprocess(
  command: string,
  { args, timeoutMs, maxBuffer = 32 * 1024 * 1024, onStderrLine }: RunSubprocessOptions,
): Promise<SubprocessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stderrPending = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    // SIGTERM first so Python can unwind; SIGKILL shortly after if it ignores us.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < maxBuffer) stderr += chunk;
      if (!onStderrLine) return;
      // Emit only complete lines; hold the partial one until its newline lands.
      stderrPending += chunk;
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onStderrLine(trimmed);
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        const durationMs = Date.now() - startedAt;
        const detail = {
          command,
          args,
          durationMs,
          timedOut,
          exitCode: null,
          signal: null,
          stderrTail: tail(stderr),
        };
        if (error.code === "ENOENT") {
          reject(new SubprocessError(`OCR binary not found: ${command}`, detail));
          return;
        }
        reject(
          new SubprocessError(`OCR command could not start (${command}): ${error.message}`, detail),
        );
      });
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const durationMs = Date.now() - startedAt;
        if (onStderrLine && stderrPending.trim()) onStderrLine(stderrPending.trim());

        const detail = {
          command,
          args,
          durationMs,
          timedOut,
          exitCode: code,
          signal,
          stderrTail: tail(stderr),
        };

        if (timedOut) {
          reject(
            new SubprocessError(
              `OCR timed out after ${timeoutMs}ms (${command})${describeStderr(stderr)}`,
              detail,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new SubprocessError(
              `OCR command failed (${command}, exit ${code ?? signal})${describeStderr(stderr)}`,
              detail,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, durationMs });
      });
    });
  });
}

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

function describeStderr(stderr: string): string {
  const t = tail(stderr);
  return t ? `: ${t}` : ": no output on stderr";
}

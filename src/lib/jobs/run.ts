/**
 * Run-level orchestration: enqueue every pending book in a run, watch for
 * completion, then write the C-Series export and finalize counters.
 *
 * This is the M2 replacement for `processRunSync` in `src/lib/runs/index.ts`.
 * Important semantics:
 *
 *  - **Fire-and-forget.** `enqueueRun` returns as soon as work is
 *    scheduled. The HTTP request that triggered the upload does NOT block
 *    on enrichment.
 *  - **Sequential finalize.** When the queue drains *for this run's
 *    bookIds*, we collect the rows, write the export CSV, and flip the
 *    run to `completed`/`failed`. Other runs sharing the queue do not
 *    block this run's finalize.
 *  - **Idempotent.** Calling `enqueueRun` again on an already-running
 *    run only enqueues books still marked `pending`. That makes
 *    boot-time recovery a one-liner.
 *  - **No throwing into the queue.** Individual book failures are
 *    caught and turned into a `failed` row. A finalize that fails
 *    (disk full, etc.) is logged and the run is marked `failed`.
 */
import { writeFile } from "node:fs/promises";
import { booksToCsv } from "@/lib/csv/c-series";
import { loadMappingConfig } from "@/lib/csv/mapping";
import { getDb } from "@/lib/db/client";
import { books, exports, runs } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { exportCsvPath } from "@/lib/runs/paths";
import type { EnrichedBook } from "@/types/book";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getQueue } from "./queue";
import { processBook } from "./runner";

/**
 * Enqueue every `pending` book in a run. Returns the run ID immediately;
 * actual processing happens on the shared `p-queue`. Use `awaitRun` (in
 * tests) to wait for completion.
 */
export function enqueueRun(runId: string): { enqueued: number } {
  const db = getDb();
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`run ${runId} not found`);

  const pendingBooks = db
    .select({ id: books.id })
    .from(books)
    .where(eq(books.runId, runId))
    .all()
    .filter((row) => {
      // Re-fetch each row's status here so an idempotent re-call only
      // re-enqueues genuinely pending work.
      const status = db
        .select({ status: books.status })
        .from(books)
        .where(eq(books.id, row.id))
        .get()?.status;
      return status === "pending";
    });

  if (pendingBooks.length === 0) {
    // Nothing to do — finalize now if the run is still mid-flight.
    void finalizeRun(runId);
    return { enqueued: 0 };
  }

  db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();

  const mapping = loadMappingConfig();
  const queue = getQueue();
  const remaining = new Set(pendingBooks.map((b) => b.id));

  for (const { id } of pendingBooks) {
    void queue.add(async () => {
      try {
        await processBook(id, mapping);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ runId, bookId: id, message }, "processBook crashed");
        db.update(books)
          .set({ status: "failed", errors: [{ source: "r-series", message }] })
          .where(eq(books.id, id))
          .run();
      } finally {
        remaining.delete(id);
        if (remaining.size === 0) {
          void finalizeRun(runId);
        }
      }
    });
  }

  logger.info({ runId, enqueued: pendingBooks.length }, "enqueueRun scheduled");
  return { enqueued: pendingBooks.length };
}

/**
 * After every book in a run has reached `done` or `failed`, write the
 * C-Series export and flip `runs.status`. Safe to call multiple times —
 * the export is only written once per call, but the run row settles to
 * the same terminal state.
 */
export async function finalizeRun(runId: string): Promise<void> {
  const db = getDb();
  const mapping = loadMappingConfig();

  // Pull every book; if any are still mid-flight, abort silently — the
  // last book's `finally` block will retrigger this.
  const rows = db.select().from(books).where(eq(books.runId, runId)).all();
  if (rows.some((r) => r.status === "pending" || r.status === "enriching")) {
    return;
  }

  const enriched: EnrichedBook[] = rows.map((r) => {
    // Fallback for rows that never reached the worker (shouldn't happen
    // but keeps the export valid).
    return (
      (r.enrichedPayload as EnrichedBook | null) ?? {
        ean: r.ean,
        source: r.sourcePayload as EnrichedBook["source"],
        fieldSources: {},
        errors: [{ source: "r-series", message: "book never enriched" }],
      }
    );
  });

  try {
    const csv = booksToCsv(enriched, mapping);
    const outPath = exportCsvPath(runId);
    await writeFile(outPath, csv, "utf8");

    db.insert(exports)
      .values({
        id: ulid(),
        runId,
        filePath: outPath,
        rowCount: enriched.length,
      })
      .run();

    const failed = rows.filter((r) => r.status === "failed").length;
    const processed = rows.length - failed;
    const allFailed = failed === rows.length && rows.length > 0;

    db.update(runs)
      .set({
        status: allFailed ? "failed" : "completed",
        processedBooks: processed,
        failedBooks: failed,
      })
      .where(eq(runs.id, runId))
      .run();

    logger.info({ runId, processed, failed, exportPath: outPath }, "run finalized");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId, message }, "finalizeRun failed");
    db.update(runs).set({ status: "failed", error: message }).where(eq(runs.id, runId)).run();
  }
}

/**
 * Test helper: resolve when the queue drains AND the named run is no
 * longer `pending`/`running`. Useful in tests that enqueue a run and
 * need to assert against the final state without polling.
 */
export async function awaitRun(runId: string, timeoutMs = 30_000): Promise<void> {
  const queue = getQueue();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await queue.onIdle();
    const db = getDb();
    const row = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
    if (row?.status === "completed" || row?.status === "failed") return;
    // Queue idled but finalize hasn't flipped the status yet — yield and
    // recheck. In practice this only loops if a finalize is still in
    // progress (microtask).
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`awaitRun(${runId}) timed out after ${timeoutMs}ms`);
}

/**
 * Test ergonomics: enqueue a run and await its completion in one call.
 * Returns the path of the export CSV if one was written, or `undefined`
 * for a run that finished without producing an export (currently
 * impossible — even all-failed runs emit a CSV — but kept optional for
 * future-proofing).
 */
export async function processRunInline(
  runId: string,
): Promise<{ status: "completed" | "failed"; exportPath?: string }> {
  enqueueRun(runId);
  await awaitRun(runId);
  const db = getDb();
  const row = db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get();
  if (!row) throw new Error(`run ${runId} disappeared during processRunInline`);
  const exportRow = db
    .select({ filePath: exports.filePath })
    .from(exports)
    .where(eq(exports.runId, runId))
    .get();
  return {
    status: row.status as "completed" | "failed",
    exportPath: exportRow?.filePath,
  };
}

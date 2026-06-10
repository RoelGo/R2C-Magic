import { getDb } from "@/lib/db/client";
import { books, runs } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
/**
 * One-time boot-time recovery.
 *
 * If the server crashed mid-run, the SQLite state may have:
 *  - runs with `status = 'running'`, AND
 *  - books with `status = 'pending'` or `'enriching'`.
 *
 * On the next boot we **resume** rather than fail: pending and stuck-
 * enriching books get re-enqueued for the worker. (We chose resume over
 * fail because the self-hosted single-binary deployment may restart
 * frequently, and forcing the user to re-upload every interrupted run
 * would be hostile. This matches the decision in spec/04-enrichment.md.)
 *
 * The recovery is best-effort — if it throws, the next request will see
 * the runs still as `running` and the user can decide what to do.
 */
import { eq, inArray } from "drizzle-orm";
import { enqueueRun } from "./run";

let bootRan = false;

export function runBootRecovery(): { resumedRuns: number; reEnqueuedBooks: number } {
  if (bootRan) return { resumedRuns: 0, reEnqueuedBooks: 0 };
  bootRan = true;

  const db = getDb();

  // Reset any books left in 'enriching' to 'pending' so the queue picks
  // them up again. (Pending stays pending.)
  const stuck = db
    .update(books)
    .set({ status: "pending" })
    .where(eq(books.status, "enriching"))
    .run();

  const runningRuns = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, ["running", "pending"]))
    .all();

  let reEnqueued = 0;
  for (const { id } of runningRuns) {
    try {
      const { enqueued } = enqueueRun(id);
      reEnqueued += enqueued;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ runId: id, message }, "boot recovery: enqueueRun failed");
    }
  }

  if (runningRuns.length > 0 || stuck.changes > 0) {
    logger.info(
      {
        resumedRuns: runningRuns.length,
        reEnqueuedBooks: reEnqueued,
        resetEnriching: stuck.changes,
      },
      "boot recovery complete",
    );
  }

  return { resumedRuns: runningRuns.length, reEnqueuedBooks: reEnqueued };
}

/** Test helper: forget that recovery has run so the next call re-runs it. */
export function resetBootForTests(): void {
  bootRan = false;
}

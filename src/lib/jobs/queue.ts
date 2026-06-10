import { config } from "@/lib/config";
/**
 * Module-level p-queue instance used by the run worker.
 *
 * Sized by `ENRICH_CONCURRENCY`. Exposed as a single shared instance so
 * we cap the total in-flight book jobs across every run currently being
 * processed — running two runs in parallel doesn't double our load on
 * the upstream APIs.
 *
 * The queue is intentionally in-memory. Run state lives in SQLite so on
 * restart the worker can repopulate the queue from `books.status =
 * 'pending'` rows (see `boot.ts`). We never persist queue state itself.
 */
import PQueue from "p-queue";

let instance: PQueue | undefined;

export function getQueue(): PQueue {
  if (!instance) {
    instance = new PQueue({ concurrency: config.ENRICH_CONCURRENCY });
  }
  return instance;
}

/** Visible for tests so they can reset between cases. */
export function resetQueueForTests(): void {
  instance?.clear();
  instance = undefined;
}

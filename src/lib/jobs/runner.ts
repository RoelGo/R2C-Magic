import { config } from "@/lib/config";
import type { MappingConfig } from "@/lib/csv/mapping-schema";
import { getDb } from "@/lib/db/client";
import { books, enrichments } from "@/lib/db/schema";
import { mergeEnrichments } from "@/lib/enrichment/merge";
import { enabledSources } from "@/lib/enrichment/sources";
import type { EnrichmentSource, PartialEnrichment } from "@/lib/enrichment/sources/source";
import { logger } from "@/lib/logger";
import type { BookSource, EnrichedBook, EnrichmentSourceId } from "@/types/book";
/**
 * Single-book worker for the enrichment queue.
 *
 * One call to `processBook(bookId, runId, mapping)`:
 *  1. Marks the book row `enriching`.
 *  2. For each enabled source: consult the cache (`enrichment_cache`)
 *     within TTL, otherwise call the live adapter with a per-source
 *     `AbortController` budgeted at `ENRICH_TIMEOUT_MS`.
 *  3. Writes one `enrichments` row per source per call.
 *  4. Mirrors successful outcomes into `enrichment_cache` (real hits and
 *     genuine "not found" misses). Thrown errors are *not* cached so they
 *     retry on the next run.
 *  5. Merges everything via `mergeEnrichments` and persists the
 *     `EnrichedBook` to `books.enriched_payload`.
 *  6. Marks the book `done` (or `failed` if every source errored).
 *
 * The function never throws — DB-level errors are caught and recorded on
 * the book row so the queue worker can continue with the next book.
 */
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { getCached, putCachedHit } from "./cache";

interface SourceCall {
  /** Raw payload (always undefined for cached calls). */
  raw?: unknown;
  /** HTTP status. Null when the source threw before completing. */
  httpStatus: number | null;
  /** `data` if the call succeeded (may be `{}` for a miss). */
  data?: PartialEnrichment;
  /** `error` if the call (or cache lookup of an errored result) failed. */
  error?: string;
  /** Whether this outcome came from the cache rather than a live call. */
  cached: boolean;
}

export interface ProcessBookResult {
  status: "done" | "failed";
  errors: EnrichedBook["errors"];
}

export async function processBook(
  bookId: string,
  mapping: MappingConfig,
): Promise<ProcessBookResult> {
  const db = getDb();

  const bookRow = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!bookRow) {
    throw new Error(`book ${bookId} not found`);
  }
  const source = bookRow.sourcePayload as BookSource;
  const ean = source.kind === "r-series" ? source.rSeries.ean : source.cb.ean;

  db.update(books).set({ status: "enriching" }).where(eq(books.id, bookId)).run();
  logger.debug({ bookId, ean }, "processBook start");

  const perSource: Partial<Record<EnrichmentSourceId, PartialEnrichment>> = {};
  const errors: EnrichedBook["errors"] = [];

  // Fan out across sources in parallel. Each gets its own AbortController so
  // a slow upstream cannot cancel the others.
  await Promise.all(
    enabledSources().map(async (s) => {
      const call = await callOrUseCached(s, ean);
      // Always persist a per-source `enrichments` row so the audit trail
      // shows every attempt, including cached ones.
      recordEnrichmentRow(bookId, s.id, call);

      if (call.data !== undefined) {
        perSource[s.id] = call.data;
      }
      if (call.error !== undefined) {
        errors.push({ source: s.id, message: call.error });
      }
    }),
  );

  const merged = mergeEnrichments({ source, perSource, errors }, mapping);

  // "Failed" means every enabled source errored AND nothing else gave us a
  // usable enriched field. We still emit a row in the export CSV.
  const enabledCount = enabledSources().length;
  const allFailed = enabledCount > 0 && errors.length === enabledCount;
  const status: "done" | "failed" = allFailed ? "failed" : "done";

  db.update(books)
    .set({
      enrichedPayload: merged,
      status,
      errors: errors.length > 0 ? errors : null,
    })
    .where(eq(books.id, bookId))
    .run();

  logger.debug(
    { bookId, ean, status, errorCount: errors.length, sources: Object.keys(perSource) },
    "processBook done",
  );

  return { status, errors };
}

async function callOrUseCached(source: EnrichmentSource, ean: string): Promise<SourceCall> {
  const cached = getCached(source.id, ean);
  if (cached) {
    if (cached.kind === "hit") {
      return {
        data: cached.data,
        httpStatus: cached.httpStatus,
        cached: true,
      };
    }
    return {
      error: cached.message,
      httpStatus: cached.httpStatus,
      cached: true,
    };
  }

  // Cache miss → live call with a per-source timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ENRICH_TIMEOUT_MS);
  try {
    const result = await source.fetchByEan(ean, controller.signal);
    putCachedHit(source.id, ean, result.data, result.httpStatus);
    return {
      data: result.data,
      raw: result.raw,
      httpStatus: result.httpStatus,
      cached: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Do not cache thrown errors: transient upstream failures (5xx, 429,
    // network blips) must be retried on the next run rather than serving a
    // stale error. Only successful (or genuine "not found") results are cached.
    logger.warn({ source: source.id, ean, message }, "enrichment failed");
    return {
      error: message,
      httpStatus: null,
      cached: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function recordEnrichmentRow(bookId: string, sourceId: EnrichmentSourceId, call: SourceCall): void {
  const db = getDb();
  db.insert(enrichments)
    .values({
      id: ulid(),
      bookId,
      source: sourceId,
      payload: call.data ?? null,
      httpStatus: call.httpStatus,
      error: call.error ?? null,
    })
    .run();
}

/**
 * v2 mobile intake — background online enrichment (spec v2 Slice C).
 *
 * The moment a worker captures an EAN (US-B1/US-B2), we kick off the **same**
 * v1 enrichment building blocks — the registered online sources
 * (`enabledSources`), the shared `(source, ean)` cache, and `mergeEnrichments`
 * — against that EAN, in the background, on the shared p-queue so intake and
 * bulk runs stay within one upstream-load budget (US-C1).
 *
 * Results land on the `intake_books` row (`enrichmentStatus` +
 * `enrichedPayload` + `enrichmentErrors`) and are polled by the review screen
 * without ever blocking the worker (US-C2). A per-source "not found" returns
 * empty and never blocks; a real error is recorded but does not abort the
 * session (same contract as AGENTS.md rule #6 / v1).
 */
import { config } from "@/lib/config";
import { loadMappingConfig } from "@/lib/csv/mapping";
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { mergeEnrichments } from "@/lib/enrichment/merge";
import { enabledSources } from "@/lib/enrichment/sources";
import type { EnrichmentSource, PartialEnrichment } from "@/lib/enrichment/sources/source";
import { getCached, putCachedHit } from "@/lib/jobs/cache";
import { getQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import type { BookSource, EnrichedBook, EnrichmentSourceId } from "@/types/book";
import { and, eq } from "drizzle-orm";

/**
 * Build a minimal `BookSource` for an intake book. Intake books have only an
 * EAN at this stage (no uploaded CSV row), so we synthesise a `cb-intake`
 * source carrying just the EAN — enough for the EAN-keyed online sources and
 * the merger.
 */
function eanOnlySource(ean: string): BookSource {
  return { kind: "cb-intake", cb: { ean } };
}

/** Background enrichment lifecycle for an intake book (mirrors the DB enum). */
export type IntakeEnrichmentStatus = "idle" | "searching" | "done" | "empty" | "failed";

/** Fields that count as a "usable online match" (drives done vs empty). */
function hasUsableEnrichment(book: EnrichedBook): boolean {
  return Boolean(
    book.titleShort ||
      book.titleLong ||
      book.descriptionShort ||
      book.descriptionLong ||
      (book.authors && book.authors.length > 0) ||
      book.publisher ||
      book.weightGrams ||
      (book.coverImageUrls && book.coverImageUrls.length > 0),
  );
}

/**
 * Enqueue background enrichment for an intake book. Returns immediately; the
 * work runs on the shared queue. Marks the row `searching` synchronously so
 * the UI reflects the in-flight state right away.
 *
 * No-op (marks `empty`) when enrichment is disabled or no sources are enabled,
 * so the flow degrades to OCR/manual (US-G2) instead of hanging on "searching".
 */
export function startEnrichment(sessionId: string, bookId: string, ean: string): void {
  const db = getDb();

  if (!config.ENRICHMENT_ENABLED || enabledSources().length === 0) {
    db.update(intakeBooks)
      .set({ enrichmentStatus: "empty", updatedAt: new Date() })
      .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
      .run();
    return;
  }

  db.update(intakeBooks)
    .set({ enrichmentStatus: "searching", updatedAt: new Date() })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  // Fire-and-forget on the shared p-queue. Errors are swallowed into the row.
  void getQueue().add(() => runEnrichment(sessionId, bookId, ean));
}

/**
 * Run enrichment to completion for one intake book and persist the result.
 * Exposed (rather than only enqueued) so tests can await the full cycle
 * deterministically. Never throws — failures are recorded on the row.
 */
export async function runEnrichment(
  sessionId: string,
  bookId: string,
  ean: string,
): Promise<EnrichedBook["errors"]> {
  const db = getDb();
  const mapping = loadMappingConfig();
  const source = eanOnlySource(ean);

  const perSource: Partial<Record<EnrichmentSourceId, PartialEnrichment>> = {};
  const errors: EnrichedBook["errors"] = [];

  await Promise.all(
    enabledSources().map(async (s) => {
      const outcome = await callOrUseCached(s, ean);
      if (outcome.data !== undefined) perSource[s.id] = outcome.data;
      if (outcome.error !== undefined) errors.push({ source: s.id, message: outcome.error });
    }),
  );

  const merged = mergeEnrichments({ source, perSource, errors }, mapping);

  const enabledCount = enabledSources().length;
  const allFailed = enabledCount > 0 && errors.length === enabledCount;
  const status: IntakeEnrichmentStatus = allFailed
    ? "failed"
    : hasUsableEnrichment(merged)
      ? "done"
      : "empty";

  // Only adopt an enriched title when the row doesn't already have one from
  // another step (OCR/manual land in later slices). Title feeds the list view.
  const enrichedTitle = merged.titleShort ?? merged.titleLong ?? null;

  db.update(intakeBooks)
    .set({
      enrichmentStatus: status,
      enrichedPayload: merged,
      enrichmentErrors: errors.length > 0 ? errors : null,
      ...(enrichedTitle ? { title: enrichedTitle } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  logger.info(
    { sessionId, bookId, ean, status, errorCount: errors.length },
    "intake enrichment finished",
  );
  return errors;
}

interface SourceOutcome {
  data?: PartialEnrichment;
  error?: string;
}

/** Consult the shared cache first, else make a live call with a timeout. */
async function callOrUseCached(source: EnrichmentSource, ean: string): Promise<SourceOutcome> {
  const cached = getCached(source.id, ean);
  if (cached) {
    return cached.kind === "hit" ? { data: cached.data } : { error: cached.message };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ENRICH_TIMEOUT_MS);
  try {
    const result = await source.fetchByEan(ean, controller.signal);
    putCachedHit(source.id, ean, result.data, result.httpStatus);
    return { data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ source: source.id, ean, message }, "intake enrichment source failed");
    return { error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/** A concise set of enrichment-derived suggestions for the review UI (US-C2). */
export interface IntakeEnrichmentSnapshot {
  status: IntakeEnrichmentStatus;
  suggestions: {
    title?: string;
    authors?: string[];
    publisher?: string;
    descriptionShort?: string;
    weightGrams?: number;
    coverImageUrl?: string;
  };
  /** Per-source errors (empty unless a source hard-failed). */
  errors: EnrichedBook["errors"];
}

/**
 * Read the current enrichment state for an intake book, for the polling
 * indicator on the review screen. Returns `undefined` if the book is unknown.
 */
export function getEnrichmentSnapshot(
  sessionId: string,
  bookId: string,
): IntakeEnrichmentSnapshot | undefined {
  const db = getDb();
  const row = db
    .select({
      enrichmentStatus: intakeBooks.enrichmentStatus,
      enrichedPayload: intakeBooks.enrichedPayload,
      enrichmentErrors: intakeBooks.enrichmentErrors,
    })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!row) return undefined;

  const enriched = row.enrichedPayload as EnrichedBook | null;
  return {
    status: row.enrichmentStatus,
    suggestions: enriched
      ? {
          title: enriched.titleShort ?? enriched.titleLong,
          authors: enriched.authors,
          publisher: enriched.publisher,
          descriptionShort: enriched.descriptionShort ?? enriched.descriptionLong,
          weightGrams: enriched.weightGrams,
          coverImageUrl: enriched.coverImageUrls?.[0],
        }
      : {},
    errors: (row.enrichmentErrors as EnrichedBook["errors"] | null) ?? [],
  };
}

import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { enrichmentCache } from "@/lib/db/schema";
import type { EnrichmentSourceId } from "@/types/book";
/**
 * Read/write helpers for the global `enrichment_cache` table.
 *
 * The cache is keyed on `(source, ean)` and serves two purposes:
 *  1. Save bandwidth + rate-limit quota: multiple runs uploading the same
 *     EAN never re-hit the upstream within the TTL.
 *  2. Cache *negative* results too — both genuine misses (`{}` body) and
 *     transient errors (5xx, 429, network blips). Misses use the long TTL;
 *     errors use the shorter `ENRICH_ERROR_CACHE_TTL_HOURS` so an outage
 *     doesn't permanently lock a book out of enrichment.
 *
 * The cache is intentionally write-through: the job runner records every
 * call's outcome here before persisting to per-book `enrichments` rows.
 * That way replaying the job for a different run produces identical
 * results.
 */
import { and, eq } from "drizzle-orm";
import type { PartialEnrichment } from "../enrichment/sources/source";

export interface CachedHit {
  kind: "hit";
  data: PartialEnrichment;
  httpStatus: number | null;
  fetchedAt: Date;
}

export interface CachedError {
  kind: "error";
  message: string;
  httpStatus: number | null;
  fetchedAt: Date;
}

export type CachedOutcome = CachedHit | CachedError;

/**
 * Look up a (source, ean) pair. Returns:
 *  - `undefined` if there is no row, or the row is older than the TTL.
 *  - `{ kind: "hit", data, ... }` for a cached success (data may be `{}`).
 *  - `{ kind: "error", message, ... }` for a cached upstream error.
 */
export function getCached(
  source: EnrichmentSourceId,
  ean: string,
  now: Date = new Date(),
): CachedOutcome | undefined {
  const db = getDb();
  const row = db
    .select()
    .from(enrichmentCache)
    .where(and(eq(enrichmentCache.source, source), eq(enrichmentCache.ean, ean)))
    .get();
  if (!row) return undefined;
  if (isExpired(row.error !== null, row.fetchedAt, now)) return undefined;

  if (row.error !== null) {
    return {
      kind: "error",
      message: row.error,
      httpStatus: row.httpStatus,
      fetchedAt: row.fetchedAt,
    };
  }
  return {
    kind: "hit",
    // payload may be `{}` (cached miss) or a real PartialEnrichment.
    data: (row.payload as PartialEnrichment | null) ?? {},
    httpStatus: row.httpStatus,
    fetchedAt: row.fetchedAt,
  };
}

/** Persist a successful (or empty) result to the cache. */
export function putCachedHit(
  source: EnrichmentSourceId,
  ean: string,
  data: PartialEnrichment,
  httpStatus: number | null,
): void {
  const db = getDb();
  db.insert(enrichmentCache)
    .values({
      source,
      ean,
      payload: data,
      httpStatus,
      error: null,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [enrichmentCache.source, enrichmentCache.ean],
      set: {
        payload: data,
        httpStatus,
        error: null,
        fetchedAt: new Date(),
      },
    })
    .run();
}

/** Persist an upstream error to the cache. */
export function putCachedError(
  source: EnrichmentSourceId,
  ean: string,
  message: string,
  httpStatus: number | null,
): void {
  const db = getDb();
  db.insert(enrichmentCache)
    .values({
      source,
      ean,
      payload: null,
      httpStatus,
      error: message,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [enrichmentCache.source, enrichmentCache.ean],
      set: {
        payload: null,
        httpStatus,
        error: message,
        fetchedAt: new Date(),
      },
    })
    .run();
}

/** Visible for tests. */
export function isExpired(isError: boolean, fetchedAt: Date, now: Date): boolean {
  const ageMs = now.getTime() - fetchedAt.getTime();
  const ttlMs = isError
    ? config.ENRICH_ERROR_CACHE_TTL_HOURS * 60 * 60 * 1000
    : config.ENRICH_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  return ageMs > ttlMs;
}

import type { EnrichedBook, EnrichmentSourceId } from "@/types/book";

/**
 * Subset of an EnrichedBook that a single source can provide. The merger in
 * `lib/enrichment/merge.ts` combines partials from every source into one
 * EnrichedBook using `fieldPriority` from `mapping.config.json`.
 */
export type PartialEnrichment = Omit<
  Partial<EnrichedBook>,
  "ean" | "rSeries" | "fieldSources" | "errors"
>;

export interface FetchResult {
  /** Empty object means "no data found" (not an error). */
  data: PartialEnrichment;
  /** Optional raw payload for audit / debugging. */
  raw?: unknown;
  /** HTTP status of the underlying call. 200 if not applicable. */
  httpStatus: number;
}

export interface BookSource {
  /** Stable identifier used in mapping config, DB, logs. */
  readonly id: EnrichmentSourceId;
  /** Human-readable name for UI surfaces. */
  readonly displayName: string;
  /** Whether the source is currently enabled (e.g. has credentials). */
  isEnabled(): boolean;
  /**
   * Look up a single EAN. Implementations must:
   * - return `{ data: {} }` for "not found" (do NOT throw)
   * - throw for network / parse errors so the caller can record them
   * - respect the abort signal
   */
  fetchByEan(ean: string, signal: AbortSignal): Promise<FetchResult>;
}

import type { BookSource, EnrichedBook, EnrichmentSourceId } from "../../types/book";
/**
 * Orchestrates enrichment of a single book across all enabled sources.
 * To be wired into the job queue (M2) — for now this is the function the
 * queue worker will call once per book.
 */
import { config } from "../config";
import type { MappingConfig } from "../csv/mapping-schema";
import { logger } from "../logger";
import { mergeEnrichments } from "./merge";
import { enabledSources } from "./sources";
import type { PartialEnrichment } from "./sources/source";

export async function enrichBook(
  source: BookSource,
  mapping: MappingConfig,
): Promise<EnrichedBook> {
  const ean = source.kind === "r-series" ? source.rSeries.ean : source.cb.ean;
  const perSource: Partial<Record<EnrichmentSourceId, PartialEnrichment>> = {};
  const errors: EnrichedBook["errors"] = [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ENRICH_TIMEOUT_MS);

  try {
    await Promise.all(
      enabledSources().map(async (s) => {
        const sourceId = s.id;
        try {
          const result = await s.fetchByEan(ean, controller.signal);
          perSource[sourceId] = result.data;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ source: sourceId, message });
          logger.warn({ source: sourceId, ean, message }, "enrichment failed");
        }
      }),
    );
  } finally {
    clearTimeout(timeout);
  }

  return mergeEnrichments({ source, perSource, errors }, mapping);
}

/**
 * Convert an RSeriesRow into an EnrichedBook **without** running any online
 * enrichment. Used in M1 to exercise the full pipeline before real source
 * adapters land in M2. Once enrichment exists this becomes the seed that the
 * orchestrator augments, not the final shape.
 */
import type { EnrichedBook, RSeriesRow } from "@/types/book";

export function seedEnrichedBook(rSeries: RSeriesRow): EnrichedBook {
  return {
    ean: rSeries.ean,
    rSeries,
    // No enriched fields populated yet — every M1 export gets blank
    // description / authors / publisher / etc. The mapping engine still
    // emits the constants, ignored blanks, and R-Series-derived columns.
    fieldSources: {},
    errors: [],
  };
}

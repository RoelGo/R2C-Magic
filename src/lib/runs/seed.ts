/**
 * Convert a parsed upload row (in any supported input format) into an
 * EnrichedBook **without** running any online enrichment. Used in M1 to
 * exercise the full pipeline before real source adapters land in M2. Once
 * enrichment exists this becomes the seed that the orchestrator augments,
 * not the final shape.
 */
import type { BookSource, CbIntakeRow, EnrichedBook, RSeriesRow } from "@/types/book";

export function seedEnrichedBookFromRSeries(rSeries: RSeriesRow): EnrichedBook {
  return seed({ kind: "r-series", rSeries }, rSeries.ean);
}

export function seedEnrichedBookFromCbIntake(cb: CbIntakeRow): EnrichedBook {
  return seed({ kind: "cb-intake", cb }, cb.ean);
}

/**
 * Dispatch helper: build a seed from any BookSource. Useful when callers
 * already hold the union and don't want to re-narrow on the kind.
 */
export function seedEnrichedBookFromSource(source: BookSource): EnrichedBook {
  switch (source.kind) {
    case "r-series":
      return seedEnrichedBookFromRSeries(source.rSeries);
    case "cb-intake":
      return seedEnrichedBookFromCbIntake(source.cb);
  }
}

function seed(source: BookSource, ean: string): EnrichedBook {
  return {
    ean,
    source,
    // No enriched fields populated yet — every M1 export gets blank
    // description / authors / publisher / etc. The mapping engine still
    // emits the constants, ignored blanks, and raw-row-derived columns.
    fieldSources: {},
    errors: [],
  };
}

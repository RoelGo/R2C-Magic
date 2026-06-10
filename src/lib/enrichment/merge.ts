import type { EnrichedBook, EnrichmentSourceId, RSeriesRow } from "@/types/book";
import type { MappingConfig } from "../csv/mapping-schema";
import type { PartialEnrichment } from "./sources/source";

/**
 * Merge per-source partial enrichments into a single EnrichedBook according
 * to `fieldPriority` in the mapping config.
 *
 * Rules:
 *  - For each field, walk the priority list and take the first source that
 *    has a non-empty value.
 *  - If a field has no entry in `fieldPriority`, fall back to the global
 *    `sourcePriority` list.
 *  - Special value `"merge"` (e.g. `coverImageUrls`) unions array values
 *    across all sources in priority order, dedup preserving first-seen.
 */
export interface MergeInput {
  rSeries: RSeriesRow;
  perSource: Partial<Record<EnrichmentSourceId, PartialEnrichment>>;
  errors: EnrichedBook["errors"];
}

export function mergeEnrichments(input: MergeInput, config: MappingConfig): EnrichedBook {
  const { rSeries, perSource, errors } = input;
  const fieldSources: EnrichedBook["fieldSources"] = {};
  const out: EnrichedBook = {
    ean: rSeries.ean,
    rSeries,
    fieldSources,
    errors,
  };

  const allFields: Array<keyof PartialEnrichment> = [
    "titleShort",
    "titleLong",
    "subtitle",
    "authors",
    "publisher",
    "descriptionShort",
    "descriptionLong",
    "weightGrams",
    "dimensionsMm",
    "pages",
    "language",
    "publicationDate",
    "categories",
    "coverImageUrls",
  ];

  for (const field of allFields) {
    const policy = config.fieldPriority[field] ?? config.sourcePriority;

    if (policy === "merge") {
      const merged = mergeArrays(field, perSource, config.sourcePriority);
      if (merged.length > 0) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic field assignment
        (out as any)[field] = merged;
        fieldSources[field as keyof EnrichedBook] = "google-books"; // provenance is "merged"; pick a sentinel
      }
      continue;
    }

    for (const sourceId of policy) {
      if (sourceId === "r-series") continue; // r-series is the rSeries object, not a partial
      const candidate = perSource[sourceId]?.[field];
      if (isPresent(candidate)) {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic field assignment
        (out as any)[field] = candidate;
        fieldSources[field as keyof EnrichedBook] = sourceId;
        break;
      }
    }
  }

  return out;
}

function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function mergeArrays(
  field: keyof PartialEnrichment,
  perSource: Partial<Record<EnrichmentSourceId, PartialEnrichment>>,
  priority: readonly EnrichmentSourceId[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sourceId of priority) {
    const arr = perSource[sourceId]?.[field];
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      const s = String(v).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

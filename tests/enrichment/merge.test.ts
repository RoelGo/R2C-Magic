import { describe, expect, it } from "vitest";
import { loadMappingConfig } from "../../src/lib/csv/mapping";
import { mergeEnrichments } from "../../src/lib/enrichment/merge";
import type { BookSource, RSeriesRow } from "../../src/types/book";

const rSeries: RSeriesRow = {
  systemId: "1",
  ean: "9789462673359",
  item: "Title",
  brand: "BrandFromR",
  vendor: "Vendor",
  category: "Boeken",
  subcategories: [],
};
const source: BookSource = { kind: "r-series", rSeries };

describe("mergeEnrichments", () => {
  const config = loadMappingConfig();

  it("picks the first non-empty source per field according to fieldPriority", () => {
    const merged = mergeEnrichments(
      {
        source,
        perSource: {
          "open-library": { titleLong: "from open-library" },
          "google-books": { titleLong: "from google" },
        },
        errors: [],
      },
      config,
    );
    // titleLong priority excludes cb (not present); google-books outranks open-library
    expect(merged.titleLong).toBe("from google");
    expect(merged.fieldSources.titleLong).toBe("google-books");
  });

  it("falls back through the priority list when higher-priority sources are empty", () => {
    const merged = mergeEnrichments(
      {
        source,
        perSource: {
          "open-library": { descriptionLong: "fallback" },
        },
        errors: [],
      },
      config,
    );
    expect(merged.descriptionLong).toBe("fallback");
    expect(merged.fieldSources.descriptionLong).toBe("open-library");
  });

  it("merges and dedups coverImageUrls across sources, recording 'merged' provenance", () => {
    const merged = mergeEnrichments(
      {
        source,
        perSource: {
          "google-books": { coverImageUrls: ["a", "b"] },
          "open-library": { coverImageUrls: ["b", "c"] },
        },
        errors: [],
      },
      config,
    );
    // priority for coverImageUrls is "merge" with sourcePriority cb > google-books > open-library
    expect(merged.coverImageUrls).toEqual(["a", "b", "c"]);
    // The real per-element source is not tracked — we use a sentinel.
    expect(merged.fieldSources.coverImageUrls).toBe("merged");
  });

  it("passes through errors", () => {
    const merged = mergeEnrichments(
      {
        source,
        perSource: {},
        errors: [{ source: "google-books", message: "boom" }],
      },
      config,
    );
    expect(merged.errors).toHaveLength(1);
  });
});

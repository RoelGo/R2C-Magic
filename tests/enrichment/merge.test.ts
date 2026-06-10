import { describe, expect, it } from "vitest";
import { loadMappingConfig } from "../../src/lib/csv/mapping";
import { mergeEnrichments } from "../../src/lib/enrichment/merge";
import type { RSeriesRow } from "../../src/types/book";

const rSeries: RSeriesRow = {
  systemId: "1",
  ean: "9789462673359",
  item: "Title",
  brand: "BrandFromR",
  vendor: "Vendor",
  category: "Boeken",
  subcategories: [],
};

describe("mergeEnrichments", () => {
  const config = loadMappingConfig();

  it("picks the first non-empty source per field according to fieldPriority", () => {
    const merged = mergeEnrichments(
      {
        rSeries,
        perSource: {
          "open-library": { titleLong: "from open-library" },
          "google-books": { titleLong: "from google" },
          "kb-sru": { titleLong: "from kb-sru" },
        },
        errors: [],
      },
      config,
    );
    // titleLong priority excludes cb (not present), kb-sru wins
    expect(merged.titleLong).toBe("from kb-sru");
    expect(merged.fieldSources.titleLong).toBe("kb-sru");
  });

  it("falls back through the priority list when higher-priority sources are empty", () => {
    const merged = mergeEnrichments(
      {
        rSeries,
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

  it("merges and dedups coverImageUrls across sources", () => {
    const merged = mergeEnrichments(
      {
        rSeries,
        perSource: {
          "google-books": { coverImageUrls: ["a", "b"] },
          "open-library": { coverImageUrls: ["b", "c"] },
        },
        errors: [],
      },
      config,
    );
    // priority for coverImageUrls is "merge" with sourcePriority cb > kb-sru > google-books > open-library
    expect(merged.coverImageUrls).toEqual(["a", "b", "c"]);
  });

  it("passes through errors", () => {
    const merged = mergeEnrichments(
      {
        rSeries,
        perSource: {},
        errors: [{ source: "google-books", message: "boom" }],
      },
      config,
    );
    expect(merged.errors).toHaveLength(1);
  });
});

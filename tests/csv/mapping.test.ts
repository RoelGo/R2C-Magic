import { describe, expect, it } from "vitest";
import { applyTransforms, resolveFieldPath, stripHtml } from "../../src/lib/csv/mapping";
import type { EnrichedBook } from "../../src/types/book";

function makeBook(overrides: Partial<EnrichedBook> = {}): EnrichedBook {
  return {
    ean: "9789462673359",
    rSeries: {
      systemId: "210000000001",
      ean: "9789462673359",
      item: "Het begin van mijn leven was toen ik nog niet bestond",
      brand: "Fatima en Helen",
      vendor: "EPO",
      category: "Boeken",
      subcategories: ["Non-fictie", "Filosofie"],
    },
    titleLong: "Het begin van mijn leven was toen ik nog niet bestond",
    descriptionShort: "Een poëtisch boek.",
    descriptionLong: "<p>Een <b>poëtisch</b> boek over...</p>",
    publisher: "EPO",
    authors: ["Fatima Bouchtia", "Helen Saelens"],
    coverImageUrls: ["https://example.org/cover.jpg"],
    weightGrams: 320,
    fieldSources: {},
    errors: [],
    ...overrides,
  };
}

describe("resolveFieldPath", () => {
  const book = makeBook();

  it("reads top-level enriched fields", () => {
    expect(resolveFieldPath(book, "enriched.titleLong")).toBe(book.titleLong);
    expect(resolveFieldPath(book, "enriched.descriptionShort")).toBe(book.descriptionShort);
  });

  it("reads R-series fields", () => {
    expect(resolveFieldPath(book, "rseries.brand")).toBe("Fatima en Helen");
    expect(resolveFieldPath(book, "rseries.category")).toBe("Boeken");
    expect(resolveFieldPath(book, "rseries.item")).toBe(book.rSeries.item);
  });

  it("indexes into rseries.subcategory.N", () => {
    expect(resolveFieldPath(book, "rseries.subcategory.0")).toBe("Non-fictie");
    expect(resolveFieldPath(book, "rseries.subcategory.1")).toBe("Filosofie");
    expect(resolveFieldPath(book, "rseries.subcategory.5")).toBeUndefined();
  });

  it("returns undefined for unknown roots and missing segments", () => {
    expect(resolveFieldPath(book, "rseries.unknown")).toBeUndefined();
    expect(resolveFieldPath(book, "weird.path")).toBeUndefined();
  });
});

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>world</b></p>\n<br>")).toBe("Hello world");
  });
});

describe("applyTransforms", () => {
  it("converts arrays to comma-joined strings", () => {
    expect(applyTransforms(["a", "b"])).toBe("a, b");
  });

  it("returns empty string for nullish", () => {
    expect(applyTransforms(undefined)).toBe("");
    expect(applyTransforms(null)).toBe("");
  });

  it("strips HTML before truncating", () => {
    const out = applyTransforms("<p>Een <b>poëtisch</b> boek.</p>", {
      stripHtml: true,
      truncate: 100,
    });
    expect(out).toBe("Een poëtisch boek.");
  });

  it("truncates on word boundary near the cut and appends ellipsis", () => {
    const out = applyTransforms("a ".repeat(50).trim(), { truncate: 10 });
    expect(out).toMatch(/…$/);
    expect(out.length).toBeLessThanOrEqual(11);
  });

  it("divides numeric values", () => {
    expect(applyTransforms(320, { divide: 1000 })).toBe("0.32");
  });
});

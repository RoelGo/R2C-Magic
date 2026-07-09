import { describe, expect, it } from "vitest";
import { booksToCsv } from "../../src/lib/csv/c-series";
import { type MappingConfig, mappingConfigSchema } from "../../src/lib/csv/mapping-schema";
import type { EnrichedBook } from "../../src/types/book";

/**
 * These tests exercise the C-series rendering engine, not the production
 * `mapping.config.json` (which rokko tunes independently — that file is guarded
 * by tests/csv/mapping-config.test.ts). We drive the engine with a small,
 * self-contained mock config so the assertions stay stable regardless of how
 * the negotiated mapping evolves.
 */
function mockConfig(overrides: Record<string, unknown> = {}): MappingConfig {
  return mappingConfigSchema.parse({
    outputDelimiter: ";",
    outputLineEnding: "CRLF",
    includeErrorColumn: true,
    errorColumnName: "_enrichment_errors",
    columns: [
      { name: "Visible", type: "constant", value: "Y" },
      { name: "Brand", type: "field", from: ["enriched.publisher", "rseries.brand"] },
      { name: "Supplier", type: "ignore" },
      {
        name: "NL_Title_Short",
        type: "field",
        from: ["rseries.item", "cb.description"],
        transform: { truncate: 80 },
      },
      { name: "NL_Title_Long", type: "field", from: ["enriched.titleLong", "rseries.item"] },
      { name: "Price", type: "ignore" },
      { name: "Tax", type: "ignore" },
      { name: "Stock_Track", type: "constant", value: "Y" },
      { name: "Stock_Min", type: "constant", value: "0" },
      { name: "SKU", type: "ignore" },
      { name: "EAN", type: "field", from: ["rseries.ean", "cb.ean"] },
      { name: "NL_Category_1", type: "field", from: "rseries.category" },
      { name: "NL_Category_2", type: "field", from: "rseries.subcategory.0" },
      { name: "NL_Google_Category", type: "constant", value: "Media > Books" },
      { name: "Images", type: "computed", expression: "images" },
      { name: "Tags", type: "ignore" },
    ],
    ...overrides,
  });
}

function sampleBook(): EnrichedBook {
  return {
    ean: "9789462673359",
    source: {
      kind: "r-series",
      rSeries: {
        systemId: "210000000001",
        ean: "9789462673359",
        item: "Het begin van mijn leven was toen ik nog niet bestond",
        brand: "Fatima en Helen",
        vendor: "EPO",
        category: "Boeken",
        subcategories: ["Non-fictie"],
      },
    },
    titleLong: "Het begin van mijn leven was toen ik nog niet bestond",
    descriptionShort: "Een poëtisch boek over identiteit.",
    descriptionLong: "<p>Een <b>poëtisch</b> boek over identiteit en herinnering.</p>",
    publisher: "EPO",
    authors: ["Fatima Bouchtia", "Helen Saelens"],
    coverImageUrls: [
      "https://covers.openlibrary.org/b/id/99999-L.jpg",
      "https://covers.openlibrary.org/b/id/99999-M.jpg",
      "https://covers.openlibrary.org/b/id/99999-S.jpg",
    ],
    fieldSources: {},
    errors: [{ source: "google-books", message: "timeout" }],
  };
}

describe("booksToCsv", () => {
  const config = mockConfig();

  it("writes a header row in the configured column order", () => {
    const csv = booksToCsv([sampleBook()], config);
    const firstLine = csv.split(/\r?\n/)[0] ?? "";
    const headers = firstLine.split(";");
    expect(headers[0]).toBe("Visible");
    expect(headers[1]).toBe("Brand");
    expect(headers).toContain("EAN");
    expect(headers).toContain("NL_Title_Short");
    if (config.includeErrorColumn) {
      expect(headers).toContain(config.errorColumnName);
    }
  });

  it("excludes ignored columns (Price, Tax, SKU etc.) from the export", () => {
    const csv = booksToCsv([sampleBook()], config);
    const lines = csv.split(/\r?\n/);
    const headers = lines[0]?.split(";") ?? [];

    const ignored = ["Supplier", "Price", "Tax", "SKU", "Tags"];
    for (const name of ignored) {
      expect(headers, `column ${name} should be absent`).not.toContain(name);
    }
  });

  it("populates constants and resolved fields", () => {
    const csv = booksToCsv([sampleBook()], config);
    const [headerLine = "", dataLine = ""] = csv.split(/\r?\n/);
    const headers = headerLine.split(";");
    const data = dataLine.split(";");
    const get = (name: string) => data[headers.indexOf(name)] ?? "";

    expect(get("Visible")).toBe("Y");
    expect(get("Stock_Track")).toBe("Y");
    expect(get("Stock_Min")).toBe("0");
    expect(get("EAN")).toBe("9789462673359");
    expect(get("Brand")).toBe("EPO"); // enriched.publisher wins over rseries.brand
    expect(get("NL_Category_1")).toBe("Boeken");
    expect(get("NL_Category_2")).toBe("Non-fictie");
    expect(get("NL_Google_Category")).toBe("Media > Books");
  });

  it("falls back down the `from` chain when the first path is empty", () => {
    const book = sampleBook();
    book.publisher = undefined; // enriched.publisher empty → rseries.brand wins
    const csv = booksToCsv([book], config);
    const [headerLine = "", dataLine = ""] = csv.split(/\r?\n/);
    const headers = headerLine.split(";");
    const data = dataLine.split(";");
    expect(data[headers.indexOf("Brand")]).toBe("Fatima en Helen");
  });

  it("emits only the single best-resolution cover URL in the Images column", () => {
    const csv = booksToCsv([sampleBook()], config);
    const [headerLine = "", dataLine = ""] = csv.split(/\r?\n/);
    const headers = headerLine.split(";");
    const idx = headers.indexOf("Images");
    expect(idx).toBeGreaterThan(0);
    const value = dataLine.split(";")[idx];
    // Only the -L (largest) Open Library URL should appear; no -M or -S.
    expect(value).toContain("99999-L.jpg");
    expect(value).not.toContain("99999-M.jpg");
    expect(value).not.toContain("99999-S.jpg");
    // No multi-image separator — exactly one URL is emitted.
    expect(value).not.toContain("|");
  });

  it("writes per-row enrichment errors to the error column", () => {
    const csv = booksToCsv([sampleBook()], config);
    expect(csv).toMatch(/google-books: timeout/);
  });

  it("uses CRLF line endings by default", () => {
    const csv = booksToCsv([sampleBook()], config);
    expect(csv.includes("\r\n")).toBe(true);
  });

  it("quotes fields containing the delimiter", () => {
    const book = sampleBook();
    book.titleLong = "Title; with; semicolons";
    const csv = booksToCsv([book], config);
    expect(csv).toContain('"Title; with; semicolons"');
  });
});

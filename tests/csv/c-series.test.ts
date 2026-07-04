import { describe, expect, it } from "vitest";
import { booksToCsv } from "../../src/lib/csv/c-series";
import { loadMappingConfig } from "../../src/lib/csv/mapping";
import type { EnrichedBook } from "../../src/types/book";

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
  const config = loadMappingConfig();

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

    const ignored = [
      "Supplier",
      "Price",
      "Price_Old",
      "Price_Cost",
      "Price_Unit",
      "Unit",
      "Tax",
      "Stock_Level",
      "Stock_Alert",
      "Article_Code",
      "SKU",
      "Volume",
      "Colli",
      "Size_X",
      "Size_Y",
      "Size_Z",
      "Buy_Min",
      "Buy_Max",
      "Tags",
    ];
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
    expect(get("Stock_Disable_Sold_Out")).toBe("N");
    expect(get("Stock_Min")).toBe("0");
    expect(get("NL_Variant")).toBe("Default");
    expect(get("EAN")).toBe("9789462673359");
    expect(get("Brand")).toBe("EPO"); // enriched.publisher wins over rseries.brand
    expect(get("NL_Category_1")).toBe("Boeken");
    expect(get("NL_Category_2")).toBe("Non-fictie");
    expect(get("NL_Google_Category")).toBe("Media > Books");
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

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
    coverImageUrls: ["https://example.org/cover-a.jpg", "https://example.org/cover-b.jpg"],
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

  it("respects the ignore list: Price, Tax, SKU etc. are blank", () => {
    const csv = booksToCsv([sampleBook()], config);
    const lines = csv.split(/\r?\n/);
    const headers = lines[0]?.split(";") ?? [];
    const dataLine = lines[1]?.split(";") ?? [];

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
      const idx = headers.indexOf(name);
      expect(idx, `column ${name} present`).toBeGreaterThanOrEqual(0);
      expect(dataLine[idx], `column ${name} should be blank`).toBe("");
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

  it("computes images joined by the configured separator", () => {
    const csv = booksToCsv([sampleBook()], config);
    const [headerLine = "", dataLine = ""] = csv.split(/\r?\n/);
    const headers = headerLine.split(";");
    const idx = headers.indexOf("Images");
    expect(idx).toBeGreaterThan(0);
    const value = dataLine.split(";")[idx];
    // value may be quoted because '|' is not a special CSV char but pipe is fine
    expect(value).toContain("cover-a.jpg");
    expect(value).toContain("cover-b.jpg");
    expect(value).toContain("|");
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

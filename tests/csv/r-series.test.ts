import { describe, expect, it } from "vitest";
import { normalizeEan, parseRSeriesCsv } from "../../src/lib/csv/r-series";

const SAMPLE_CSV = `"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price","Tax","Brand","Publish to eCom","Season","Department","MSRP","Tax Class","Default Cost","Vendor","Category","Subcategory 1","Subcategory 2","Subcategory 3","Subcategory 4","Subcategory 5","Subcategory 6","Subcategory 7","Subcategory 8","Subcategory 9"
"210000000001","","9789462673359","","","Het begin van mijn leven was toen ik nog niet bestond","","0","€19.90","Yes","Fatima en Helen","No","","","19.90","Item","11.080000000","EPO","Boeken","Non-fictie","","","","","","","",""
"210000000003","","9789462673465","","","Angela Davis","","1","€25.00","Yes","Jan Reyniers","No","","","25.00","Item","14.090000000","CB","Boeken","Non-fictie","","","","","","","",""
`;

describe("normalizeEan", () => {
  it("accepts a clean 13-digit EAN", () => {
    expect(normalizeEan("9789462673359")).toBe("9789462673359");
  });

  it("strips non-digit characters", () => {
    expect(normalizeEan("978-94-6267-335-9")).toBe("9789462673359");
  });

  it("rejects short or long numbers", () => {
    expect(normalizeEan("123")).toBeUndefined();
    expect(normalizeEan("12345678901234")).toBeUndefined();
  });

  it("rejects empty strings", () => {
    expect(normalizeEan("")).toBeUndefined();
  });
});

describe("parseRSeriesCsv", () => {
  it("parses the canonical header layout", () => {
    const { rows, invalid } = parseRSeriesCsv(SAMPLE_CSV);
    expect(invalid).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("maps fields onto the canonical RSeriesRow shape", () => {
    const { rows } = parseRSeriesCsv(SAMPLE_CSV);
    expect(rows[0]).toMatchObject({
      systemId: "210000000001",
      ean: "9789462673359",
      item: "Het begin van mijn leven was toen ik nog niet bestond",
      brand: "Fatima en Helen",
      vendor: "EPO",
      category: "Boeken",
      qty: 0,
      price: "€19.90",
      defaultCost: "11.080000000",
    });
  });

  it("collects non-empty subcategories", () => {
    const { rows } = parseRSeriesCsv(SAMPLE_CSV);
    expect(rows[0]?.subcategories).toEqual(["Non-fictie"]);
  });

  it("flags rows with missing EAN as invalid", () => {
    const bad = `"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price","Tax","Brand","Publish to eCom","Season","Department","MSRP","Tax Class","Default Cost","Vendor","Category","Subcategory 1","Subcategory 2","Subcategory 3","Subcategory 4","Subcategory 5","Subcategory 6","Subcategory 7","Subcategory 8","Subcategory 9"
"X","","","","","An item","","0","","","","","","","","","","","","","","","","","","","",""
`;
    const { rows, invalid } = parseRSeriesCsv(bad);
    expect(rows).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.reason).toMatch(/EAN/i);
  });
});

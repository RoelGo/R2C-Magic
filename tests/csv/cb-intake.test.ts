import { describe, expect, it } from "vitest";
import { parseCbIntakeCsv } from "../../src/lib/csv/cb-intake";

/**
 * The fixture is a hand-typed subset of the real CB-intake template
 * (imports/Kopie van sjabloon invoer CB lightspeed - sjabloon.csv) — kept
 * inline so the tests run with no external file dependency, mirroring how
 * the R-Series parser tests are structured.
 */
const SAMPLE_CSV = [
  "EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt",
  "9789083436999,Vrouwen die oorlog zien,Victoria Amelina,,nederlands,19.2,30.00,CB,Item,1,0",
  "9789493399556,Het gore lef,Sarah Arnolds,,nederlands,12.74,22.50,CB,Item,1,0",
].join("\n");

describe("parseCbIntakeCsv", () => {
  it("maps the Dutch + English headers onto the CbIntakeRow shape", () => {
    const { rows, invalid } = parseCbIntakeCsv(SAMPLE_CSV);
    expect(invalid).toEqual([]);
    expect(rows).toHaveLength(2);

    const [a, b] = rows;
    expect(a).toMatchObject({
      ean: "9789083436999",
      description: "Vrouwen die oorlog zien",
      brand: "Victoria Amelina",
      tag: "nederlands",
      purchasePrice: "19.2",
      sellPrice: "30.00",
      supplier: "CB",
      taxClass: "Item",
      desiredStock: 1,
      reorderPoint: 0,
    });
    expect(b?.ean).toBe("9789493399556");
    expect(b?.description).toBe("Het gore lef");
  });

  it("treats empty SKU and empty stock cells as undefined / numeric", () => {
    const { rows } = parseCbIntakeCsv(SAMPLE_CSV);
    expect(rows[0]?.sku).toBeUndefined();
    expect(typeof rows[0]?.desiredStock).toBe("number");
  });

  it("rejects rows with a missing or malformed EAN", () => {
    const csv = [
      "EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt",
      ",Missing EAN,,,,,,,,,",
      "not-an-ean,Bad EAN,,,,,,,,,",
      "9789083436999,Good row,,,,,,,,,",
    ].join("\n");
    const { rows, invalid } = parseCbIntakeCsv(csv);
    expect(rows).toHaveLength(1);
    expect(invalid).toHaveLength(2);
    expect(invalid[0]?.reason).toMatch(/EAN/);
  });

  it("preserves price strings verbatim (no locale conversion)", () => {
    // The template emits "19.2" and "30.00"; both must survive untouched
    // because mapping/round-tripping happens later in the pipeline.
    const { rows } = parseCbIntakeCsv(SAMPLE_CSV);
    expect(rows[0]?.purchasePrice).toBe("19.2");
    expect(rows[0]?.sellPrice).toBe("30.00");
  });
});

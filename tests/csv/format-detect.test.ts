import { describe, expect, it } from "vitest";
import { detectInputFormat } from "../../src/lib/csv/format-detect";

describe("detectInputFormat", () => {
  it("recognises an R-Series export by 'System ID' + 'Item' headers", () => {
    const csv =
      '"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price"\n' +
      '"210000000001","","9789462673359","","","Het begin","","0","€10"';
    expect(detectInputFormat(csv)).toBe("r-series");
  });

  it("recognises a CB-intake template by 'EAN' + Dutch column headers", () => {
    const csv =
      "EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt\n" +
      "9789083436999,Vrouwen die oorlog zien,Victoria Amelina,,nederlands,19.2,30.00,CB,Item,1,0";
    expect(detectInputFormat(csv)).toBe("cb-intake");
  });

  it("returns undefined for an unrecognised header row", () => {
    const csv = "foo,bar,baz\n1,2,3";
    expect(detectInputFormat(csv)).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(detectInputFormat("")).toBeUndefined();
    expect(detectInputFormat("\n\n  ")).toBeUndefined();
  });

  it("requires 'EAN' header for CB-intake (Dutch columns alone are not enough)", () => {
    const csv = "id,aankoopprijs,verkoopprijs\n1,2,3";
    expect(detectInputFormat(csv)).toBeUndefined();
  });

  it("requires 'Item' header for R-Series (System ID alone is not enough)", () => {
    const csv = '"System ID","UPC","EAN"\n"1","",""';
    expect(detectInputFormat(csv)).toBeUndefined();
  });

  it("accepts any one of the Dutch CB signal columns", () => {
    const baseHeader = "EAN,Description";
    for (const signal of [
      "aankoopprijs",
      "verkoopprijs",
      "gewenste voorraad",
      "herbestellingspunt",
    ]) {
      const csv = `${baseHeader},${signal}\n9789083436999,foo,1`;
      expect(detectInputFormat(csv), `signal=${signal}`).toBe("cb-intake");
    }
  });
});

import { describe, expect, it } from "vitest";
import { loadMappingConfig } from "../../src/lib/csv/mapping";
import { mappingConfigSchema } from "../../src/lib/csv/mapping-schema";

describe("mapping.config.json", () => {
  it("loads and validates against the schema", () => {
    const cfg = loadMappingConfig();
    expect(() => mappingConfigSchema.parse(cfg)).not.toThrow();
  });

  it("declares exactly the 43 C-series columns from the template", () => {
    const cfg = loadMappingConfig();
    expect(cfg.columns).toHaveLength(43);
  });

  it("ignores the agreed set of columns", () => {
    const cfg = loadMappingConfig();
    const ignored = cfg.columns.filter((c) => c.type === "ignore").map((c) => c.name);
    expect(ignored.sort()).toEqual(
      [
        "Article_Code",
        "Buy_Max",
        "Buy_Min",
        "Colli",
        "Price",
        "Price_Cost",
        "Price_Old",
        "Price_Unit",
        "SKU",
        "Size_X",
        "Size_Y",
        "Size_Z",
        "Stock_Alert",
        "Stock_Level",
        "Supplier",
        "Tags",
        "Tax",
        "Unit",
        "Volume",
      ].sort(),
    );
  });
});

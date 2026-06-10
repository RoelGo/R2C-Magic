import type { RSeriesRow } from "@/types/book";
import Papa from "papaparse";
import { z } from "zod";

/**
 * R-series CSV is comma-separated, fields quoted with `"`. Header row is
 * required. Example: `imports/item_listings_local_matches.csv`.
 *
 * We are intentionally permissive: many columns are stringly-typed in the
 * export (e.g. `Price` = "€19.90"). Conversion to numbers happens in mapping.
 */

const rawRowSchema = z.object({
  "System ID": z.string().min(1),
  UPC: z.string().optional().default(""),
  EAN: z.string(),
  "Custom SKU": z.string().optional().default(""),
  "Manufact. SKU": z.string().optional().default(""),
  Item: z.string().min(1),
  "Vendor ID": z.string().optional().default(""),
  "Qty.": z.string().optional().default(""),
  Price: z.string().optional().default(""),
  Tax: z.string().optional().default(""),
  Brand: z.string().optional().default(""),
  "Publish to eCom": z.string().optional().default(""),
  Season: z.string().optional().default(""),
  Department: z.string().optional().default(""),
  MSRP: z.string().optional().default(""),
  "Tax Class": z.string().optional().default(""),
  "Default Cost": z.string().optional().default(""),
  Vendor: z.string().optional().default(""),
  Category: z.string().optional().default(""),
  "Subcategory 1": z.string().optional().default(""),
  "Subcategory 2": z.string().optional().default(""),
  "Subcategory 3": z.string().optional().default(""),
  "Subcategory 4": z.string().optional().default(""),
  "Subcategory 5": z.string().optional().default(""),
  "Subcategory 6": z.string().optional().default(""),
  "Subcategory 7": z.string().optional().default(""),
  "Subcategory 8": z.string().optional().default(""),
  "Subcategory 9": z.string().optional().default(""),
});

export interface ParseResult<TRow = RSeriesRow> {
  rows: TRow[];
  /** Rows that failed validation, with the original row index (header = 0). */
  invalid: Array<{ rowIndex: number; reason: string; raw: Record<string, unknown> }>;
}

export function parseRSeriesCsv(content: string): ParseResult<RSeriesRow> {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: ",",
  });

  const rows: RSeriesRow[] = [];
  const invalid: ParseResult<RSeriesRow>["invalid"] = [];

  parsed.data.forEach((rec, i) => {
    const result = rawRowSchema.safeParse(rec);
    if (!result.success) {
      invalid.push({ rowIndex: i + 1, reason: result.error.message, raw: rec });
      return;
    }
    const r = result.data;

    const ean = normalizeEan(r.EAN);
    if (!ean) {
      invalid.push({ rowIndex: i + 1, reason: "missing or invalid EAN", raw: rec });
      return;
    }

    rows.push({
      systemId: r["System ID"],
      upc: nonEmpty(r.UPC),
      ean,
      customSku: nonEmpty(r["Custom SKU"]),
      manufactSku: nonEmpty(r["Manufact. SKU"]),
      item: r.Item,
      vendorId: nonEmpty(r["Vendor ID"]),
      qty: parseIntSafe(r["Qty."]),
      price: nonEmpty(r.Price),
      tax: nonEmpty(r.Tax),
      brand: nonEmpty(r.Brand),
      publishToEcom: nonEmpty(r["Publish to eCom"]),
      season: nonEmpty(r.Season),
      department: nonEmpty(r.Department),
      msrp: nonEmpty(r.MSRP),
      taxClass: nonEmpty(r["Tax Class"]),
      defaultCost: nonEmpty(r["Default Cost"]),
      vendor: nonEmpty(r.Vendor),
      category: nonEmpty(r.Category),
      subcategories: [
        r["Subcategory 1"],
        r["Subcategory 2"],
        r["Subcategory 3"],
        r["Subcategory 4"],
        r["Subcategory 5"],
        r["Subcategory 6"],
        r["Subcategory 7"],
        r["Subcategory 8"],
        r["Subcategory 9"],
      ].filter((s) => s && s.length > 0),
    });
  });

  return { rows, invalid };
}

function nonEmpty(s: string | undefined): string | undefined {
  return s && s.length > 0 ? s : undefined;
}

function parseIntSafe(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

const EAN_RE = /^\d{13}$/;

/** Accepts a 13-digit EAN/ISBN-13. Returns undefined for anything else. */
export function normalizeEan(s: string): string | undefined {
  const cleaned = s.replace(/[^\d]/g, "");
  return EAN_RE.test(cleaned) ? cleaned : undefined;
}

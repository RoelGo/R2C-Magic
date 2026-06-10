import type { CbIntakeRow } from "@/types/book";
import Papa from "papaparse";
import { z } from "zod";
import { type ParseResult, normalizeEan } from "./r-series";

/**
 * Parser for the rokko CB-intake template (Google Sheets export).
 *
 * Header row (case-sensitive):
 *   EAN, Description, Brand, SKU, tag,
 *   aankoopprijs, verkoopprijs, leverancier, btw,
 *   gewenste voorraad, herbestellingspunt
 *
 * Comma-separated, fields unquoted. Stringly-typed: prices stay as strings
 * (they may use either `.` or `,` as the decimal separator depending on the
 * sheet's locale), stock fields are coerced to integers.
 *
 * Example: `imports/Kopie van sjabloon invoer CB lightspeed - sjabloon.csv`.
 */

const rawRowSchema = z.object({
  EAN: z.string(),
  Description: z.string().optional().default(""),
  Brand: z.string().optional().default(""),
  SKU: z.string().optional().default(""),
  tag: z.string().optional().default(""),
  aankoopprijs: z.string().optional().default(""),
  verkoopprijs: z.string().optional().default(""),
  leverancier: z.string().optional().default(""),
  btw: z.string().optional().default(""),
  "gewenste voorraad": z.string().optional().default(""),
  herbestellingspunt: z.string().optional().default(""),
});

export function parseCbIntakeCsv(content: string): ParseResult<CbIntakeRow> {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: ",",
  });

  const rows: CbIntakeRow[] = [];
  const invalid: ParseResult<CbIntakeRow>["invalid"] = [];

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
      ean,
      description: nonEmpty(r.Description),
      brand: nonEmpty(r.Brand),
      sku: nonEmpty(r.SKU),
      tag: nonEmpty(r.tag),
      purchasePrice: nonEmpty(r.aankoopprijs),
      sellPrice: nonEmpty(r.verkoopprijs),
      supplier: nonEmpty(r.leverancier),
      taxClass: nonEmpty(r.btw),
      desiredStock: parseIntSafe(r["gewenste voorraad"]),
      reorderPoint: parseIntSafe(r.herbestellingspunt),
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

import type { EnrichedBook } from "@/types/book";
import Papa from "papaparse";
import { computeColumn } from "./computed";
import { applyTransforms, loadMappingConfig, resolveFieldPath } from "./mapping";
import type { MappingConfig } from "./mapping-schema";

/**
 * Render a single book to its C-series row according to the loaded mapping.
 * Returns a plain object keyed by output column name; ignored columns are
 * omitted entirely so they do not appear in the export.
 */
export function bookToRow(book: EnrichedBook, config: MappingConfig): Record<string, string> {
  const row: Record<string, string> = {};

  for (const col of config.columns) {
    switch (col.type) {
      case "constant":
        row[col.name] = col.value;
        break;
      case "ignore":
        // Excluded from output — column is intentionally skipped.
        break;
      case "field": {
        const paths = Array.isArray(col.from) ? col.from : [col.from];
        let value: unknown;
        for (const p of paths) {
          value = resolveFieldPath(book, p);
          if (value != null && value !== "") break;
        }
        row[col.name] = applyTransforms(value, col.transform);
        break;
      }
      case "computed":
        row[col.name] = computeColumn(col.expression, book, config);
        break;
    }
  }

  if (config.includeErrorColumn) {
    row[config.errorColumnName] = book.errors.map((e) => `${e.source}: ${e.message}`).join("; ");
  }
  return row;
}

/**
 * Render the full C-series CSV string for a batch of enriched books.
 * Uses the configured delimiter, line ending, and optional UTF-8 BOM
 * (helpful for Excel users on Windows).
 */
export function booksToCsv(books: EnrichedBook[], configOverride?: MappingConfig): string {
  const config = configOverride ?? loadMappingConfig();

  const headers = config.columns.filter((c) => c.type !== "ignore").map((c) => c.name);
  if (config.includeErrorColumn) headers.push(config.errorColumnName);

  const rows = books.map((b) => bookToRow(b, config));

  const newline = config.outputLineEnding === "CRLF" ? "\r\n" : "\n";
  const csv = Papa.unparse(
    {
      fields: headers,
      data: rows.map((r) => headers.map((h) => r[h] ?? "")),
    },
    {
      delimiter: config.outputDelimiter,
      newline,
      quotes: needsQuoting,
      header: true,
    },
  );

  return config.outputBom ? `\uFEFF${csv}` : csv;
}

/** Quote any field that contains the delimiter, quotes, or newlines. */
function needsQuoting(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value);
  return /["\r\n;,]/.test(s);
}

import type { InputFormat } from "@/types/book";
import Papa from "papaparse";

/**
 * Sniff the first row of an uploaded CSV to decide which parser to dispatch.
 *
 * Returns:
 *   - `"r-series"`   when the header contains both `System ID` and `Item`
 *   - `"cb-intake"`  when the header contains `EAN` and at least one of the
 *                    Dutch template-only columns (aankoopprijs / verkoopprijs
 *                    / gewenste voorraad / herbestellingspunt). The Dutch
 *                    headers are the distinguishing signal — a generic
 *                    EAN-only export could otherwise be ambiguous.
 *   - `undefined`    when neither shape matches; the caller should surface a
 *                    "could not recognise format" error to the user.
 *
 * Header matching is case-sensitive on purpose: both source files (Lightspeed
 * R-Series export and the Google Sheets template) emit stable header casing,
 * and a fuzzy match risks silently classifying a corrupted export.
 */
export function detectInputFormat(content: string): InputFormat | undefined {
  const headers = readHeaderRow(content);
  if (!headers) return undefined;
  const set = new Set(headers);

  if (set.has("System ID") && set.has("Item")) return "r-series";

  if (set.has("EAN")) {
    const cbSignals = ["aankoopprijs", "verkoopprijs", "gewenste voorraad", "herbestellingspunt"];
    if (cbSignals.some((h) => set.has(h))) return "cb-intake";
  }

  return undefined;
}

/**
 * Parse just enough of the CSV to grab the header row. Uses Papa.parse with
 * `preview: 1` so we don't pay to materialise the whole file twice.
 */
function readHeaderRow(content: string): string[] | undefined {
  const trimmed = content.trimStart();
  if (trimmed.length === 0) return undefined;

  const parsed = Papa.parse<string[]>(trimmed, {
    header: false,
    preview: 1,
    skipEmptyLines: true,
    delimiter: ",",
  });

  const first = parsed.data[0];
  if (!Array.isArray(first) || first.length === 0) return undefined;

  // Strip surrounding quotes that Papa already removed, then trim whitespace.
  return first.map((h) => (typeof h === "string" ? h.trim() : ""));
}

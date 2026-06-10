import type { EnrichedBook } from "@/types/book";
import { stripHtml } from "./mapping";
import type { MappingConfig } from "./mapping-schema";

/**
 * Computed columns whose value is derived from multiple fields. Referenced
 * by `mapping.config.json` via `{ "type": "computed", "expression": "<name>" }`.
 */
export type ComputedExpression = "metaTitle" | "metaKeywords" | "images";

export function computeColumn(
  expression: ComputedExpression,
  book: EnrichedBook,
  config: MappingConfig,
): string {
  switch (expression) {
    case "metaTitle":
      return metaTitle(book);
    case "metaKeywords":
      return metaKeywords(book);
    case "images":
      return images(book, config.imageSeparator);
  }
}

function metaTitle(book: EnrichedBook): string {
  const title = book.titleShort ?? rawTitle(book);
  const author = book.authors?.[0];
  return author ? `${title} – ${author}` : title;
}

/**
 * Fall back to the raw upload row's title field when no enriched title is
 * available. Each input format names this differently.
 */
function rawTitle(book: EnrichedBook): string {
  switch (book.source.kind) {
    case "r-series":
      return book.source.rSeries.item;
    case "cb-intake":
      return book.source.cb.description ?? "";
  }
}

function metaKeywords(book: EnrichedBook): string {
  const parts = new Set<string>();
  for (const a of book.authors ?? []) parts.add(a);
  if (book.publisher) parts.add(book.publisher);
  for (const c of book.categories ?? []) parts.add(c);
  return Array.from(parts).filter(Boolean).join(", ");
}

function images(book: EnrichedBook, separator: string): string {
  const urls = book.coverImageUrls ?? [];
  return urls
    .map((u) => stripHtml(u).trim())
    .filter(Boolean)
    .join(separator);
}

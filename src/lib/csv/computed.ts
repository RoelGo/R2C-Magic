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

function images(book: EnrichedBook, _separator: string): string {
  const best = pickPrimaryCover(book.coverImageUrls ?? []);
  return best ? stripHtml(best).trim() : "";
}

/**
 * Pick the single best-resolution cover URL from an ordered list.
 *
 * The input list is already in source-priority + largest-first order (as
 * produced by mergeEnrichments). We reduce same-cover, multi-resolution
 * groups to one URL each, then return the best URL of the first group.
 *
 * Grouping heuristics (URL-pattern only — no network fetch):
 *   - Open Library  `covers.openlibrary.org/b/id/<id>-<S>.jpg`
 *     Group key = numeric `<id>`. Prefer L > M > S within the group.
 *   - Google Books  `books.google.com/…?id=<id>&…`
 *     Group key = `id` query-param value.
 *     Within the group the input order is already largest-first, so the
 *     first URL wins.
 *   - Unknown host  each URL is its own group (no collapsing).
 *
 * Returns `undefined` for an empty list.
 */
export function pickPrimaryCover(urls: string[]): string | undefined {
  if (urls.length === 0) return undefined;

  // Assign a group key and an intra-group rank to each URL.
  // Rank: lower = better (0 is best).
  type Candidate = { url: string; groupKey: string; rank: number };
  const candidates: Candidate[] = urls.map((url) => {
    const olMatch = url.match(/covers\.openlibrary\.org\/b\/id\/(\d+)-([LMS])\.jpg/i);
    if (olMatch) {
      const [, id, size] = olMatch;
      const rank = size === "L" ? 0 : size === "M" ? 1 : 2;
      return { url, groupKey: `ol:${id}`, rank };
    }

    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes("books.google.")) {
        const id = parsed.searchParams.get("id");
        if (id) return { url, groupKey: `gb:${id}`, rank: 0 }; // input is already largest-first
      }
    } catch {
      // not a valid URL — treat as its own group
    }

    return { url, groupKey: `unknown:${url}`, rank: 0 };
  });

  // Walk in input order; for each group keep only the best-ranked candidate.
  const groupBest = new Map<string, Candidate>();
  const groupOrder: string[] = []; // insertion order = source-priority order

  for (const c of candidates) {
    const existing = groupBest.get(c.groupKey);
    if (!existing) {
      groupBest.set(c.groupKey, c);
      groupOrder.push(c.groupKey);
    } else if (c.rank < existing.rank) {
      groupBest.set(c.groupKey, c);
    }
  }

  // Return the best URL of the first (highest-priority) group.
  const firstKey = groupOrder[0];
  return firstKey ? groupBest.get(firstKey)?.url : undefined;
}

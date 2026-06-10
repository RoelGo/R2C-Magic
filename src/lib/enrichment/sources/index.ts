import { googleBooksSource } from "./google-books";
import { kbSruSource } from "./kb-sru";
import { openLibrarySource } from "./open-library";
import type { BookSource } from "./source";

/**
 * The registry of enrichment sources. Order here is the *fallback* order
 * for resolution; per-field priority is configured in `mapping.config.json`.
 *
 * To add a new source: implement the BookSource interface in
 * `src/lib/enrichment/sources/<name>.ts` and append it here.
 */
export const allSources: readonly BookSource[] = [
  kbSruSource,
  googleBooksSource,
  openLibrarySource,
] as const;

export function enabledSources(): readonly BookSource[] {
  return allSources.filter((s) => s.isEnabled());
}

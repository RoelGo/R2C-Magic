import { googleBooksSource } from "./google-books";
import { openLibrarySource } from "./open-library";
import type { EnrichmentSource } from "./source";

/**
 * The registry of enrichment sources. Order here is the *fallback* order
 * for resolution; per-field priority is configured in `mapping.config.json`.
 *
 * To add a new source: implement the EnrichmentSource interface in
 * `src/lib/enrichment/sources/<name>.ts` and append it here.
 */
export const allSources: readonly EnrichmentSource[] = [
  googleBooksSource,
  openLibrarySource,
] as const;

export function enabledSources(): readonly EnrichmentSource[] {
  return allSources.filter((s) => s.isEnabled());
}

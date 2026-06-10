import { config } from "@/lib/config";
import type { EnrichmentSource, FetchResult } from "./source";

/**
 * Google Books API adapter. Endpoint:
 *   https://www.googleapis.com/books/v1/volumes?q=isbn:<EAN>
 *
 * Stub: parses the volume shape but does not yet handle pagination,
 * thumbnail upgrades (http -> https + zoom param), or category normalization.
 * To be completed in M2.
 */
export const googleBooksSource: EnrichmentSource = {
  id: "google-books",
  displayName: "Google Books",

  isEnabled() {
    return true; // works without an API key, key just raises the quota
  },

  async fetchByEan(_ean: string, _signal: AbortSignal): Promise<FetchResult> {
    // TODO(M2): implement
    //  1. fetch `https://www.googleapis.com/books/v1/volumes?q=isbn:${ean}` (+ &key=)
    //  2. pick items[0].volumeInfo
    //  3. map to PartialEnrichment (title, subtitle, authors, publisher,
    //     publishedDate, description, pageCount, categories, imageLinks.*)
    //  4. honor signal via AbortController
    //  5. use config.ENRICH_TIMEOUT_MS as the request timeout
    void config.GOOGLE_BOOKS_API_KEY;
    return { data: {}, httpStatus: 501 };
  },
};

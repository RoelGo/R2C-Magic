import { config } from "@/lib/config";
import type { BookSource, FetchResult } from "./source";

/**
 * Open Library adapter. Endpoints used:
 *   https://openlibrary.org/api/books?bibkeys=ISBN:<EAN>&format=json&jscmd=data
 *   https://openlibrary.org/isbn/<EAN>.json   (for description + works link)
 *
 * Open Library asks all clients to set a descriptive User-Agent. See
 * https://openlibrary.org/dev/docs/api/bots
 *
 * Stub: full implementation in M2.
 */
export const openLibrarySource: BookSource = {
  id: "open-library",
  displayName: "Open Library",

  isEnabled() {
    return true;
  },

  async fetchByEan(_ean: string, _signal: AbortSignal): Promise<FetchResult> {
    // TODO(M2): implement
    //  - Set User-Agent: config.OPEN_LIBRARY_USER_AGENT
    //  - Combine /api/books (rich metadata, covers) with /isbn/<ean>.json (description)
    //  - Map to PartialEnrichment
    void config.OPEN_LIBRARY_USER_AGENT;
    return { data: {}, httpStatus: 501 };
  },
};

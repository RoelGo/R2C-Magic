import type { BookSource, FetchResult } from "./source";

/**
 * KB SRU (Koninklijke Bibliotheek, Dutch National Library) adapter.
 *
 * SRU endpoint:
 *   https://jsru.kb.nl/sru/sru.bibliotheken?version=1.2&operation=searchRetrieve
 *     &recordSchema=dcx&maximumRecords=1&query=isbn=<EAN>
 *
 * Returns Dublin Core XML. Strong coverage for Dutch-language titles (rokko's
 * primary market). No auth, no API key, no rate limits.
 *
 * Stub: full implementation in M2.
 */
export const kbSruSource: BookSource = {
  id: "kb-sru",
  displayName: "KB (Koninklijke Bibliotheek)",

  isEnabled() {
    return true;
  },

  async fetchByEan(_ean: string, _signal: AbortSignal): Promise<FetchResult> {
    // TODO(M2): implement
    //  - GET the SRU URL with query=isbn=<ean>
    //  - Parse XML (use `fast-xml-parser` — to be added as a dep in M2)
    //  - Map Dublin Core fields:
    //      dc:title         -> titleLong
    //      dc:creator       -> authors
    //      dc:publisher     -> publisher
    //      dc:date          -> publicationDate
    //      dc:description   -> descriptionLong
    //      dc:subject       -> categories
    //      dc:language      -> language
    return { data: {}, httpStatus: 501 };
  },
};

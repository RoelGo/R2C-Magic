/**
 * Fetch stub for the M2 end-to-end test. Routes outgoing requests by URL:
 *
 *  - `https://www.googleapis.com/books/v1/volumes?q=isbn:<EAN>...`
 *    → serves `tests/enrichment/sources/__fixtures__/google-books/<EAN>-found.json`
 *      if present, otherwise an empty `{ totalItems: 0, items: [] }` response.
 *
 *  - `https://openlibrary.org/api/books?bibkeys=ISBN:<EAN>...`
 *    → always serves an empty `{}` body. The actual sample CSV is Dutch
 *      books with zero Open Library coverage (verified against the live
 *      API during fixture selection — see piece 5 commit message), so the
 *      e2e encodes that reality rather than fabricating hits.
 *
 *  - `https://openlibrary.org/isbn/<EAN>.json` and any subsequent
 *    `/works/...json` calls → 404. The Open Library adapter is designed
 *    to fall back gracefully when step 1 yields no record.
 *
 * Any unmatched URL throws — we'd rather a noisy test failure than
 * silently masking an unexpected network call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_ROOT = join(import.meta.dirname, "..", "enrichment", "sources", "__fixtures__");

/**
 * EANs for which we have a real captured Google Books fixture. Anything
 * outside this set falls through to the synthetic empty response.
 */
const GOOGLE_BOOKS_HITS = new Set<string>([
  "9789083436999", // Vrouwen die oorlog zien — has a description
  "9789403139838", // Gewone mensen dragen geen machinegeweren
  "9789045132129", // Wij komen in vrede
  "9789401305365", // Een vlecht van heilig gras
  "9789029097260", // Zwemmen in het donker
]);

/**
 * EANs we expect Google Books to *not* find. We have a real captured
 * "not found" fixture for the Dutch-EAN gap case (see piece 2 commit
 * `065a39e`) but anything else just gets the synthetic empty response.
 */
const GOOGLE_BOOKS_KNOWN_MISSES = new Set<string>([
  "9789089684592", // Op een dag zal iedereen hier altijd tegen zijn geweest
]);

interface StubStats {
  googleBooksHits: number;
  googleBooksMisses: number;
  openLibraryMisses: number;
  unexpected: string[];
}

/**
 * Install a `globalThis.fetch` stub for the duration of a test. Returns
 * a cleanup function (restores the previous fetch) and a stats object
 * the test can assert on.
 */
export function installM2FetchStub(): { restore: () => void; stats: StubStats } {
  const original = globalThis.fetch;
  const stats: StubStats = {
    googleBooksHits: 0,
    googleBooksMisses: 0,
    openLibraryMisses: 0,
    unexpected: [],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // --- Google Books ---
    // The adapter builds the query via `URL.searchParams`, which encodes
    // the `:` separator as `%3A`. Match both shapes so the stub is robust
    // against the adapter changing its URL-construction style.
    const gbMatch = url.match(
      /^https:\/\/www\.googleapis\.com\/books\/v1\/volumes\?.*q=isbn(?::|%3A)(\d+)/,
    );
    if (gbMatch?.[1]) {
      const ean = gbMatch[1];
      if (GOOGLE_BOOKS_HITS.has(ean)) {
        stats.googleBooksHits += 1;
        return jsonResponse(readFixture("google-books", `${ean}-found.json`), 200);
      }
      if (GOOGLE_BOOKS_KNOWN_MISSES.has(ean)) {
        stats.googleBooksMisses += 1;
        return jsonResponse(readFixture("google-books", `${ean}-not-found.json`), 200);
      }
      // Unknown EAN: synthesize an empty response. This keeps the test
      // self-contained when the sample CSV grows — adding rows doesn't
      // require capturing new fixtures, they just resolve to "not found".
      stats.googleBooksMisses += 1;
      return jsonResponse('{"kind":"books#volumes","totalItems":0}', 200);
    }

    // --- Open Library (step 1: /api/books) ---
    if (url.match(/^https:\/\/openlibrary\.org\/api\/books\?bibkeys=ISBN:/)) {
      stats.openLibraryMisses += 1;
      return jsonResponse("{}", 200);
    }

    // --- Open Library (step 2 + 3 fallback: /isbn/.json, /works/.json) ---
    // The OL adapter only falls through here if step 1 returned a record,
    // which our stub never does — but defending against schema changes
    // is cheap.
    if (url.match(/^https:\/\/openlibrary\.org\/(isbn|works)\//)) {
      return new Response(null, { status: 404 });
    }

    // Anything else is a real bug — record it and fail loudly.
    stats.unexpected.push(url);
    throw new Error(`m2 fetch stub: unexpected URL ${url}`);
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    stats,
  };
}

function readFixture(source: string, file: string): string {
  return readFileSync(join(FIXTURE_ROOT, source, file), "utf8");
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

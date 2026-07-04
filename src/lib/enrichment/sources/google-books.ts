import { config } from "@/lib/config";
import { z } from "zod";
import type { EnrichmentSource, FetchResult, PartialEnrichment } from "./source";

/**
 * Google Books API adapter. Endpoint:
 *   GET https://www.googleapis.com/books/v1/volumes?q=isbn:<EAN>
 *
 * Without an API key, anonymous calls are sharply rate-limited (we see
 * HTTP 429 after just a handful of requests). Setting `GOOGLE_BOOKS_API_KEY`
 * raises the quota substantially. Either way, 429 is reported as an
 * adapter error so the orchestrator records it; the rest of the pipeline
 * continues with whatever other sources returned.
 */

// Loose by design: the volumeInfo shape varies between volumes, and we want
// to tolerate fields disappearing without breaking enrichment of every
// other book on the same run.
const volumeInfoSchema = z
  .object({
    title: z.string().optional(),
    subtitle: z.string().optional(),
    authors: z.array(z.string()).optional(),
    publisher: z.string().optional(),
    publishedDate: z.string().optional(),
    description: z.string().optional(),
    pageCount: z.number().int().nonnegative().optional(),
    categories: z.array(z.string()).optional(),
    language: z.string().optional(),
    imageLinks: z
      .object({
        smallThumbnail: z.string().optional(),
        thumbnail: z.string().optional(),
        small: z.string().optional(),
        medium: z.string().optional(),
        large: z.string().optional(),
        extraLarge: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

const volumeSchema = z
  .object({
    id: z.string().optional(),
    volumeInfo: volumeInfoSchema.optional(),
  })
  .passthrough();

const volumesResponseSchema = z
  .object({
    kind: z.string().optional(),
    totalItems: z.number().int().nonnegative().optional(),
    items: z.array(volumeSchema).optional(),
  })
  .passthrough();

export type GoogleBooksVolumesResponse = z.infer<typeof volumesResponseSchema>;

const ENDPOINT = "https://www.googleapis.com/books/v1/volumes";

export const googleBooksSource: EnrichmentSource = {
  id: "google-books",
  displayName: "Google Books",

  isEnabled() {
    return true; // works without an API key, but the quota is tiny
  },

  async fetchByEan(ean: string, signal: AbortSignal): Promise<FetchResult> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", `isbn:${ean}`);
    if (config.GOOGLE_BOOKS_API_KEY) {
      url.searchParams.set("key", config.GOOGLE_BOOKS_API_KEY);
    }

    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/json" },
    });

    if (response.status === 429) {
      // Surface rate-limit responses as a recordable error rather than
      // silently treating them as "not found".
      throw new Error("Google Books rate-limited (HTTP 429)");
    }

    if (!response.ok) {
      throw new Error(`Google Books returned HTTP ${response.status}`);
    }

    const raw = (await response.json()) as unknown;
    const parsed = volumesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Google Books response failed schema: ${parsed.error.message}`);
    }

    const items = parsed.data.items ?? [];
    if (items.length === 0 || !items[0]?.volumeInfo) {
      return { data: {}, raw, httpStatus: response.status };
    }

    return {
      data: extractEnrichment(items[0].volumeInfo),
      raw,
      httpStatus: response.status,
    };
  },
};

/** Visible for testing. */
export function extractEnrichment(volumeInfo: z.infer<typeof volumeInfoSchema>): PartialEnrichment {
  const out: PartialEnrichment = {};
  if (volumeInfo.title) out.titleShort = volumeInfo.title;
  if (volumeInfo.title || volumeInfo.subtitle) {
    out.titleLong = [volumeInfo.title, volumeInfo.subtitle]
      .filter((s): s is string => Boolean(s))
      .join(": ");
  }
  if (volumeInfo.subtitle) out.subtitle = volumeInfo.subtitle;
  if (volumeInfo.authors?.length) out.authors = volumeInfo.authors;
  if (volumeInfo.publisher) out.publisher = volumeInfo.publisher;
  if (volumeInfo.description) {
    // Google Books descriptions often contain HTML; the mapping engine
    // applies stripHtml downstream where the destination column expects
    // plain text. We pass the raw value through untouched.
    out.descriptionLong = volumeInfo.description;
  }
  if (typeof volumeInfo.pageCount === "number") out.pages = volumeInfo.pageCount;
  if (volumeInfo.language) out.language = volumeInfo.language;
  if (volumeInfo.publishedDate) out.publicationDate = volumeInfo.publishedDate;
  if (volumeInfo.categories?.length) out.categories = volumeInfo.categories;

  const covers = collectCoverUrls(volumeInfo.imageLinks);
  if (covers.length > 0) out.coverImageUrls = covers;

  return out;
}

/**
 * Collect Google Books proper-resolution cover URLs, largest first, so the
 * downstream consumer gets a high-quality image without any thumbnails.
 *
 * Google's `imageLinks` fields map to `zoom` values as follows:
 *   smallThumbnail → zoom=5  (thumbnail, excluded)
 *   thumbnail      → zoom=1  (thumbnail, excluded)
 *   small          → zoom=2  (proper)
 *   medium         → zoom=3  (proper)
 *   large          → zoom=4  (proper)
 *   extraLarge     → zoom=6  (proper)
 *
 * `thumbnail` and `smallThumbnail` are intentionally excluded. If none of
 * the proper sizes are present this returns `[]`, letting the merge step
 * fall through to the next source (e.g. Open Library).
 */
function collectCoverUrls(imageLinks: z.infer<typeof volumeInfoSchema>["imageLinks"]): string[] {
  if (!imageLinks) return [];
  // Proper sizes only, largest first.
  const ordered = [imageLinks.extraLarge, imageLinks.large, imageLinks.medium, imageLinks.small];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of ordered) {
    if (!url) continue;
    const normalized = normalizeCoverUrl(url);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Strip the page-curl artifact and force HTTPS so covers render cleanly
 * on the rokko webshop.
 */
export function normalizeCoverUrl(url: string): string {
  let out = url.replace(/^http:\/\//, "https://");
  out = out.replace(/([?&])edge=curl(&|$)/, (_match, prefix, suffix) =>
    suffix === "&" ? prefix : "",
  );
  // Trim a dangling `?` or `&` introduced by the strip above.
  out = out.replace(/[?&]$/, "");
  return out;
}

import { config } from "@/lib/config";
import { z } from "zod";
import type { EnrichmentSource, FetchResult, PartialEnrichment } from "./source";

/**
 * Open Library adapter. Each successful lookup is up to three HTTP calls:
 *
 *   1. GET /api/books?bibkeys=ISBN:<EAN>&format=json&jscmd=data
 *      Rich edition metadata: title, authors, publishers, subjects, covers.
 *      Returns an empty object `{}` when nothing matches.
 *
 *   2. GET /isbn/<EAN>.json
 *      Lower-level edition data — needed for `weight`, `physical_dimensions`,
 *      and the link to the work (which is where descriptions live).
 *
 *   3. GET /works/<id>.json   (only if step 2 returned a `works[0].key`)
 *      The work-level description, often longer than anything on the edition.
 *
 * Open Library explicitly asks bots to identify themselves via User-Agent
 * (see https://openlibrary.org/dev/docs/api/bots). We read that string from
 * `config.OPEN_LIBRARY_USER_AGENT`. Calls without a polite UA get HTML
 * "please slow down" pages back from the edge cache instead of JSON.
 *
 * Failure modes:
 * - 404 / empty-object on step 1 → `{ data: {} }` (not an error).
 * - Step 2 returning 404 after step 1 found something is treated as "the
 *   edition data is partial" — we still emit step 1's enrichment.
 * - Step 3 is best-effort: a missing work or missing description silently
 *   leaves `descriptionLong` unset.
 * - Any non-OK status on step 1 (5xx, 429, HTML edge response) is thrown
 *   so the orchestrator records it.
 */

const ENDPOINT = "https://openlibrary.org";
const COVER_BASE = "https://covers.openlibrary.org";

/**
 * Step 1 — /api/books?...&jscmd=data. The response is keyed by `ISBN:<ean>`
 * with an object value, or an empty top-level object when not found.
 */
const apiBooksEntrySchema = z
  .object({
    title: z.string().optional(),
    authors: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    publishers: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    publish_date: z.string().optional(),
    number_of_pages: z.number().int().nonnegative().optional(),
    subjects: z.array(z.object({ name: z.string() }).passthrough()).optional(),
    cover: z
      .object({
        small: z.string().optional(),
        medium: z.string().optional(),
        large: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

/** Step 2 — /isbn/<ean>.json — edition document. */
const isbnDocSchema = z
  .object({
    works: z.array(z.object({ key: z.string() }).passthrough()).optional(),
    languages: z.array(z.object({ key: z.string() }).passthrough()).optional(),
    covers: z.array(z.number()).optional(),
    weight: z.string().optional(),
    physical_dimensions: z.string().optional(),
  })
  .passthrough();

/**
 * Step 3 — /works/<id>.json — work document.
 *
 * Open Library descriptions come in two flavours: a bare string, or an
 * object `{ type: "/type/text", value: "..." }`. We accept both.
 */
const workDocSchema = z
  .object({
    description: z.union([z.string(), z.object({ value: z.string() }).passthrough()]).optional(),
  })
  .passthrough();

export const openLibrarySource: EnrichmentSource = {
  id: "open-library",
  displayName: "Open Library",

  isEnabled() {
    return true;
  },

  async fetchByEan(ean: string, signal: AbortSignal): Promise<FetchResult> {
    const headers = {
      "User-Agent": config.OPEN_LIBRARY_USER_AGENT,
      Accept: "application/json",
    };

    // === Step 1: edition lookup by ISBN ===
    const apiBooksUrl = `${ENDPOINT}/api/books?bibkeys=ISBN:${ean}&format=json&jscmd=data`;
    const apiBooksResponse = await fetch(apiBooksUrl, { signal, headers });
    if (!apiBooksResponse.ok) {
      throw new Error(`Open Library /api/books returned HTTP ${apiBooksResponse.status}`);
    }
    const apiBooksRaw = (await apiBooksResponse.json()) as unknown;
    if (!isRecord(apiBooksRaw)) {
      throw new Error("Open Library /api/books returned a non-object body");
    }
    const entry = apiBooksRaw[`ISBN:${ean}`];
    if (entry === undefined) {
      return { data: {}, raw: apiBooksRaw, httpStatus: apiBooksResponse.status };
    }
    const apiBooksParsed = apiBooksEntrySchema.safeParse(entry);
    if (!apiBooksParsed.success) {
      throw new Error(
        `Open Library /api/books entry failed schema: ${apiBooksParsed.error.message}`,
      );
    }
    const data: PartialEnrichment = enrichmentFromApiBooks(apiBooksParsed.data);

    // === Step 2: edition document (best-effort) ===
    let isbnDoc: z.infer<typeof isbnDocSchema> | undefined;
    try {
      const isbnUrl = `${ENDPOINT}/isbn/${ean}.json`;
      const isbnResponse = await fetch(isbnUrl, { signal, headers });
      if (isbnResponse.ok) {
        const isbnRaw = (await isbnResponse.json()) as unknown;
        const parsed = isbnDocSchema.safeParse(isbnRaw);
        if (parsed.success) {
          isbnDoc = parsed.data;
          mergeIsbnEnrichment(data, parsed.data);
        }
      }
    } catch (err) {
      // Step 2 is best-effort. AbortError must still bubble so the
      // orchestrator can stop work on this book; everything else we swallow
      // because we already have step 1's data.
      if ((err as Error).name === "AbortError") throw err;
    }

    // === Step 3: work description (best-effort) ===
    const workKey = isbnDoc?.works?.[0]?.key;
    if (workKey && !data.descriptionLong) {
      try {
        const workUrl = `${ENDPOINT}${workKey}.json`;
        const workResponse = await fetch(workUrl, { signal, headers });
        if (workResponse.ok) {
          const workRaw = (await workResponse.json()) as unknown;
          const parsed = workDocSchema.safeParse(workRaw);
          if (parsed.success) {
            const description = normalizeDescription(parsed.data.description);
            if (description) data.descriptionLong = description;
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
      }
    }

    return {
      data,
      raw: { apiBooks: apiBooksRaw, isbn: isbnDoc },
      httpStatus: apiBooksResponse.status,
    };
  },
};

/** Visible for testing. */
export function enrichmentFromApiBooks(
  entry: z.infer<typeof apiBooksEntrySchema>,
): PartialEnrichment {
  const out: PartialEnrichment = {};
  if (entry.title) {
    out.titleShort = entry.title;
    out.titleLong = entry.title;
  }
  if (entry.authors?.length) {
    out.authors = entry.authors.map((a) => a.name);
  }
  if (entry.publishers?.length) {
    out.publisher = entry.publishers[0]?.name;
  }
  if (entry.publish_date) out.publicationDate = entry.publish_date;
  if (typeof entry.number_of_pages === "number") out.pages = entry.number_of_pages;
  if (entry.subjects?.length) {
    out.categories = entry.subjects.map((s) => s.name);
  }
  const covers = collectCoverUrls(entry.cover);
  if (covers.length > 0) out.coverImageUrls = covers;
  return out;
}

/** Visible for testing. */
export function mergeIsbnEnrichment(
  out: PartialEnrichment,
  doc: z.infer<typeof isbnDocSchema>,
): void {
  // ISO language code preference (3-letter from `/languages/eng`).
  const langKey = doc.languages?.[0]?.key;
  if (langKey && !out.language) {
    const match = langKey.match(/\/languages\/([a-z]+)/);
    if (match?.[1]) out.language = match[1];
  }
  // Weight string parsing — Open Library gives free-form text like
  // "240 grams" or "1.2 kg". Only parse the obvious cases.
  if (doc.weight && out.weightGrams === undefined) {
    const grams = parseWeightToGrams(doc.weight);
    if (grams !== undefined) out.weightGrams = grams;
  }
  // Cover IDs are numeric and resolve via covers.openlibrary.org. Only
  // append if step 1 had no covers — step 1's URLs are already absolute.
  if (doc.covers?.length && !out.coverImageUrls) {
    const fromIds = doc.covers.filter((id) => id > 0).map((id) => `${COVER_BASE}/b/id/${id}-L.jpg`);
    if (fromIds.length > 0) out.coverImageUrls = fromIds;
  }
}

/** Visible for testing. */
export function normalizeDescription(
  value: z.infer<typeof workDocSchema>["description"],
): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "value" in value) return value.value;
  return undefined;
}

function collectCoverUrls(cover: z.infer<typeof apiBooksEntrySchema>["cover"]): string[] {
  if (!cover) return [];
  const out: string[] = [];
  // Largest first so the primary cover comes out at the top.
  if (cover.large) out.push(cover.large);
  if (cover.medium) out.push(cover.medium);
  if (cover.small) out.push(cover.small);
  return out;
}

/** Visible for testing. */
export function parseWeightToGrams(input: string): number | undefined {
  // Match `<num><optional space><unit>` where unit ∈ {g, gram, grams, kg, oz, pound, pounds, lb, lbs}
  const match = input.trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*(g|grams?|kg|oz|lbs?|pounds?)\b/i);
  if (!match) return undefined;
  const [, rawValue, rawUnit] = match;
  if (!rawValue || !rawUnit) return undefined;
  const value = Number.parseFloat(rawValue.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  const unit = rawUnit.toLowerCase();
  if (unit === "g" || unit === "gram" || unit === "grams") return Math.round(value);
  if (unit === "kg") return Math.round(value * 1000);
  if (unit === "oz") return Math.round(value * 28.3495);
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    return Math.round(value * 453.592);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

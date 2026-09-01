/**
 * v2 mobile intake — assisted review form model + persistence (spec v2 Slice E,
 * US-E1/E2/E3).
 *
 * The review form is the last worker-facing step before the webshop push. It
 * pre-fills each field with the best available value using a fixed precedence
 * — **online catalog > OCR > blank** (confirmed default) — while still
 * exposing every alternative as a selectable suggestion the worker can adopt
 * or override. This module is split in two:
 *
 *  - `buildReviewModel` (pure-ish read): gathers the enrichment + OCR
 *    suggestions for a book and computes the pre-filled defaults + provenance.
 *    Consumed by the book page (server) to seed the client form.
 *  - `saveIntakeReview` (write): validates the worker's confirmed values at the
 *    Zod boundary and persists them onto `intake_books`, mirroring the title
 *    into the list-view `title` column.
 *
 * These are deliberately independent of Slice F: saving records the reviewed
 * values (and keeps the book a `draft`); the push happens separately.
 */
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getEnrichmentSnapshot } from "./enrichment";
import { getOcrSnapshot } from "./ocr";

/** Where an adopted value came from (US-E2), recorded for later QA / tuning. */
export type ReviewFieldSource = "online" | "ocr" | "manual";

/** One selectable suggestion offered above a field, with its provenance. */
export interface ReviewSuggestion {
  /** Machine provenance used when this suggestion is adopted. */
  source: ReviewFieldSource;
  /** Human-readable origin shown on the chip (e.g. "Online", "Cover"). */
  label: string;
  /** The suggested value to drop into the field. */
  value: string;
}

/** The seed for one text field: its default value, provenance, and options. */
export interface ReviewField {
  /** Pre-filled value using online > OCR > blank precedence. */
  value: string;
  /** Provenance of `value` (`manual` when there is no suggestion). */
  source: ReviewFieldSource;
  /** All available suggestions (deduped), best-precedence first. */
  suggestions: ReviewSuggestion[];
}

/** Everything the client review form needs to render (US-E1/E2). */
export interface ReviewModel {
  title: ReviewField;
  author: ReviewField;
  description: ReviewField;
  /** Weight is optional and rarely online; seeded numeric or blank. */
  weightGrams: number | null;
  /** Whether a front cover exists — part of the US-E3 required set. */
  hasFrontImage: boolean;
  /** Previously-saved reviewed values (present when reopening the form). */
  saved: {
    title: string | null;
    author: string | null;
    description: string | null;
    weightGrams: number | null;
    titleSource: ReviewFieldSource | null;
    authorSource: ReviewFieldSource | null;
    descriptionSource: ReviewFieldSource | null;
  } | null;
}

/**
 * Assemble a field from ordered candidate suggestions. The first non-empty
 * candidate (online, then OCR) becomes the default; blank + `manual` when none.
 * Suggestions with identical values are de-duplicated, keeping the higher-
 * precedence one.
 */
function buildField(candidates: ReviewSuggestion[]): ReviewField {
  const seen = new Set<string>();
  const suggestions: ReviewSuggestion[] = [];
  for (const c of candidates) {
    const value = c.value.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    suggestions.push({ ...c, value });
  }
  const best = suggestions[0];
  return best
    ? { value: best.value, source: best.source, suggestions }
    : { value: "", source: "manual", suggestions };
}

/**
 * Build the review-form model for a book: the online + OCR suggestions per
 * field, the precedence-based pre-fill, and any previously-saved values.
 * Returns `undefined` when the book is unknown.
 */
export function buildReviewModel(sessionId: string, bookId: string): ReviewModel | undefined {
  const db = getDb();
  const row = db
    .select({
      reviewedTitle: intakeBooks.reviewedTitle,
      reviewedAuthor: intakeBooks.reviewedAuthor,
      reviewedDescription: intakeBooks.reviewedDescription,
      reviewedWeightGrams: intakeBooks.reviewedWeightGrams,
      titleSource: intakeBooks.titleSource,
      authorSource: intakeBooks.authorSource,
      descriptionSource: intakeBooks.descriptionSource,
    })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!row) return undefined;

  const enrichment = getEnrichmentSnapshot(sessionId, bookId);
  const ocr = getOcrSnapshot(sessionId, bookId);

  const online = enrichment?.suggestions;
  const cover = ocr?.suggestions;
  const onlineAuthor = online?.authors?.filter((a) => a.trim().length > 0).join(", ");

  // Precedence is encoded by candidate order: online first, then OCR.
  const title = buildField([
    ...(online?.title ? [sug("online", "Online", online.title)] : []),
    ...(cover?.title ? [sug("ocr", "Cover", cover.title)] : []),
  ]);
  const author = buildField([
    ...(onlineAuthor ? [sug("online", "Online", onlineAuthor)] : []),
    ...(cover?.author ? [sug("ocr", "Cover", cover.author)] : []),
  ]);
  const description = buildField([
    ...(online?.descriptionShort ? [sug("online", "Online", online.descriptionShort)] : []),
    ...(cover?.description ? [sug("ocr", "Back cover", cover.description)] : []),
  ]);

  return {
    title,
    author,
    description,
    weightGrams: online?.weightGrams ?? null,
    hasFrontImage: false, // filled by the page, which already lists images
    saved:
      row.reviewedTitle !== null ||
      row.reviewedAuthor !== null ||
      row.reviewedDescription !== null ||
      row.reviewedWeightGrams !== null
        ? {
            title: row.reviewedTitle,
            author: row.reviewedAuthor,
            description: row.reviewedDescription,
            weightGrams: row.reviewedWeightGrams,
            titleSource: row.titleSource,
            authorSource: row.authorSource,
            descriptionSource: row.descriptionSource,
          }
        : null,
  };
}

function sug(source: ReviewFieldSource, label: string, value: string): ReviewSuggestion {
  return { source, label, value };
}

const fieldSourceSchema = z.enum(["online", "ocr", "manual"]);

/**
 * Input schema for a saved review (US-E1/E2/E3). Validated at this boundary so
 * the server action / lib never persists junk. `title` is required (US-E3);
 * the rest are recommended but optional. Values are trimmed; empty optional
 * strings become `null`.
 */
export const saveReviewSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500),
  author: z.string().trim().max(500).optional(),
  description: z.string().trim().max(20_000).optional(),
  weightGrams: z.number().int().positive().max(100_000).optional(),
  titleSource: fieldSourceSchema.default("manual"),
  authorSource: fieldSourceSchema.default("manual"),
  descriptionSource: fieldSourceSchema.default("manual"),
});

export type SaveReviewInput = z.input<typeof saveReviewSchema>;

/**
 * Persist the worker-confirmed review values onto an intake book (US-E1/E2).
 * Validates at the Zod boundary; mirrors the confirmed title into the
 * list-view `title` column. The push `status` is left untouched (Slice F).
 *
 * @throws {z.ZodError} if the input is invalid.
 * @throws if the book is not found in the session.
 */
export function saveIntakeReview(sessionId: string, bookId: string, input: SaveReviewInput): void {
  const data = saveReviewSchema.parse(input);
  const db = getDb();
  const result = db
    .update(intakeBooks)
    .set({
      reviewedTitle: data.title,
      reviewedAuthor: data.author ?? null,
      reviewedDescription: data.description ?? null,
      reviewedWeightGrams: data.weightGrams ?? null,
      titleSource: data.titleSource,
      authorSource: data.authorSource,
      descriptionSource: data.descriptionSource,
      // Keep the session list in sync with the confirmed title.
      title: data.title,
      updatedAt: new Date(),
    })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  if (result.changes === 0) {
    throw new Error(`Unknown intake book: ${bookId} in session ${sessionId}`);
  }

  logger.info(
    {
      sessionId,
      bookId,
      titleSource: data.titleSource,
      authorSource: data.authorSource,
      descriptionSource: data.descriptionSource,
    },
    "intake book review saved",
  );
}

/**
 * v2 mobile intake — push a confirmed book to Lightspeed Retail (spec v2
 * Slice F, US-F1/F2). This is the DB-wired orchestration that the server action
 * calls: it loads the reviewed book + cover photos, obtains a valid Retail
 * access token, delegates the mapping/HTTP to `@/lib/lightspeed`, and records
 * the outcome on `intake_books` (status + retail item id / error / timestamp).
 *
 * Per rokko's Slice F decisions: update-only (matched by EAN), author omitted
 * (it lives in CatalogVendorItem), description + weight sent best-effort. A
 * failed push keeps the book as a recoverable `failed` draft (never lost).
 */
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { readIntakeImage } from "@/lib/intake/images";
import { getValidAccessToken } from "@/lib/lightspeed/connection";
import { accountIdFromAccessToken } from "@/lib/lightspeed/oauth";
import { type PushImage, pushBookToRetail } from "@/lib/lightspeed/push";
import { logger } from "@/lib/logger";
import { and, eq } from "drizzle-orm";

export type SubmitBookResult =
  | { ok: true; itemID: string; imageCount: number }
  | { ok: false; error: string };

/**
 * Push a single reviewed intake book to Retail and persist the result.
 *
 * @throws only for programmer errors (book not found in session). Expected
 * failures (not connected, EAN not in Retail, API/image errors) return an
 * `{ ok: false }` result and mark the book `failed` with a retryable message.
 */
export async function submitIntakeBook(
  sessionId: string,
  bookId: string,
): Promise<SubmitBookResult> {
  const db = getDb();
  const book = db
    .select()
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!book) throw new Error(`Unknown intake book: ${bookId} in session ${sessionId}`);

  // A book must have been reviewed (a confirmed title) before it can be pushed.
  if (!book.reviewedTitle?.trim()) {
    return fail(db, bookId, "Confirm the review (title required) before pushing.");
  }

  // Obtain a valid Retail token (refreshes if near expiry). Undefined means the
  // app is not configured or not connected — surface a clear reconnect hint.
  let accessToken: string | undefined;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    return fail(
      db,
      bookId,
      `Lightspeed connection needs attention: ${err instanceof Error ? err.message : "reconnect required"}. Reconnect in Settings → Lightspeed.`,
    );
  }
  if (!accessToken) {
    return fail(db, bookId, "Not connected to Lightspeed. Connect in Settings → Lightspeed.");
  }
  const accountId = accountIdFromAccessToken(accessToken);
  if (!accountId) {
    return fail(db, bookId, "Lightspeed token is missing its account id. Reconnect in Settings.");
  }

  // Resolve cover photos to bytes for upload (front primary, back secondary).
  const images: PushImage[] = [];
  for (const kind of ["front", "back"] as const) {
    const file = await readIntakeImage(sessionId, bookId, kind);
    if (file) {
      images.push({ kind, bytes: file.bytes, filename: `${kind}.jpg`, mimeType: file.mimeType });
    }
  }

  const result = await pushBookToRetail({ accessToken, accountId }, { book, images });

  if (!result.ok) {
    logger.warn({ sessionId, bookId, ean: book.ean, error: result.error }, "intake push failed");
    return fail(db, bookId, result.error);
  }

  db.update(intakeBooks)
    .set({
      status: "pushed",
      retailItemID: result.itemID,
      pushError: null,
      pushedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(intakeBooks.id, bookId))
    .run();

  logger.info(
    { sessionId, bookId, ean: book.ean, itemID: result.itemID, images: result.imageIDs.length },
    "intake book pushed to Retail",
  );
  return { ok: true, itemID: result.itemID, imageCount: result.imageIDs.length };
}

/** Record a recoverable failure on the book and return the error result. */
function fail(
  db: ReturnType<typeof getDb>,
  bookId: string,
  error: string,
): { ok: false; error: string } {
  db.update(intakeBooks)
    .set({ status: "failed", pushError: error, updatedAt: new Date() })
    .where(eq(intakeBooks.id, bookId))
    .run();
  return { ok: false, error };
}

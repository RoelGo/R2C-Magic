/**
 * v2 mobile intake — live Retail lookup by EAN (spec v2 US-B3).
 *
 * The moment a worker captures an EAN we ask the Lightspeed Retail API whether
 * the book already exists as an Item. The result gates submission downstream:
 *   - `found`   → the item exists; submit will UPDATE it (default flow).
 *   - `missing` → not in Retail; submit is blocked unless the worker opts to
 *     create it (the "create on submit" checkbox, US-B3).
 *   - `error`   → not connected / API error; surfaced, non-blocking for the
 *     rest of the flow (photos, OCR, review still work — same spirit as the v1
 *     "never block on a source" rule).
 *
 * This is DB-wired: it loads the book, calls `@/lib/lightspeed`, and records
 * the outcome on `intake_books`. It never throws for expected failures — a
 * missing token or API error is captured as `retailLookupStatus = "error"`.
 */
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { findItemByEan } from "@/lib/lightspeed/api";
import { getValidAccessToken } from "@/lib/lightspeed/connection";
import { accountIdFromAccessToken } from "@/lib/lightspeed/oauth";
import { logger } from "@/lib/logger";
import { and, eq } from "drizzle-orm";

export type RetailLookupStatus = "idle" | "checking" | "found" | "missing" | "error";

export interface RetailLookupResult {
  status: RetailLookupStatus;
  /** The matched Retail Item id when `status === "found"`. */
  itemID?: string;
  /** A human-readable reason when `status === "error"`. */
  error?: string;
}

/**
 * Look a captured EAN up against Retail and persist the outcome on the book.
 * Called right after the EAN is saved (from the server action). Best-effort:
 * an unconnected app or API hiccup records `error` rather than throwing, so it
 * never blocks the worker from photographing / reviewing the book.
 */
export async function lookupRetailItem(
  sessionId: string,
  bookId: string,
  ean: string,
): Promise<RetailLookupResult> {
  const db = getDb();

  const persist = (result: RetailLookupResult): RetailLookupResult => {
    db.update(intakeBooks)
      .set({
        retailLookupStatus: result.status,
        retailLookupError: result.status === "error" ? (result.error ?? "Lookup failed") : null,
        // Keep the matched item id for the update-only push; clear it otherwise
        // so a re-scan of a different EAN cannot reuse a stale id.
        retailItemID: result.status === "found" ? (result.itemID ?? null) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
      .run();
    return result;
  };

  let accessToken: string | undefined;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    return persist({
      status: "error",
      error: `Lightspeed connection needs attention: ${err instanceof Error ? err.message : "reconnect required"}. Reconnect in Settings → Lightspeed.`,
    });
  }
  if (!accessToken) {
    return persist({
      status: "error",
      error: "Not connected to Lightspeed. Connect in Settings → Lightspeed.",
    });
  }
  const accountId = accountIdFromAccessToken(accessToken);
  if (!accountId) {
    return persist({
      status: "error",
      error: "Lightspeed token is missing its account id. Reconnect in Settings.",
    });
  }

  try {
    const item = await findItemByEan({ accessToken, accountId }, ean);
    if (item) {
      logger.info({ sessionId, bookId, ean, itemID: item.itemID }, "intake retail lookup: found");
      return persist({ status: "found", itemID: item.itemID });
    }
    logger.info({ sessionId, bookId, ean }, "intake retail lookup: missing");
    return persist({ status: "missing" });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Retail lookup failed";
    logger.warn({ sessionId, bookId, ean, error }, "intake retail lookup: error");
    return persist({ status: "error", error });
  }
}

/**
 * Slice F — LIVE Lightspeed Retail push (integration, opt-in).
 *
 * This test is EXCLUDED from the default `pnpm test` run: it lives under
 * `tests/integration/` (see vitest.workspace.ts) and additionally self-skips
 * unless `LIGHTSPEED_ACCESS_TOKEN` + `LIGHTSPEED_ACCOUNT_ID` are provided. It
 * makes REAL network calls against a Lightspeed test account and mutates data
 * there, so it must never run in CI or the hermetic unit suite.
 *
 * Run manually with a fresh access token:
 *   LIGHTSPEED_ACCESS_TOKEN=... LIGHTSPEED_ACCOUNT_ID=314551 \
 *     pnpm vitest run --project integration tests/integration/lightspeed-push.test.ts
 *
 * It reads the already-reviewed "Utilitarianism" book (+ its front/back cover
 * photos) straight from the local SQLite DB and pushes it through the exact
 * production path (`pushBookToRetail`), so the live behaviour (titled image
 * captions, ordering, update-only) matches what the app does.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { IntakeBookRow } from "../../src/lib/db/schema";
import { findItemByEan } from "../../src/lib/lightspeed/api";
import { type PushImage, buildItemUpdate, pushBookToRetail } from "../../src/lib/lightspeed/push";

const ACCESS_TOKEN = process.env.LIGHTSPEED_ACCESS_TOKEN;
const ACCOUNT_ID = process.env.LIGHTSPEED_ACCOUNT_ID;
const BOOK_ID = process.env.INTAKE_BOOK_ID ?? "01M1CSA89285RW3PHA3AQMNFQ6";

const run = ACCESS_TOKEN && ACCOUNT_ID ? describe : describe.skip;

interface BookAndImages {
  book: IntakeBookRow;
  images: PushImage[];
}

function loadBook(bookId: string): BookAndImages {
  const dbPath = resolve(process.cwd(), "data", "r2c.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT id, session_id as sessionId, ean, title, status,
                reviewed_title as reviewedTitle, reviewed_author as reviewedAuthor,
                reviewed_description as reviewedDescription,
                reviewed_weight_grams as reviewedWeightGrams
         FROM intake_books WHERE id = ?`,
      )
      .get(bookId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`intake book ${bookId} not found in ${dbPath}`);

    const imageRows = db
      .prepare(
        "SELECT kind, file_path as filePath, mime_type as mimeType FROM intake_images WHERE book_id = ?",
      )
      .all(bookId) as { kind: "front" | "back"; filePath: string; mimeType: string }[];

    const images: PushImage[] = imageRows.map((r) => ({
      kind: r.kind,
      bytes: readFileSync(resolve(process.cwd(), "data", r.filePath)),
      filename: `${r.kind}.jpg`,
      mimeType: r.mimeType,
    }));

    return { book: row as unknown as IntakeBookRow, images };
  } finally {
    db.close();
  }
}

run("live Lightspeed Retail push (Utilitarianism)", () => {
  const client = { accessToken: ACCESS_TOKEN as string, accountId: ACCOUNT_ID as string };

  it("pushes via the production path (update-only, images, captions)", async () => {
    const { book, images } = loadBook(BOOK_ID);
    expect(book.ean, "book should have an EAN").toBeTruthy();

    // Log the mapped payload for a human to eyeball.
    // eslint-disable-next-line no-console
    console.log("Item update payload:", JSON.stringify(buildItemUpdate(book), null, 2));

    // The test account may not have this EAN yet; the push is update-only, so
    // seed a target item first to mirror "the book already exists in R-Series".
    const existing = await findItemByEan(client, book.ean as string);
    if (!existing) {
      // eslint-disable-next-line no-console
      console.warn(`EAN ${book.ean} not in test account; creating a target item.`);
      await createItemForTest(client, book.ean as string, book.reviewedTitle ?? "Utilitarianism");
    }

    const result = await pushBookToRetail(client, { book, images });
    // eslint-disable-next-line no-console
    console.log("Push result:", JSON.stringify(result));
    expect(result.ok, `push failed: ${result.ok ? "" : result.error}`).toBe(true);
    if (result.ok) {
      expect(result.itemID).toBeTruthy();
      expect(result.imageIDs.length).toBe(images.length);
    }
  }, 60_000);
});

/** Minimal Item create so the update-only push has a target on the test account. */
async function createItemForTest(
  client: { accessToken: string; accountId: string },
  ean: string,
  description: string,
): Promise<{ itemID: string }> {
  const url = `https://api.lightspeedapp.com/API/V3/Account/${client.accountId}/Item.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ description, ean, itemType: "default" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create item failed (${res.status}): ${text}`);
  const json = JSON.parse(text) as { Item: { itemID: string | number } };
  return { itemID: String(json.Item.itemID) };
}

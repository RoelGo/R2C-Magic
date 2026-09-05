/**
 * Lightspeed Retail push (spec v2 Slice F, US-F1/F2).
 *
 * Maps a worker-confirmed intake book (the `reviewed_*` fields + captured cover
 * photos) onto a Retail Item update, then uploads the images. Per rokko's
 * decisions for Slice F:
 *   - update-only, matched by EAN (the article already exists in R-Series);
 *     a missing item is a recoverable failure, never a create.
 *   - author is out of scope here (it lives in CatalogVendorItem/Brand, already
 *     populated from vendor packing lists), so it is captured but not pushed.
 *   - description + weight are pushed via ItemECommerce, which is VERIFIED to
 *     flow through to the webshop on rokko's live omnichannel account (despite
 *     the docs flagging those fields as "not used by eCommerce"). See the note
 *     on `ItemUpdatePayload.ItemECommerce` in `api.ts`.
 *
 * The mapping mirrors the v1 R→C semantics (mapping.config.json): title →
 * item name, weight grams → kg, EAN as the identifier.
 */
import type { IntakeBookRow } from "@/lib/db/schema";
import {
  type ItemUpdatePayload,
  RetailApiError,
  type RetailClient,
  createItem,
  findItemByEan,
  updateItem,
  uploadItemImage,
} from "@/lib/lightspeed/api";

/** A captured cover photo, resolved to bytes for upload. */
export interface PushImage {
  kind: "front" | "back";
  bytes: Buffer | Uint8Array;
  filename: string;
  mimeType: string;
}

/**
 * Pure mapping: build the Item update payload from confirmed review fields.
 * No I/O, so it is exhaustively unit-testable. `author` is intentionally
 * absent (out of scope for the API push).
 */
export function buildItemUpdate(book: IntakeBookRow): ItemUpdatePayload {
  const payload: ItemUpdatePayload = {};

  const title = book.reviewedTitle?.trim();
  if (title) payload.description = title;

  const ecom: NonNullable<ItemUpdatePayload["ItemECommerce"]> = {};
  const description = book.reviewedDescription?.trim();
  if (description) ecom.longDescription = description;
  if (typeof book.reviewedWeightGrams === "number" && book.reviewedWeightGrams > 0) {
    // v1 mapping divides grams by 1000 → kg for the Weight column.
    ecom.weight = book.reviewedWeightGrams / 1000;
  }
  if (Object.keys(ecom).length > 0) payload.ItemECommerce = ecom;

  return payload;
}

export type PushResult =
  | { ok: true; itemID: string; imageIDs: string[] }
  | { ok: false; error: string; recoverable: true };

export interface PushInput {
  book: IntakeBookRow;
  images: PushImage[];
  /**
   * When the EAN is not found in Retail, create a brand-new Item instead of
   * failing (US-B3 "create on submit"). Defaults to update-only per rokko's
   * original Slice F decision — the worker must explicitly opt in.
   */
  createIfMissing?: boolean;
}

/**
 * Push a confirmed book to Retail: find the Item by EAN, PUT its content (or,
 * when `createIfMissing` is set and no item matches, POST a new one), then
 * upload cover photos (front = ordering 0, back = ordering 1). The content push
 * and image push are independently recoverable — an image failure does not undo
 * the item update (US-F2). Never throws for expected failures; returns a
 * recoverable result so the caller keeps the book as a retryable draft.
 */
export async function pushBookToRetail(
  client: RetailClient,
  input: PushInput,
): Promise<PushResult> {
  const { book, images, createIfMissing = false } = input;

  if (!book.ean) {
    return { ok: false, error: "Book has no EAN to match against Retail.", recoverable: true };
  }

  const payload = buildItemUpdate(book);

  let itemID: string;
  try {
    const item = await findItemByEan(client, book.ean);
    if (item) {
      itemID = item.itemID;
      try {
        await updateItem(client, itemID, payload);
      } catch (err) {
        return { ok: false, error: describeError(err), recoverable: true };
      }
    } else if (createIfMissing) {
      // US-B3: the book isn't in Retail yet and the worker opted to create it.
      const created = await createItem(client, { ...payload, ean: book.ean });
      itemID = created.itemID;
    } else {
      return {
        ok: false,
        error: `No Retail item found for EAN ${book.ean}. Upload it to R-Series first, or enable "create on submit".`,
        recoverable: true,
      };
    }
  } catch (err) {
    return { ok: false, error: describeError(err), recoverable: true };
  }

  // Upload images in a stable order (front first). An image failure is
  // reported but the item content is already live and recoverable.
  const title = book.reviewedTitle?.trim() || book.title?.trim() || "";
  const ordered = [...images].sort((a, b) => orderingFor(a.kind) - orderingFor(b.kind));
  const imageIDs: string[] = [];
  for (const image of ordered) {
    try {
      const { imageID } = await uploadItemImage(client, itemID, {
        bytes: image.bytes,
        filename: image.filename,
        mimeType: image.mimeType,
        ordering: orderingFor(image.kind),
        description: imageDescription(title, image.kind),
      });
      imageIDs.push(imageID);
    } catch (err) {
      return {
        ok: false,
        error: `Item updated but image (${image.kind}) upload failed: ${describeError(err)}`,
        recoverable: true,
      };
    }
  }

  return { ok: true, itemID, imageIDs };
}

function orderingFor(kind: "front" | "back"): number {
  return kind === "front" ? 0 : 1;
}

/**
 * A human-friendly image caption for the webshop: the book title with a role
 * suffix (e.g. "Utilitarianism — front cover"), falling back to just the role
 * when no title is available.
 */
function imageDescription(title: string, kind: "front" | "back"): string {
  const role = kind === "front" ? "front cover" : "back cover";
  return title ? `${title} — ${role}` : role.charAt(0).toUpperCase() + role.slice(1);
}

function describeError(err: unknown): string {
  if (err instanceof RetailApiError) return err.message;
  return err instanceof Error ? err.message : "Unknown error";
}

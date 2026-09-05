/**
 * Lightspeed Retail (R-Series) API client (spec v2 Slice F, US-F1/F2).
 *
 * rokko runs an omnichannel plan, so intake content is pushed through the
 * Retail API (not eCom). This module is a thin, typed wrapper over the V3
 * Item + Item Image endpoints:
 *   https://developers.lightspeedhq.com/retail/endpoints/Item/
 *   https://developers.lightspeedhq.com/retail/endpoints/Item-Image/
 *
 * It is deliberately I/O-focused and stateless: an access token + account id
 * are passed in (obtained from `connection.getValidAccessToken()` in
 * production, or a raw token in an integration test). Nothing here reads the
 * database. Responses are validated at the boundary with Zod (AGENTS.md #2).
 */
import { z } from "zod";

/** Base host for the Retail V3 API (distinct from the OAuth host). */
const API_HOST = "https://api.lightspeedapp.com";

/** Build the `/API/V3/Account/{accountID}` prefix for a Retail account. */
export function retailBaseUrl(accountId: string): string {
  return `${API_HOST}/API/V3/Account/${accountId}`;
}

/** Raised when a Retail API call returns a non-2xx or unparseable response. */
export class RetailApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RetailApiError";
  }
}

/**
 * Lightspeed returns numeric fields as strings and wraps single resources in a
 * named envelope (`{ "Item": {...} }`). A query with no matches omits the key
 * entirely, so the schemas keep the payload loose and coerce what we read.
 */
const itemSchema = z
  .object({
    itemID: z.union([z.string(), z.number()]).transform((v) => String(v)),
    description: z.string().optional(),
    ean: z.string().optional(),
  })
  .passthrough();

const itemQueryResponseSchema = z.object({
  // Absent when zero matches; a single object or an array when there are hits.
  Item: z.union([itemSchema, z.array(itemSchema)]).optional(),
});

const itemMutationResponseSchema = z.object({
  Item: itemSchema,
});

const imageResponseSchema = z.object({
  Image: z
    .object({
      imageID: z.union([z.string(), z.number()]).transform((v) => String(v)),
      ordering: z
        .union([z.string(), z.number()])
        .transform((v) => String(v))
        .optional(),
    })
    .passthrough(),
});

export interface RetailItem {
  itemID: string;
  description?: string;
  ean?: string;
}

export interface RetailClient {
  accessToken: string;
  accountId: string;
}

async function retailFetch(
  client: RetailClient,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = `${retailBaseUrl(client.accountId)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new RetailApiError(
      `Could not reach Lightspeed Retail API: ${err instanceof Error ? err.message : "network error"}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new RetailApiError(
      `Lightspeed Retail request failed (${res.status})${text ? `: ${truncate(text)}` : ""}`,
      res.status,
    );
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RetailApiError("Lightspeed Retail response was not valid JSON", res.status);
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Look up an existing Item by its EAN. Uses `itemCode`, which matches an
 * item's itemID, upc, or ean (only `=`/`IN` operators are supported). Returns
 * `undefined` when no item matches — the caller decides create-vs-update
 * (Slice F is update-only per rokko's decision).
 */
export async function findItemByEan(
  client: RetailClient,
  ean: string,
): Promise<RetailItem | undefined> {
  const json = await retailFetch(client, `/Item.json?ean=${encodeURIComponent(ean)}`);
  const parsed = itemQueryResponseSchema.parse(json);
  if (!parsed.Item) return undefined;
  const item = Array.isArray(parsed.Item) ? parsed.Item[0] : parsed.Item;
  return item;
}

/** Fields we set on an Item update. Only content, never commercial fields. */
export interface ItemUpdatePayload {
  /** The item's display name (title). Maps to `Item.description`. */
  description?: string;
  /**
   * eCommerce content sub-object. Per the docs these fields are flagged as
   * "not used by Lightspeed eCommerce"; we send them best-effort (rokko's
   * "API-only" choice) and verify against the live account.
   */
  ItemECommerce?: {
    longDescription?: string;
    /** Weight in the account's unit (we send kg, mirroring the v1 mapping). */
    weight?: number;
  };
}

/** PUT-update an existing Item with confirmed intake content. */
export async function updateItem(
  client: RetailClient,
  itemID: string,
  payload: ItemUpdatePayload,
): Promise<RetailItem> {
  const json = await retailFetch(client, `/Item/${itemID}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return itemMutationResponseSchema.parse(json).Item;
}

export interface ImageUpload {
  bytes: Buffer | Uint8Array;
  filename: string;
  mimeType: string;
  /** Sort order; 0 = primary (front), 1 = secondary (back). */
  ordering: number;
  description?: string;
}

/**
 * Upload a cover photo to an Item via a multipart POST. The `data` part carries
 * the JSON metadata; the `image` part carries the binary (per the Item Image
 * docs). Returns the created image id.
 */
export async function uploadItemImage(
  client: RetailClient,
  itemID: string,
  image: ImageUpload,
): Promise<{ imageID: string }> {
  const form = new FormData();
  form.set(
    "data",
    JSON.stringify({
      description: image.description ?? "",
      ordering: image.ordering,
    }),
  );
  // Copy into a fresh ArrayBuffer-backed view so the Blob type checks cleanly
  // regardless of whether the source was a Node Buffer or a Uint8Array.
  const src = image.bytes;
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  form.set("image", new Blob([bytes], { type: image.mimeType }), image.filename);

  // Note: do not set Content-Type manually — fetch adds the multipart boundary.
  const json = await retailFetch(client, `/Item/${itemID}/Image.json`, {
    method: "POST",
    body: form,
  });
  return { imageID: imageResponseSchema.parse(json).Image.imageID };
}

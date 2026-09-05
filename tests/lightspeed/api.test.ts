import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RetailApiError,
  type RetailClient,
  findItemByEan,
  retailBaseUrl,
  updateItem,
  uploadItemImage,
} from "../../src/lib/lightspeed/api";

/**
 * Hermetic unit tests for the Retail API client. No network: `fetch` is stubbed
 * with recorded-shape responses matching the Lightspeed docs (envelopes,
 * string-numeric fields). These assert URL/base-path building, envelope
 * parsing, error mapping, and the multipart image upload shape.
 */
const client: RetailClient = { accessToken: "tok-123", accountId: "314551" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("lib/lightspeed/api", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("builds the V3 account base path", () => {
    expect(retailBaseUrl("314551")).toBe("https://api.lightspeedapp.com/API/V3/Account/314551");
  });

  it("finds an item by EAN and coerces string-numeric ids", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Item: { itemID: 42, description: "Utilitarianism", ean: "9780198728795" } }),
    );
    const item = await findItemByEan(client, "9780198728795");
    expect(item).toEqual({ itemID: "42", description: "Utilitarianism", ean: "9780198728795" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.lightspeedapp.com/API/V3/Account/314551/Item.json?ean=9780198728795",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("returns undefined when no item matches the EAN", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ "@attributes": { count: "0" } }));
    expect(await findItemByEan(client, "0000000000000")).toBeUndefined();
  });

  it("takes the first match when the query returns an array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Item: [{ itemID: "7" }, { itemID: "8" }] }));
    const item = await findItemByEan(client, "123");
    expect(item?.itemID).toBe("7");
  });

  it("PUT-updates an item and returns the updated resource", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Item: { itemID: "42", description: "New" } }));
    const updated = await updateItem(client, "42", { description: "New" });
    expect(updated.itemID).toBe("42");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.lightspeedapp.com/API/V3/Account/314551/Item/42.json");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ description: "New" });
  });

  it("uploads an image as multipart with data + image parts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ Image: { imageID: 99, ordering: "0" } }));
    const { imageID } = await uploadItemImage(client, "42", {
      bytes: Buffer.from([1, 2, 3]),
      filename: "front.jpg",
      mimeType: "image/jpeg",
      ordering: 0,
      description: "Utilitarianism — front cover",
    });
    expect(imageID).toBe("99");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.lightspeedapp.com/API/V3/Account/314551/Item/42/Image.json");
    expect(init.method).toBe("POST");
    // The body is FormData with a JSON `data` part and a binary `image` part.
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(form.get("data") as string)).toEqual({
      description: "Utilitarianism — front cover",
      ordering: 0,
    });
    const image = form.get("image");
    expect(image).toBeInstanceOf(Blob);
    expect((image as Blob).type).toBe("image/jpeg");
    // We must NOT set Content-Type ourselves (fetch adds the boundary).
    expect(init.headers as Record<string, string>).not.toHaveProperty("Content-Type");
  });

  it("maps a non-2xx response to a RetailApiError with the status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(findItemByEan(client, "123")).rejects.toMatchObject({
      name: "RetailApiError",
      status: 401,
    });
  });

  it("wraps a network failure in a RetailApiError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(updateItem(client, "1", {})).rejects.toBeInstanceOf(RetailApiError);
  });
});

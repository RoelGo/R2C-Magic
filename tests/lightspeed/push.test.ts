import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntakeBookRow } from "../../src/lib/db/schema";

/**
 * Hermetic unit tests for the push mapping + orchestration. The HTTP api layer
 * (`@/lib/lightspeed/api`) is mocked, so no network is touched; these focus on
 * the field mapping (title→description, grams→kg, author omitted, blurb→
 * ItemECommerce), the update-only-by-EAN flow, image ordering + captions, and
 * the recoverable failure contract.
 */
vi.mock("../../src/lib/lightspeed/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/lightspeed/api")>(
    "../../src/lib/lightspeed/api",
  );
  return {
    ...actual,
    findItemByEan: vi.fn(),
    updateItem: vi.fn(),
    uploadItemImage: vi.fn(),
  };
});

import { findItemByEan, updateItem, uploadItemImage } from "../../src/lib/lightspeed/api";
import { buildItemUpdate, pushBookToRetail } from "../../src/lib/lightspeed/push";

const findItemByEanMock = vi.mocked(findItemByEan);
const updateItemMock = vi.mocked(updateItem);
const uploadItemImageMock = vi.mocked(uploadItemImage);

const client = { accessToken: "t", accountId: "314551" };

function book(overrides: Partial<IntakeBookRow> = {}): IntakeBookRow {
  return {
    id: "b1",
    sessionId: "s1",
    ean: "9780198728795",
    title: "Utilitarianism",
    status: "draft",
    enrichmentStatus: "done",
    enrichedPayload: null,
    enrichmentErrors: null,
    ocrStatus: "idle",
    ocrEngine: null,
    ocrTitle: null,
    ocrAuthor: null,
    ocrDescription: null,
    ocrErrors: null,
    reviewedTitle: "Utilitarianism",
    reviewedAuthor: "Peter Singer",
    reviewedDescription: "A very short introduction.",
    reviewedWeightGrams: 350,
    titleSource: "online",
    authorSource: "online",
    descriptionSource: "manual",
    retailItemID: null,
    pushError: null,
    pushedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IntakeBookRow;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildItemUpdate", () => {
  it("maps title→description, blurb→longDescription, grams→kg; omits author", () => {
    const payload = buildItemUpdate(book());
    expect(payload).toEqual({
      description: "Utilitarianism",
      ItemECommerce: {
        longDescription: "A very short introduction.",
        weight: 0.35,
      },
    });
    // Author is intentionally not on the payload.
    expect(payload).not.toHaveProperty("author");
  });

  it("omits ItemECommerce entirely when there is no blurb or weight", () => {
    const payload = buildItemUpdate(book({ reviewedDescription: null, reviewedWeightGrams: null }));
    expect(payload).toEqual({ description: "Utilitarianism" });
  });

  it("ignores non-positive weight", () => {
    const payload = buildItemUpdate(book({ reviewedWeightGrams: 0, reviewedDescription: null }));
    expect(payload.ItemECommerce).toBeUndefined();
  });
});

describe("pushBookToRetail", () => {
  const front = {
    kind: "front" as const,
    bytes: Buffer.from([1]),
    filename: "front.jpg",
    mimeType: "image/jpeg",
  };
  const back = {
    kind: "back" as const,
    bytes: Buffer.from([2]),
    filename: "back.jpg",
    mimeType: "image/jpeg",
  };

  it("updates the matched item and uploads images front-first with titled captions", async () => {
    findItemByEanMock.mockResolvedValue({ itemID: "42" });
    updateItemMock.mockResolvedValue({ itemID: "42" });
    uploadItemImageMock
      .mockResolvedValueOnce({ imageID: "1" })
      .mockResolvedValueOnce({ imageID: "2" });

    // Pass back before front to prove the ordering sort.
    const result = await pushBookToRetail(client, { book: book(), images: [back, front] });
    expect(result).toEqual({ ok: true, itemID: "42", imageIDs: ["1", "2"] });

    expect(updateItemMock).toHaveBeenCalledWith(
      client,
      "42",
      expect.objectContaining({
        description: "Utilitarianism",
      }),
    );
    // Front uploaded first (ordering 0) with a titled caption.
    expect(uploadItemImageMock.mock.calls[0]?.[2]).toMatchObject({
      ordering: 0,
      description: "Utilitarianism — front cover",
    });
    expect(uploadItemImageMock.mock.calls[1]?.[2]).toMatchObject({
      ordering: 1,
      description: "Utilitarianism — back cover",
    });
  });

  it("is update-only: a missing item is a recoverable failure, no create", async () => {
    findItemByEanMock.mockResolvedValue(undefined);
    const result = await pushBookToRetail(client, { book: book(), images: [front] });
    expect(result).toMatchObject({ ok: false, recoverable: true });
    if (!result.ok) expect(result.error).toMatch(/No Retail item found/);
    expect(updateItemMock).not.toHaveBeenCalled();
  });

  it("fails recoverably when the book has no EAN", async () => {
    const result = await pushBookToRetail(client, { book: book({ ean: null }), images: [] });
    expect(result).toMatchObject({ ok: false, recoverable: true });
    expect(findItemByEanMock).not.toHaveBeenCalled();
  });

  it("keeps the item live when an image upload fails (independently recoverable)", async () => {
    findItemByEanMock.mockResolvedValue({ itemID: "42" });
    updateItemMock.mockResolvedValue({ itemID: "42" });
    uploadItemImageMock.mockRejectedValueOnce(new Error("upload boom"));

    const result = await pushBookToRetail(client, { book: book(), images: [front] });
    expect(result).toMatchObject({ ok: false, recoverable: true });
    if (!result.ok) expect(result.error).toMatch(/image \(front\) upload failed/);
    // The content update still happened.
    expect(updateItemMock).toHaveBeenCalledOnce();
  });

  it("surfaces an update failure as recoverable", async () => {
    findItemByEanMock.mockResolvedValue({ itemID: "42" });
    updateItemMock.mockRejectedValue(new Error("PUT boom"));
    const result = await pushBookToRetail(client, { book: book(), images: [front] });
    expect(result).toMatchObject({ ok: false, recoverable: true });
    expect(uploadItemImageMock).not.toHaveBeenCalled();
  });
});

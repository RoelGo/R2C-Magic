import { afterEach, describe, expect, it, vi } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

/**
 * WI-1 regression: a single "push" user action must upload exactly one front
 * and one back image. The Retail API is mocked so we can count calls — a
 * duplicated push (double-tapped button, re-dispatched server action, client
 * retry of the action POST) must NOT produce a second set of images.
 */
vi.mock("../../src/lib/lightspeed/connection", () => ({
  getValidAccessToken: vi.fn(),
}));
vi.mock("../../src/lib/lightspeed/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/lightspeed/api")>(
    "../../src/lib/lightspeed/api",
  );
  return {
    ...actual,
    findItemByEan: vi.fn(),
    updateItem: vi.fn(),
    createItem: vi.fn(),
    uploadItemImage: vi.fn(),
  };
});
vi.mock("../../src/lib/lightspeed/oauth", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/lightspeed/oauth")>(
    "../../src/lib/lightspeed/oauth",
  );
  return { ...actual, accountIdFromAccessToken: vi.fn(() => "314551") };
});

import { findItemByEan, updateItem, uploadItemImage } from "../../src/lib/lightspeed/api";
import { getValidAccessToken } from "../../src/lib/lightspeed/connection";

const getTokenMock = vi.mocked(getValidAccessToken);
const findItemMock = vi.mocked(findItemByEan);
const updateItemMock = vi.mocked(updateItem);
const uploadItemImageMock = vi.mocked(uploadItemImage);

const EAN = "9789083436999";

function fakeJpeg(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
}

/** A reviewed book with both cover photos captured, ready to push. */
async function seedReviewedBook() {
  const { createSession, addBookToSession, setBookEan } = await import("../../src/lib/intake");
  const { saveIntakeReview } = await import("../../src/lib/intake/review");
  const { saveIntakeImage } = await import("../../src/lib/intake/images");

  const sessionId = createSession();
  const bookId = addBookToSession(sessionId);
  setBookEan(sessionId, bookId, EAN);
  saveIntakeReview(sessionId, bookId, { title: "Utilitarianism" });
  for (const kind of ["front", "back"] as const) {
    await saveIntakeImage(sessionId, bookId, {
      kind,
      mimeType: "image/jpeg",
      bytes: fakeJpeg(),
    });
  }
  return { sessionId, bookId };
}

describe("lib/intake/push — image upload count (WI-1)", () => {
  useTmpEnv();

  afterEach(() => {
    vi.clearAllMocks();
  });

  function arrangeHappyPath() {
    getTokenMock.mockResolvedValue("tok");
    findItemMock.mockResolvedValue({ itemID: "42", ean: EAN });
    updateItemMock.mockResolvedValue({ itemID: "42", ean: EAN });
    let n = 0;
    uploadItemImageMock.mockImplementation(async () => ({ imageID: String(++n) }));
  }

  it("uploads exactly one image per kind for a single push", async () => {
    arrangeHappyPath();
    const { submitIntakeBook } = await import("../../src/lib/intake/push");
    const { sessionId, bookId } = await seedReviewedBook();

    const result = await submitIntakeBook(sessionId, bookId);

    expect(result).toEqual({ ok: true, itemID: "42", imageCount: 2 });
    expect(uploadItemImageMock).toHaveBeenCalledTimes(2);
    expect(uploadItemImageMock.mock.calls.map((c) => c[2].ordering)).toEqual([0, 1]);
  });

  it("does not upload a second set when the push is dispatched twice at once", async () => {
    arrangeHappyPath();
    const { submitIntakeBook } = await import("../../src/lib/intake/push");
    const { sessionId, bookId } = await seedReviewedBook();

    const [first, second] = await Promise.all([
      submitIntakeBook(sessionId, bookId),
      submitIntakeBook(sessionId, bookId),
    ]);

    expect(first).toEqual({ ok: true, itemID: "42", imageCount: 2 });
    // The duplicate invocation joins the in-flight push instead of re-running.
    expect(second).toEqual(first);
    expect(uploadItemImageMock).toHaveBeenCalledTimes(2);
    expect(updateItemMock).toHaveBeenCalledTimes(1);
  });

  it("allows a genuine retry after the first push settled", async () => {
    arrangeHappyPath();
    const { submitIntakeBook } = await import("../../src/lib/intake/push");
    const { sessionId, bookId } = await seedReviewedBook();

    await submitIntakeBook(sessionId, bookId);
    await submitIntakeBook(sessionId, bookId);

    expect(uploadItemImageMock).toHaveBeenCalledTimes(4);
  });
});

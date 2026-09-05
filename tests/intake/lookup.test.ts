import { afterEach, describe, expect, it, vi } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

/**
 * Unit tests for the US-B3 live Retail lookup. The Lightspeed connection (token)
 * and API (`findItemByEan`) are mocked, so no network is touched. These assert
 * that the lookup persists the right `retailLookupStatus` (found / missing /
 * error) + item id onto the intake book, and never throws for expected
 * failures (not connected / API error).
 */
vi.mock("../../src/lib/lightspeed/connection", () => ({
  getValidAccessToken: vi.fn(),
}));
vi.mock("../../src/lib/lightspeed/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/lightspeed/api")>(
    "../../src/lib/lightspeed/api",
  );
  return { ...actual, findItemByEan: vi.fn() };
});
vi.mock("../../src/lib/lightspeed/oauth", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/lightspeed/oauth")>(
    "../../src/lib/lightspeed/oauth",
  );
  return { ...actual, accountIdFromAccessToken: vi.fn(() => "314551") };
});

import { findItemByEan } from "../../src/lib/lightspeed/api";
import { getValidAccessToken } from "../../src/lib/lightspeed/connection";

const getTokenMock = vi.mocked(getValidAccessToken);
const findItemMock = vi.mocked(findItemByEan);

const EAN = "9789083436999";

async function seedBook() {
  const { createSession, addBookToSession, setBookEan } = await import("../../src/lib/intake");
  const sessionId = createSession();
  const bookId = addBookToSession(sessionId);
  const ean = setBookEan(sessionId, bookId, EAN);
  return { sessionId, bookId, ean };
}

describe("lib/intake/lookup", () => {
  useTmpEnv();

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records 'found' + the item id when the EAN exists in Retail", async () => {
    getTokenMock.mockResolvedValue("tok");
    findItemMock.mockResolvedValue({ itemID: "42", ean: EAN });

    const { lookupRetailItem } = await import("../../src/lib/intake/lookup");
    const { getIntakeBook } = await import("../../src/lib/intake");
    const { sessionId, bookId, ean } = await seedBook();

    const result = await lookupRetailItem(sessionId, bookId, ean);
    expect(result).toEqual({ status: "found", itemID: "42" });

    const book = getIntakeBook(sessionId, bookId);
    expect(book?.retailLookupStatus).toBe("found");
    expect(book?.retailItemID).toBe("42");
    expect(book?.retailLookupError).toBeNull();
  });

  it("records 'missing' when the EAN is not in Retail", async () => {
    getTokenMock.mockResolvedValue("tok");
    findItemMock.mockResolvedValue(undefined);

    const { lookupRetailItem } = await import("../../src/lib/intake/lookup");
    const { getIntakeBook } = await import("../../src/lib/intake");
    const { sessionId, bookId, ean } = await seedBook();

    const result = await lookupRetailItem(sessionId, bookId, ean);
    expect(result.status).toBe("missing");

    const book = getIntakeBook(sessionId, bookId);
    expect(book?.retailLookupStatus).toBe("missing");
    expect(book?.retailItemID).toBeNull();
  });

  it("records 'error' (never throws) when not connected", async () => {
    getTokenMock.mockResolvedValue(undefined);

    const { lookupRetailItem } = await import("../../src/lib/intake/lookup");
    const { getIntakeBook } = await import("../../src/lib/intake");
    const { sessionId, bookId, ean } = await seedBook();

    const result = await lookupRetailItem(sessionId, bookId, ean);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Not connected/);
    expect(findItemMock).not.toHaveBeenCalled();

    expect(getIntakeBook(sessionId, bookId)?.retailLookupStatus).toBe("error");
  });

  it("records 'error' (never throws) when the API call fails", async () => {
    getTokenMock.mockResolvedValue("tok");
    findItemMock.mockRejectedValue(new Error("boom"));

    const { lookupRetailItem } = await import("../../src/lib/intake/lookup");
    const { getIntakeBook } = await import("../../src/lib/intake");
    const { sessionId, bookId, ean } = await seedBook();

    const result = await lookupRetailItem(sessionId, bookId, ean);
    expect(result).toMatchObject({ status: "error", error: "boom" });
    expect(getIntakeBook(sessionId, bookId)?.retailLookupError).toBe("boom");
  });
});

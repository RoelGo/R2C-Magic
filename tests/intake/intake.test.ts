import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

describe("lib/intake", () => {
  useTmpEnv();

  it("createSession persists an active session with an optional label", async () => {
    const { createSession, getSessionDetail, listSessions } = await import("../../src/lib/intake");

    const id = createSession({ label: "  CB delivery  " });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i); // ULID

    const detail = getSessionDetail(id);
    expect(detail?.status).toBe("active");
    expect(detail?.label).toBe("CB delivery"); // trimmed
    expect(detail?.bookCount).toBe(0);
    expect(detail?.books).toEqual([]);

    const all = listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(id);
    expect(all[0]?.bookCount).toBe(0);
  });

  it("createSession stores a null label when blank/omitted", async () => {
    const { createSession, getSessionDetail } = await import("../../src/lib/intake");

    const blank = createSession({ label: "   " });
    expect(getSessionDetail(blank)?.label).toBeNull();

    const omitted = createSession();
    expect(getSessionDetail(omitted)?.label).toBeNull();
  });

  it("addBookToSession adds draft books and updates the count", async () => {
    const { createSession, addBookToSession, getSessionDetail } = await import(
      "../../src/lib/intake"
    );

    const sessionId = createSession();
    const a = addBookToSession(sessionId);
    const b = addBookToSession(sessionId);

    const detail = getSessionDetail(sessionId);
    expect(detail?.bookCount).toBe(2);
    expect(detail?.books.map((x) => x.id)).toContain(a);
    expect(detail?.books.map((x) => x.id)).toContain(b);
    for (const book of detail?.books ?? []) {
      expect(book.status).toBe("draft");
      expect(book.ean).toBeNull();
      expect(book.title).toBeNull();
    }
  });

  it("lists books newest-first within a session", async () => {
    const { createSession, addBookToSession, getSessionDetail } = await import(
      "../../src/lib/intake"
    );

    const sessionId = createSession();
    const first = addBookToSession(sessionId);
    const second = addBookToSession(sessionId);

    const books = getSessionDetail(sessionId)?.books ?? [];
    expect(books).toHaveLength(2);
    expect(books.map((b) => b.id).sort()).toEqual([first, second].sort());

    // Ordering is `createdAt desc, id desc`. Assert the returned order matches
    // that sort applied to the rows themselves (robust to two ULIDs sharing a
    // millisecond, where the random component — not insertion order — decides).
    const expected = [...books].sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      return t !== 0 ? t : b.id.localeCompare(a.id);
    });
    expect(books.map((b) => b.id)).toEqual(expected.map((b) => b.id));
    // Newest createdAt must sort first.
    expect(books[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      books[1]?.createdAt.getTime() ?? 0,
    );
  });

  it("addBookToSession throws for an unknown session", async () => {
    const { addBookToSession } = await import("../../src/lib/intake");
    expect(() => addBookToSession("nonexistent")).toThrow(/Unknown intake session/);
  });

  it("getSessionDetail returns undefined for an unknown session", async () => {
    const { getSessionDetail } = await import("../../src/lib/intake");
    expect(getSessionDetail("nope")).toBeUndefined();
  });

  it("getIntakeBook scopes lookups to the owning session", async () => {
    const { createSession, addBookToSession, getIntakeBook } = await import("../../src/lib/intake");

    const sessionA = createSession();
    const sessionB = createSession();
    const bookId = addBookToSession(sessionA);

    expect(getIntakeBook(sessionA, bookId)?.id).toBe(bookId);
    // Correct book id but wrong session must not resolve.
    expect(getIntakeBook(sessionB, bookId)).toBeUndefined();
  });

  it("setBookEan validates, normalizes, and persists the EAN", async () => {
    const { createSession, addBookToSession, setBookEan, getIntakeBook } = await import(
      "../../src/lib/intake"
    );

    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);

    const stored = setBookEan(sessionId, bookId, "978-0-14-032872-1");
    expect(stored).toBe("9780140328721"); // separators stripped
    expect(getIntakeBook(sessionId, bookId)?.ean).toBe("9780140328721");
  });

  it("setBookEan rejects an invalid check digit without persisting", async () => {
    const { createSession, addBookToSession, setBookEan, getIntakeBook } = await import(
      "../../src/lib/intake"
    );

    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);

    expect(() => setBookEan(sessionId, bookId, "9780140328722")).toThrow(/Invalid EAN-13/);
    expect(getIntakeBook(sessionId, bookId)?.ean).toBeNull();
  });

  it("setBookEan throws for an unknown book", async () => {
    const { createSession, setBookEan } = await import("../../src/lib/intake");
    const sessionId = createSession();
    expect(() => setBookEan(sessionId, "nope", "9780140328721")).toThrow(/Unknown intake book/);
  });
});

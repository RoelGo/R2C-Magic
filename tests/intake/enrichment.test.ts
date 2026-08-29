import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installM2FetchStub } from "../helpers/m2-fetch-stub";
import { useTmpEnv } from "../helpers/tmp-env";

// A Google Books "found" EAN from the recorded fixtures (title + authors +
// description) — resolves to a `done` enrichment with suggestions.
const HIT_EAN = "9789083436999";

describe("lib/intake/enrichment — disabled (default test env)", () => {
  useTmpEnv();

  it("startEnrichment marks the book empty synchronously when enrichment is off", async () => {
    // useTmpEnv sets ENRICHMENT_ENABLED=false by default.
    const { createSession, addBookToSession, setBookEan } = await import("../../src/lib/intake");
    const { startEnrichment, getEnrichmentSnapshot } = await import(
      "../../src/lib/intake/enrichment"
    );

    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    const ean = setBookEan(sessionId, bookId, HIT_EAN);

    startEnrichment(sessionId, bookId, ean);

    const snap = getEnrichmentSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("empty");
    expect(snap?.errors).toEqual([]);
  });

  it("getEnrichmentSnapshot returns undefined for an unknown book", async () => {
    const { createSession } = await import("../../src/lib/intake");
    const { getEnrichmentSnapshot } = await import("../../src/lib/intake/enrichment");
    const sessionId = createSession();
    expect(getEnrichmentSnapshot(sessionId, "nope")).toBeUndefined();
  });
});

describe("lib/intake/enrichment — enabled with recorded fixtures", () => {
  useTmpEnv();
  let restoreFetch: () => void;

  beforeEach(() => {
    // Opt back into the live-call path and stub fetch with recorded fixtures.
    process.env.ENRICHMENT_ENABLED = "true";
    vi.resetModules();
    restoreFetch = installM2FetchStub().restore;
  });

  afterEach(() => {
    restoreFetch?.();
  });

  it("runEnrichment resolves a found EAN to done with suggestions + title", async () => {
    const { createSession, addBookToSession, setBookEan, getIntakeBook } = await import(
      "../../src/lib/intake"
    );
    const { runEnrichment, getEnrichmentSnapshot } = await import(
      "../../src/lib/intake/enrichment"
    );

    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    const ean = setBookEan(sessionId, bookId, HIT_EAN);

    const errors = await runEnrichment(sessionId, bookId, ean);
    expect(errors).toEqual([]);

    const snap = getEnrichmentSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("done");
    expect(snap?.suggestions.title).toBe("Vrouwen die oorlog zien");
    expect(snap?.suggestions.authors).toContain("Viktorija Amelina");
    expect(snap?.suggestions.descriptionShort?.length).toBeGreaterThan(0);

    // The enriched title is mirrored onto the book row for the session list.
    expect(getIntakeBook(sessionId, bookId)?.title).toBe("Vrouwen die oorlog zien");
  });

  it("runEnrichment resolves an unknown EAN to empty (no online match)", async () => {
    const { createSession, addBookToSession, setBookEan } = await import("../../src/lib/intake");
    const { runEnrichment, getEnrichmentSnapshot } = await import(
      "../../src/lib/intake/enrichment"
    );

    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    // Valid EAN-13 check digit but no fixture → both sources return empty.
    const ean = setBookEan(sessionId, bookId, "9789089684592");

    const errors = await runEnrichment(sessionId, bookId, ean);
    expect(errors).toEqual([]);
    expect(getEnrichmentSnapshot(sessionId, bookId)?.status).toBe("empty");
  });
});

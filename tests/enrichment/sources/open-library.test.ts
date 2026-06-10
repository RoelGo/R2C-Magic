/**
 * Open Library adapter — contract tests against recorded fixtures.
 *
 * The "found" case threads three HTTP responses (/api/books, /isbn,
 * /works) through one fetchByEan call; the mock queue returns them in
 * order. AGENTS.md rule 5: no live calls in CI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enrichmentFromApiBooks,
  mergeIsbnEnrichment,
  normalizeDescription,
  openLibrarySource,
  parseWeightToGrams,
} from "../../../src/lib/enrichment/sources/open-library";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "open-library");
const loadText = (name: string) => readFileSync(join(FIXTURE_DIR, name), "utf8");

interface MockResponseInit {
  status?: number;
  body: string;
}

/** Queue successive responses for successive fetch() calls. */
function queueFetchResponses(...responses: MockResponseInit[]) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const { status = 200, body } of responses) {
    spy.mockResolvedValueOnce(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );
  }
  return spy;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("openLibrarySource.fetchByEan", () => {
  it("combines /api/books + /isbn + /works for a found edition", async () => {
    const fetchSpy = queueFetchResponses(
      { body: loadText("9780140328721-api-books.json") },
      { body: loadText("9780140328721-isbn.json") },
      { body: loadText("OL45804W-work.json") },
    );

    const result = await openLibrarySource.fetchByEan(
      "9780140328721",
      new AbortController().signal,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Verify each URL was hit in the expected order.
    expect((fetchSpy.mock.calls[0]?.[0] as string).toString()).toContain(
      "/api/books?bibkeys=ISBN:9780140328721",
    );
    expect((fetchSpy.mock.calls[1]?.[0] as string).toString()).toContain(
      "/isbn/9780140328721.json",
    );
    expect((fetchSpy.mock.calls[2]?.[0] as string).toString()).toContain("/works/OL45804W.json");
    // All three calls carry the polite User-Agent.
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["User-Agent"]).toMatch(/r2c-magic/);
    }

    expect(result.httpStatus).toBe(200);
    expect(result.data.titleShort).toBe("Fantastic Mr. Fox");
    expect(result.data.authors).toEqual(["Roald Dahl"]);
    expect(result.data.publisher).toBe("Puffin");
    expect(result.data.publicationDate).toBe("October 1, 1988");
    expect(result.data.pages).toBe(96);
    expect(result.data.categories).toContain("Foxes");
    expect(result.data.language).toBe("eng");
    expect(result.data.coverImageUrls?.[0]).toContain("covers.openlibrary.org");
    expect(result.data.descriptionLong).toContain("Mr. Fox");
  });

  it("returns empty data for a genuine miss", async () => {
    queueFetchResponses({ body: loadText("9780000000001-api-books.json") });

    const result = await openLibrarySource.fetchByEan(
      "9780000000001",
      new AbortController().signal,
    );

    expect(result.data).toEqual({});
  });

  it("still emits step 1's data when step 2 fails", async () => {
    queueFetchResponses(
      { body: loadText("9780140328721-api-books.json") },
      { status: 503, body: "Service Unavailable" },
    );

    const result = await openLibrarySource.fetchByEan(
      "9780140328721",
      new AbortController().signal,
    );

    expect(result.data.titleShort).toBe("Fantastic Mr. Fox");
    // No language because step 2 failed — but step 1's authors survived.
    expect(result.data.language).toBeUndefined();
    expect(result.data.authors).toEqual(["Roald Dahl"]);
  });

  it("throws when step 1 returns a non-OK status", async () => {
    queueFetchResponses({ status: 500, body: "boom" });
    await expect(
      openLibrarySource.fetchByEan("9780140328721", new AbortController().signal),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("respects the AbortSignal", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });

    const pending = openLibrarySource.fetchByEan("9780140328721", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe("enrichmentFromApiBooks", () => {
  it("ignores publishers when the array is empty", () => {
    expect(enrichmentFromApiBooks({ title: "T", publishers: [] }).publisher).toBeUndefined();
  });
});

describe("mergeIsbnEnrichment", () => {
  it("does not overwrite an existing language", () => {
    const out = { language: "fra" };
    mergeIsbnEnrichment(out, { languages: [{ key: "/languages/eng" }] });
    expect(out.language).toBe("fra");
  });

  it("falls back to cover IDs only when step 1 had no covers", () => {
    const out = { coverImageUrls: ["https://existing.example/a.jpg"] };
    mergeIsbnEnrichment(out, { covers: [123, 456] });
    expect(out.coverImageUrls).toEqual(["https://existing.example/a.jpg"]);

    const out2 = {};
    mergeIsbnEnrichment(out2, { covers: [123, -1, 456] });
    expect((out2 as { coverImageUrls?: string[] }).coverImageUrls).toEqual([
      "https://covers.openlibrary.org/b/id/123-L.jpg",
      "https://covers.openlibrary.org/b/id/456-L.jpg",
    ]);
  });
});

describe("normalizeDescription", () => {
  it("accepts the bare-string form", () => {
    expect(normalizeDescription("plain text")).toBe("plain text");
  });

  it("accepts the typed-object form", () => {
    expect(normalizeDescription({ value: "from object" })).toBe("from object");
  });

  it("returns undefined for unknown shapes", () => {
    expect(normalizeDescription(undefined)).toBeUndefined();
  });
});

describe("parseWeightToGrams", () => {
  it("parses grams", () => {
    expect(parseWeightToGrams("240 grams")).toBe(240);
    expect(parseWeightToGrams("240g")).toBe(240);
  });

  it("converts kg to grams", () => {
    expect(parseWeightToGrams("1.2 kg")).toBe(1200);
    expect(parseWeightToGrams("1,2 kg")).toBe(1200); // European decimal comma
  });

  it("converts pounds to grams", () => {
    expect(parseWeightToGrams("2 lb")).toBe(907);
  });

  it("returns undefined for unparseable input", () => {
    expect(parseWeightToGrams("about a pound")).toBeUndefined();
    expect(parseWeightToGrams("")).toBeUndefined();
  });
});

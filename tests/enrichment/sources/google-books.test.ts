/**
 * Google Books adapter — contract tests against recorded fixtures.
 *
 * Per AGENTS.md rule 5, we never hit the live API. Fixtures live alongside
 * this file under `__fixtures__/google-books/` and are loaded synchronously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GoogleBooksVolumesResponse,
  extractEnrichment,
  googleBooksSource,
  normalizeCoverUrl,
} from "../../../src/lib/enrichment/sources/google-books";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "google-books");

function loadFixture(name: string): { json: GoogleBooksVolumesResponse; text: string } {
  const text = readFileSync(join(FIXTURE_DIR, name), "utf8");
  return { json: JSON.parse(text) as GoogleBooksVolumesResponse, text };
}

interface MockResponseInit {
  status?: number;
  body: string;
}

function mockFetchOnce({ status = 200, body }: MockResponseInit) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("googleBooksSource.fetchByEan", () => {
  it("maps a found volume to PartialEnrichment", async () => {
    const { text } = loadFixture("9780140328721-found.json");
    const fetchSpy = mockFetchOnce({ body: text });

    const result = await googleBooksSource.fetchByEan(
      "9780140328721",
      new AbortController().signal,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("q")).toBe("isbn:9780140328721");

    expect(result.httpStatus).toBe(200);
    expect(result.data.titleShort).toBe("Fantastic Mr Fox");
    expect(result.data.titleLong).toBe("Fantastic Mr Fox: Colour Edition");
    expect(result.data.authors).toEqual(["Roald Dahl"]);
    expect(result.data.publisher).toBe("Penguin UK");
    expect(result.data.pages).toBe(96);
    expect(result.data.language).toBe("en");
    expect(result.data.publicationDate).toBe("2016-02-04");
    expect(result.data.categories).toEqual(["Juvenile Fiction / Animals / Foxes"]);
    expect(result.data.coverImageUrls?.length).toBeGreaterThan(0);
    // URLs upgraded to https and stripped of the curl artifact.
    expect(result.data.coverImageUrls?.[0]).toMatch(/^https:/);
    expect(result.data.coverImageUrls?.[0]).not.toMatch(/edge=curl/);
  });

  it("returns empty data for a 'no items' response", async () => {
    const { text } = loadFixture("9999999999999-not-found.json");
    mockFetchOnce({ body: text });

    const result = await googleBooksSource.fetchByEan(
      "9999999999999",
      new AbortController().signal,
    );

    expect(result.httpStatus).toBe(200);
    expect(result.data).toEqual({});
  });

  it("throws a recordable error on HTTP 429 (quota exceeded)", async () => {
    const { text } = loadFixture("quota-exceeded.json");
    mockFetchOnce({ status: 429, body: text });

    await expect(
      googleBooksSource.fetchByEan("9789462673359", new AbortController().signal),
    ).rejects.toThrow(/rate-limited|429/i);
  });

  it("respects the AbortSignal", async () => {
    const controller = new AbortController();
    // Simulate fetch honouring the signal by rejecting with AbortError.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = googleBooksSource.fetchByEan("9780140328721", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});

describe("normalizeCoverUrl", () => {
  it("upgrades http to https and removes edge=curl", () => {
    expect(
      normalizeCoverUrl(
        "http://books.google.com/books/content?id=x&printsec=frontcover&img=1&zoom=1&edge=curl&source=gbs_api",
      ),
    ).toBe(
      "https://books.google.com/books/content?id=x&printsec=frontcover&img=1&zoom=1&source=gbs_api",
    );
  });

  it("is a no-op for already-clean URLs", () => {
    expect(normalizeCoverUrl("https://example.com/cover.jpg")).toBe(
      "https://example.com/cover.jpg",
    );
  });
});

describe("extractEnrichment", () => {
  it("falls back to title when subtitle is absent", () => {
    expect(extractEnrichment({ title: "Bare Title" })).toMatchObject({
      titleShort: "Bare Title",
      titleLong: "Bare Title",
    });
  });

  it("returns an empty object for an empty volumeInfo", () => {
    expect(extractEnrichment({})).toEqual({});
  });

  it("deduplicates identical normalized cover URLs", () => {
    // smallThumbnail and thumbnail often differ only in `zoom=` / curl; this
    // adapter does NOT normalize zoom away, so distinct zooms survive — but
    // genuinely identical URLs after http→https and curl strip should dedup.
    const result = extractEnrichment({
      imageLinks: {
        smallThumbnail: "http://x/cover?img=1&zoom=5&edge=curl",
        thumbnail: "https://x/cover?img=1&zoom=5",
      },
    });
    expect(result.coverImageUrls).toEqual(["https://x/cover?img=1&zoom=5"]);
  });
});

/**
 * Tests for the single-book worker. We mock `enabledSources` so the
 * worker's behaviour is observable without hitting any network.
 *
 * The worker has four interesting branches:
 *  1. cache miss → live call → cache hit → second call uses cache
 *  2. one source errors → recorded in EnrichedBook.errors + the book row
 *  3. every source errors → book row marked 'failed'
 *  4. errors are not cached → the next run re-calls the upstream
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichmentSource } from "../../src/lib/enrichment/sources/source";
import { useTmpEnv } from "../helpers/tmp-env";

const enabledMock = vi.fn<() => readonly EnrichmentSource[]>(() => []);
vi.mock("../../src/lib/enrichment/sources", () => ({
  enabledSources: () => enabledMock(),
}));

beforeEach(() => {
  enabledMock.mockReset();
});
afterEach(() => {
  enabledMock.mockReset();
});

async function setupBook() {
  const { createRun } = await import("../../src/lib/runs");
  const csv = `EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt
9780140328721,Fantastic Mr Fox,Roald Dahl,,,10.00,15.00,CB,Item,1,0
`;
  const { runId } = await createRun({ fileName: "x.csv", content: csv });
  const db = await import("../../src/lib/db/client").then((m) => m.getDb());
  const { books } = await import("../../src/lib/db/schema");
  const book = db.select().from(books).where(eq(books.runId, runId)).get();
  if (!book) throw new Error("setup failed");
  return { runId, bookId: book.id, db, books };
}

describe("jobs/runner", () => {
  useTmpEnv();

  it("calls every enabled source and persists hits to cache", async () => {
    const gb: EnrichmentSource = {
      id: "google-books",
      displayName: "gb",
      isEnabled: () => true,
      fetchByEan: async () => ({
        data: { titleShort: "Fantastic Mr Fox", authors: ["Roald Dahl"] },
        httpStatus: 200,
      }),
    };
    const ol: EnrichmentSource = {
      id: "open-library",
      displayName: "ol",
      isEnabled: () => true,
      fetchByEan: async () => ({ data: { publisher: "Puffin" }, httpStatus: 200 }),
    };
    enabledMock.mockReturnValue([gb, ol]);
    const gbSpy = vi.spyOn(gb, "fetchByEan");
    const olSpy = vi.spyOn(ol, "fetchByEan");

    const { bookId, db, books } = await setupBook();
    const { processBook } = await import("../../src/lib/jobs/runner");
    const { loadMappingConfig } = await import("../../src/lib/csv/mapping");

    const result = await processBook(bookId, loadMappingConfig());

    expect(result.status).toBe("done");
    expect(result.errors).toEqual([]);
    expect(gbSpy).toHaveBeenCalledOnce();
    expect(olSpy).toHaveBeenCalledOnce();

    const row = db.select().from(books).where(eq(books.id, bookId)).get();
    expect(row?.status).toBe("done");
    const merged = row?.enrichedPayload as Record<string, unknown>;
    expect(merged.titleShort).toBe("Fantastic Mr Fox");
    expect(merged.publisher).toBe("Puffin");

    // Second call should re-use the cache and NOT hit live again.
    await processBook(bookId, loadMappingConfig());
    expect(gbSpy).toHaveBeenCalledOnce();
    expect(olSpy).toHaveBeenCalledOnce();
  });

  it("records per-source errors without failing the book", async () => {
    const gb: EnrichmentSource = {
      id: "google-books",
      displayName: "gb",
      isEnabled: () => true,
      fetchByEan: async () => ({ data: { titleShort: "Title" }, httpStatus: 200 }),
    };
    const ol: EnrichmentSource = {
      id: "open-library",
      displayName: "ol",
      isEnabled: () => true,
      fetchByEan: async () => {
        throw new Error("network exploded");
      },
    };
    enabledMock.mockReturnValue([gb, ol]);

    const { bookId, db, books } = await setupBook();
    const { processBook } = await import("../../src/lib/jobs/runner");
    const { loadMappingConfig } = await import("../../src/lib/csv/mapping");

    const result = await processBook(bookId, loadMappingConfig());

    expect(result.status).toBe("done");
    expect(result.errors).toContainEqual({ source: "open-library", message: "network exploded" });

    const row = db.select().from(books).where(eq(books.id, bookId)).get();
    expect(row?.status).toBe("done");
    expect(row?.errors).toContainEqual({
      source: "open-library",
      message: "network exploded",
    });
  });

  it("marks the book 'failed' only when every source errored", async () => {
    const gb: EnrichmentSource = {
      id: "google-books",
      displayName: "gb",
      isEnabled: () => true,
      fetchByEan: async () => {
        throw new Error("boom 1");
      },
    };
    const ol: EnrichmentSource = {
      id: "open-library",
      displayName: "ol",
      isEnabled: () => true,
      fetchByEan: async () => {
        throw new Error("boom 2");
      },
    };
    enabledMock.mockReturnValue([gb, ol]);

    const { bookId, db, books } = await setupBook();
    const { processBook } = await import("../../src/lib/jobs/runner");
    const { loadMappingConfig } = await import("../../src/lib/csv/mapping");

    const result = await processBook(bookId, loadMappingConfig());
    expect(result.status).toBe("failed");

    const row = db.select().from(books).where(eq(books.id, bookId)).get();
    expect(row?.status).toBe("failed");
  });

  it("re-calls the upstream on the next run because errors are not cached", async () => {
    const ol: EnrichmentSource = {
      id: "open-library",
      displayName: "ol",
      isEnabled: () => true,
      fetchByEan: async () => {
        throw new Error("first attempt failed");
      },
    };
    enabledMock.mockReturnValue([ol]);
    const olSpy = vi.spyOn(ol, "fetchByEan");

    const { bookId } = await setupBook();
    const { processBook } = await import("../../src/lib/jobs/runner");
    const { loadMappingConfig } = await import("../../src/lib/csv/mapping");

    await processBook(bookId, loadMappingConfig());
    await processBook(bookId, loadMappingConfig());

    // Thrown errors are never cached, so each run re-hits the upstream.
    expect(olSpy).toHaveBeenCalledTimes(2);
  });

  it("writes an enrichments row for every source call (live or cached)", async () => {
    const gb: EnrichmentSource = {
      id: "google-books",
      displayName: "gb",
      isEnabled: () => true,
      fetchByEan: async () => ({ data: { titleShort: "T" }, httpStatus: 200 }),
    };
    enabledMock.mockReturnValue([gb]);

    const { bookId, db } = await setupBook();
    const { enrichments } = await import("../../src/lib/db/schema");
    const { processBook } = await import("../../src/lib/jobs/runner");
    const { loadMappingConfig } = await import("../../src/lib/csv/mapping");

    await processBook(bookId, loadMappingConfig());
    await processBook(bookId, loadMappingConfig());

    const rows = db.select().from(enrichments).where(eq(enrichments.bookId, bookId)).all();
    // 1 live + 1 cached → 2 rows for the same source.
    expect(rows).toHaveLength(2);
  });
});

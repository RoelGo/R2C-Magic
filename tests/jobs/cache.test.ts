/**
 * Tests for the enrichment-cache helper. We exercise the round trip via a
 * real SQLite DB (cheaper than mocking Drizzle) and only stub the clock
 * for TTL assertions.
 */
import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

describe("jobs/cache", () => {
  useTmpEnv();

  it("round-trips a hit (data is recoverable, no error reported)", async () => {
    const { getCached, putCachedHit } = await import("../../src/lib/jobs/cache");
    // Touch the DB so the table exists before we read.
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedHit("google-books", "9780140328721", { titleShort: "Fantastic Mr Fox" }, 200);

    const result = getCached("google-books", "9780140328721");
    expect(result?.kind).toBe("hit");
    if (result?.kind === "hit") {
      expect(result.data.titleShort).toBe("Fantastic Mr Fox");
      expect(result.httpStatus).toBe(200);
    }
  });

  it("treats an empty {} payload as a cached miss (still 'hit' kind)", async () => {
    const { getCached, putCachedHit } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedHit("open-library", "9999999999999", {}, 200);

    const result = getCached("open-library", "9999999999999");
    expect(result?.kind).toBe("hit");
    if (result?.kind === "hit") {
      expect(result.data).toEqual({});
    }
  });

  it("round-trips an error", async () => {
    const { getCached, putCachedError } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedError("google-books", "9789462673359", "Google Books rate-limited (HTTP 429)", 429);

    const result = getCached("google-books", "9789462673359");
    expect(result?.kind).toBe("error");
    if (result?.kind === "error") {
      expect(result.message).toMatch(/rate-limited/);
      expect(result.httpStatus).toBe(429);
    }
  });

  it("returns undefined for an unknown key", async () => {
    const { getCached } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    expect(getCached("google-books", "0000000000000")).toBeUndefined();
  });

  it("expires hits after ENRICH_CACHE_TTL_DAYS", async () => {
    const { getCached, putCachedHit } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedHit("google-books", "9780140328721", { titleShort: "x" }, 200);

    // Within TTL → still a hit.
    expect(getCached("google-books", "9780140328721", new Date())?.kind).toBe("hit");

    // 31 days later → expired (default TTL is 30 days).
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(getCached("google-books", "9780140328721", future)).toBeUndefined();
  });

  it("expires errors faster than hits (ENRICH_ERROR_CACHE_TTL_HOURS)", async () => {
    const { getCached, putCachedError } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedError("google-books", "9789462673359", "transient", 503);

    // Within 6h (default) → still cached.
    const inside = new Date(Date.now() + 5 * 60 * 60 * 1000);
    expect(getCached("google-books", "9789462673359", inside)?.kind).toBe("error");

    // 7h later → expired.
    const outside = new Date(Date.now() + 7 * 60 * 60 * 1000);
    expect(getCached("google-books", "9789462673359", outside)).toBeUndefined();
  });

  it("overwrites a prior entry on conflict", async () => {
    const { getCached, putCachedError, putCachedHit } = await import("../../src/lib/jobs/cache");
    await import("../../src/lib/db/client").then((m) => m.getDb());

    putCachedError("open-library", "9780140328721", "first attempt failed", 500);
    expect(getCached("open-library", "9780140328721")?.kind).toBe("error");

    // Retry succeeded.
    putCachedHit("open-library", "9780140328721", { titleShort: "ok" }, 200);
    const after = getCached("open-library", "9780140328721");
    expect(after?.kind).toBe("hit");
    if (after?.kind === "hit") {
      expect(after.data.titleShort).toBe("ok");
    }
  });
});

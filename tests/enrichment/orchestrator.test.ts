/**
 * Behavioural tests for the per-book orchestrator. We mock the enabled-source
 * registry so we never touch the network and can control timing precisely.
 *
 * The key contract checked here: each source has its own AbortController +
 * timeout budget, so a slow upstream cannot kill the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMappingConfig } from "../../src/lib/csv/mapping";
import type { EnrichmentSource } from "../../src/lib/enrichment/sources/source";
import type { BookSource, RSeriesRow } from "../../src/types/book";

const rSeries: RSeriesRow = {
  systemId: "1",
  ean: "9789462673359",
  item: "Title",
  subcategories: [],
};
const source: BookSource = { kind: "r-series", rSeries };

const enabledMock = vi.fn<() => readonly EnrichmentSource[]>(() => []);
vi.mock("../../src/lib/enrichment/sources", () => ({
  enabledSources: () => enabledMock(),
}));

// Keep the timeout short so the "slow source" branch finishes in milliseconds.
beforeEach(() => {
  vi.stubEnv("ENRICH_TIMEOUT_MS", "30");
  vi.stubEnv("LOG_LEVEL", "fatal");
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  enabledMock.mockReset();
});

async function importOrchestrator() {
  return await import("../../src/lib/enrichment/orchestrator");
}

describe("enrichBook orchestrator", () => {
  it("aborts a slow source without affecting the others", async () => {
    const fastSource: EnrichmentSource = {
      id: "google-books",
      displayName: "fast",
      isEnabled: () => true,
      fetchByEan: async () => ({ data: { titleLong: "fast title" }, httpStatus: 200 }),
    };
    const slowSource: EnrichmentSource = {
      id: "open-library",
      displayName: "slow",
      isEnabled: () => true,
      fetchByEan: (_ean, signal) =>
        new Promise((_resolve, reject) => {
          // Never resolves until aborted. Reject with an AbortError shape so
          // the orchestrator records it as an error rather than data.
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    };
    enabledMock.mockReturnValue([fastSource, slowSource]);

    const { enrichBook } = await importOrchestrator();
    const config = loadMappingConfig();
    const start = Date.now();
    const enriched = await enrichBook(source, config);
    const elapsed = Date.now() - start;

    // The slow source aborted; the fast source still contributed.
    expect(enriched.titleLong).toBe("fast title");
    expect(enriched.errors.some((e) => e.source === "open-library")).toBe(true);
    // Wall time stays close to the timeout, not anywhere near "forever".
    expect(elapsed).toBeLessThan(500);
  });

  it("records per-source thrown errors without crashing", async () => {
    const ok: EnrichmentSource = {
      id: "google-books",
      displayName: "ok",
      isEnabled: () => true,
      fetchByEan: async () => ({ data: { titleLong: "ok title" }, httpStatus: 200 }),
    };
    const boom: EnrichmentSource = {
      id: "open-library",
      displayName: "boom",
      isEnabled: () => true,
      fetchByEan: async () => {
        throw new Error("network exploded");
      },
    };
    enabledMock.mockReturnValue([ok, boom]);

    const { enrichBook } = await importOrchestrator();
    const enriched = await enrichBook(source, loadMappingConfig());

    expect(enriched.titleLong).toBe("ok title");
    expect(enriched.errors).toContainEqual({ source: "open-library", message: "network exploded" });
  });
});

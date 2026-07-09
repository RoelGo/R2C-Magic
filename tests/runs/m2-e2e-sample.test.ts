/**
 * M2 end-to-end against the real rokko CB-intake sample.
 *
 * Upload `imports/sjabloon invoer CB lightspeed - sjabloon.csv` (29 Dutch
 * books) → enqueue → process through the real queue → assert both the
 * generated C-Series CSV and the underlying `EnrichedBook` records in the
 * DB.
 *
 * The test is the production code path end-to-end *except* for `fetch`,
 * which is stubbed to serve recorded Google Books fixtures + permanent
 * "not found" responses from Open Library (verified during fixture
 * selection — see the piece 5 commit). This means the test encodes the
 * real-world data quality our users will see for Dutch books today
 * (Google Books has thin metadata, Open Library has zero coverage)
 * rather than pretending richer data exists.
 *
 * To keep the suite hermetic this is the *only* test that flips
 * `ENRICHMENT_ENABLED=true` — the rest of the suite stays offline via
 * `useTmpEnv`'s default `false`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installM2FetchStub } from "../helpers/m2-fetch-stub";
import { useTmpEnv } from "../helpers/tmp-env";

const SAMPLE_PATH = join(process.cwd(), "imports", "sjabloon invoer CB lightspeed - sjabloon.csv");

/** EANs in the sample for which we have a real Google Books "found" fixture. */
const GB_HIT_EANS = [
  "9789083436999",
  "9789403139838",
  "9789045132129",
  "9789401305365",
  "9789029097260",
] as const;

/** EAN we know Google Books does *not* find (the documented Dutch-gap case). */
const GB_KNOWN_MISS_EAN = "9789089684592";

/** Only one of the 5 Google Books hits actually carried a description. */
const GB_HIT_WITH_DESCRIPTION = "9789083436999";

describe("M2 end-to-end against the rokko CB-intake sample", () => {
  useTmpEnv();

  let restoreFetch: () => void;

  beforeAll(() => {
    const stub = installM2FetchStub();
    restoreFetch = stub.restore;
  });

  afterAll(() => {
    restoreFetch?.();
  });

  // The rokko CB-intake sample lives under `imports/` and is intentionally
  // gitignored (real inventory), so it is absent in CI. Skip the whole test
  // when the file isn't present — mirrors e2e-sample + cb-intake-e2e-sample.
  it.runIf(existsSync(SAMPLE_PATH))(
    "enriches every book and produces a downloadable C-Series export",
    async () => {
      // `useTmpEnv` sets ENRICHMENT_ENABLED=false in its beforeEach. This
      // test exercises the live-call path through the stub, so we flip it
      // back on AND reset modules — config is read once at import time,
      // so a fresh import is needed for the new value to land.
      process.env.ENRICHMENT_ENABLED = "true";
      vi.resetModules();

      const { createRun, getRun, getLatestExportPath } = await import("../../src/lib/runs");
      const { processRunInline } = await import("../../src/lib/jobs/run");
      const { getDb } = await import("../../src/lib/db/client");
      const { books } = await import("../../src/lib/db/schema");
      const { eq } = await import("drizzle-orm");

      const csv = readFileSync(SAMPLE_PATH, "utf8");
      const { runId, format, totalBooks } = await createRun({
        fileName: "sjabloon.csv",
        content: csv,
      });

      expect(format).toBe("cb-intake");
      expect(totalBooks).toBe(29);

      const result = await processRunInline(runId);
      expect(result.status).toBe("completed");

      // ----- Run-level assertions ---------------------------------------
      const run = getRun(runId);
      expect(run?.status).toBe("completed");
      expect(run?.totalBooks).toBe(29);
      expect(run?.processedBooks).toBe(29);
      // Misses are not failures: every book should land as `done`.
      expect(run?.failedBooks).toBe(0);

      // ----- Export file assertions -------------------------------------
      const exportPath = getLatestExportPath(runId);
      if (!exportPath) throw new Error("export not written");
      const exportCsv = readFileSync(exportPath, "utf8");
      const lines = exportCsv.split(/\r\n/).filter((l) => l.length > 0);
      expect(lines).toHaveLength(30); // header + 29 books

      const headers = lines[0]?.split(";") ?? [];
      const headerIdx = (name: string) => {
        const i = headers.indexOf(name);
        if (i < 0) throw new Error(`header ${name} missing from export`);
        return i;
      };
      const idxEan = headerIdx("EAN");
      const idxTitleShort = headerIdx("NL_Title_Short");
      const idxTitleLong = headerIdx("NL_Title_Long");
      const idxDescLong = headerIdx("NL_Description_Long");
      const idxBrand = headerIdx("Brand");
      const idxErrors = headerIdx("_enrichment_errors");

      // Index the data rows by EAN so we can assert per-book outcomes.
      const rowsByEan = new Map<string, string[]>();
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i]?.split(";") ?? [];
        const ean = cells[idxEan];
        if (ean) rowsByEan.set(ean, cells);
      }
      expect(rowsByEan.size).toBe(29);

      // Every Google Books hit row should have a NL_Title_Long populated
      // from the enriched title (CB-intake has no titleLong of its own).
      for (const ean of GB_HIT_EANS) {
        const row = rowsByEan.get(ean);
        expect(row, `missing row for ${ean}`).toBeDefined();
        const titleLong = row?.[idxTitleLong] ?? "";
        expect(titleLong.length, `${ean} should have NL_Title_Long`).toBeGreaterThan(0);
        // NL_Title_Short comes from the CB-intake `Description` column for
        // every row — independent of enrichment.
        expect(row?.[idxTitleShort]?.length).toBeGreaterThan(0);
        // None of these books has any errors; the column should be empty.
        expect(row?.[idxErrors]).toBe("");
      }

      // Only one of the five carries a description.
      const richRow = rowsByEan.get(GB_HIT_WITH_DESCRIPTION);
      expect(
        richRow?.[idxDescLong]?.length,
        "expected description for the one rich GB hit",
      ).toBeGreaterThan(50);

      // The other four GB hits have no description in the fixture; export
      // column should be blank.
      for (const ean of GB_HIT_EANS.filter((e) => e !== GB_HIT_WITH_DESCRIPTION)) {
        const row = rowsByEan.get(ean);
        expect(row?.[idxDescLong], `${ean} should have empty NL_Description_Long`).toBe("");
      }

      // The known Google-Books-miss row: enrichment found nothing, so the
      // enriched columns are blank. A miss is *not* an error — the errors
      // column stays empty.
      const missRow = rowsByEan.get(GB_KNOWN_MISS_EAN);
      expect(missRow, "missing row for the GB known-miss EAN").toBeDefined();
      expect(missRow?.[idxDescLong]).toBe("");
      expect(missRow?.[idxBrand]).toBe(""); // no publisher recovered
      expect(missRow?.[idxErrors]).toBe("");

      // Sanity: NL_Title_Short still flows from the CB-intake row even
      // when enrichment recovered nothing, because the mapping config
      // prefers the source CSV's title.
      expect(missRow?.[idxTitleShort]?.length).toBeGreaterThan(0);

      // ----- DB assertions ----------------------------------------------
      // Spot-check the persisted EnrichedBook for one rich + one miss EAN.
      // Asserting against the DB (not just the CSV) catches bugs where the
      // merge layer drops a field but the CSV writer happens to substitute
      // a source value.
      const db = getDb();

      const dbHit = db
        .select({ ean: books.ean, payload: books.enrichedPayload, status: books.status })
        .from(books)
        .where(eq(books.ean, GB_HIT_WITH_DESCRIPTION))
        .get();
      expect(dbHit?.status).toBe("done");
      expect(dbHit?.payload).toBeTruthy();
      const hitPayload = dbHit?.payload as {
        titleShort?: string;
        titleLong?: string;
        descriptionLong?: string;
        authors?: string[];
        fieldSources?: Record<string, string>;
      };
      expect(hitPayload.titleShort).toContain("Vrouwen die oorlog zien");
      expect(hitPayload.descriptionLong?.length ?? 0).toBeGreaterThan(50);
      // Provenance for each populated field should attribute Google Books.
      expect(hitPayload.fieldSources?.titleShort).toBe("google-books");
      expect(hitPayload.fieldSources?.descriptionLong).toBe("google-books");

      const dbMiss = db
        .select({ ean: books.ean, payload: books.enrichedPayload, status: books.status })
        .from(books)
        .where(eq(books.ean, GB_KNOWN_MISS_EAN))
        .get();
      // A miss still produces an EnrichedBook row — just with no fields
      // beyond the ones that come from the CB-intake source itself
      // (currently none mapped onto the canonical Book type).
      expect(dbMiss?.status).toBe("done");
      expect(dbMiss?.payload).toBeTruthy();
      const missPayload = dbMiss?.payload as {
        descriptionLong?: string;
        coverImageUrls?: string[];
      };
      expect(missPayload.descriptionLong).toBeUndefined();
      expect(missPayload.coverImageUrls ?? []).toHaveLength(0);
    },
    30_000,
  );
});

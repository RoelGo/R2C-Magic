import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

const REAL_SAMPLE = resolve(process.cwd(), "imports/item_listings_local_matches.csv");

describe("M1 end-to-end against the rokko sample", () => {
  useTmpEnv();

  it.runIf(existsSync(REAL_SAMPLE))(
    "uploading the real sample produces an export with one row per valid book",
    async () => {
      const { createRun, processRunSync, getLatestExportPath } = await import("../../src/lib/runs");

      const content = readFileSync(REAL_SAMPLE, "utf8");
      const created = await createRun({ fileName: "item_listings_local_matches.csv", content });
      expect(created.totalBooks).toBeGreaterThan(100);

      const result = await processRunSync(created.runId);
      expect(result.processedBooks).toBe(created.totalBooks);
      expect(result.failedBooks).toBe(0);

      const path = getLatestExportPath(created.runId);
      if (!path) throw new Error("export not written");
      const csv = readFileSync(path, "utf8");

      // Parse back as semicolon CSV — many rokko titles contain semicolons
      // inside quoted values (e.g. `"Up Your Ass; and ..."`).
      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        delimiter: ";",
        skipEmptyLines: true,
      });
      expect(parsed.errors).toEqual([]);
      expect(parsed.data).toHaveLength(created.totalBooks);

      const headers = parsed.meta.fields ?? [];
      expect(headers).toContain("EAN");
      expect(headers).toContain("NL_Title_Short");
      expect(headers).toContain("_enrichment_errors");
      expect(headers).toHaveLength(44); // 43 mapped columns + error column

      for (const row of parsed.data) {
        expect(row.EAN).toMatch(/^\d{13}$/);
        expect((row.NL_Title_Short ?? "").length).toBeGreaterThan(0);
        expect(row.Visible).toBe("Y");
      }
    },
    30_000,
  );
});

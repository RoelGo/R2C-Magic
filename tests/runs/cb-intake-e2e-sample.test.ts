import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

const REAL_SAMPLE = resolve(process.cwd(), "imports/sjabloon invoer CB lightspeed - sjabloon.csv");

describe("M1 end-to-end against the rokko CB-intake sample", () => {
  useTmpEnv();

  it.runIf(existsSync(REAL_SAMPLE))(
    "uploading the CB-intake template produces an export with one row per book",
    async () => {
      const { createRun, getLatestExportPath, getRun } = await import("../../src/lib/runs");
      const { processRunInline } = await import("../../src/lib/jobs/run");

      const content = readFileSync(REAL_SAMPLE, "utf8");
      const created = await createRun({
        fileName: "sjabloon invoer CB lightspeed - sjabloon.csv",
        content,
      });
      // The committed sample currently has 29 rows; assert >= 10 to stay
      // robust against rokko trimming the template later.
      expect(created.format).toBe("cb-intake");
      expect(created.totalBooks).toBeGreaterThan(10);

      const result = await processRunInline(created.runId);
      expect(result.status).toBe("completed");
      const run = getRun(created.runId);
      expect(run?.processedBooks).toBe(created.totalBooks);
      expect(run?.failedBooks).toBe(0);
      expect(run?.format).toBe("cb-intake");

      const path = getLatestExportPath(created.runId);
      if (!path) throw new Error("export not written");
      const csv = readFileSync(path, "utf8");

      const { loadMappingConfig } = await import("../../src/lib/csv/mapping");
      const cfg = loadMappingConfig();

      const parsed = Papa.parse<Record<string, string>>(csv, {
        header: true,
        delimiter: cfg.outputDelimiter,
        skipEmptyLines: true,
      });
      expect(parsed.errors).toEqual([]);
      expect(parsed.data).toHaveLength(created.totalBooks);

      const headers = parsed.meta.fields ?? [];
      expect(headers).toContain("EAN");
      expect(headers).toContain("NL_Title_Short");
      expect(headers).toContain("_enrichment_errors");
      // Exported headers must be exactly the non-ignored mapping columns plus
      // the error column — derived from the config so it survives mapping edits.
      const expectedHeaderCount =
        cfg.columns.filter((c) => c.type !== "ignore").length + (cfg.includeErrorColumn ? 1 : 0);
      expect(headers).toHaveLength(expectedHeaderCount);

      for (const row of parsed.data) {
        expect(row.EAN).toMatch(/^\d{13}$/);
        // NL_Title_Short comes from cb.description for CB-intake rows.
        expect((row.NL_Title_Short ?? "").length).toBeGreaterThan(0);
        expect(row.Visible).toBe("Y");
        // Until M2 enrichment lands, Brand stays blank for CB-intake rows
        // (the C-Series Brand column is the publisher, and cb.brand holds
        // the author — they intentionally don't alias).
        expect(row.Brand ?? "").toBe("");
        // R-Series-only columns (categories, etc.) are blank for CB rows.
        expect(row.NL_Category_1 ?? "").toBe("");
      }
    },
    30_000,
  );
});

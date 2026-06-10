import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTmpDir, useTmpEnv } from "../helpers/tmp-env";

const SAMPLE_CSV = `"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price","Tax","Brand","Publish to eCom","Season","Department","MSRP","Tax Class","Default Cost","Vendor","Category","Subcategory 1","Subcategory 2","Subcategory 3","Subcategory 4","Subcategory 5","Subcategory 6","Subcategory 7","Subcategory 8","Subcategory 9"
"210000000001","","9789462673359","","","Het begin van mijn leven was toen ik nog niet bestond","","0","€19.90","Yes","Fatima en Helen","No","","","19.90","Item","11.080000000","EPO","Boeken","Non-fictie","","","","","","","",""
"210000000003","","9789462673465","","","Angela Davis","","1","€25.00","Yes","Jan Reyniers","No","","","25.00","Item","14.090000000","CB","Boeken","Non-fictie","","","","","","","",""
`;

describe("lib/runs", () => {
  useTmpEnv();

  it("createRun persists a run and N book rows", async () => {
    const { createRun, listRuns, getRun } = await import("../../src/lib/runs");

    const result = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });

    expect(result.totalBooks).toBe(2);
    expect(result.invalidRows).toEqual([]);
    expect(result.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i); // ULID

    const all = listRuns();
    expect(all).toHaveLength(1);
    expect(all[0]?.sourceFileName).toBe("sample.csv");
    expect(all[0]?.status).toBe("pending");

    const single = getRun(result.runId);
    expect(single?.totalBooks).toBe(2);
  });

  it("createRun writes the source CSV under the run directory", async () => {
    const { createRun } = await import("../../src/lib/runs");
    const { sourceCsvPath } = await import("../../src/lib/runs/paths");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    const path = sourceCsvPath(runId);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(SAMPLE_CSV);
    expect(path.startsWith(getTmpDir())).toBe(true);
  });

  it("processRunSync writes a C-Series export and marks the run completed", async () => {
    const { createRun, processRunSync, getRun, getLatestExportPath } = await import(
      "../../src/lib/runs"
    );

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    const result = await processRunSync(runId);

    expect(result.processedBooks).toBe(2);
    expect(result.failedBooks).toBe(0);
    expect(existsSync(result.exportPath)).toBe(true);

    const run = getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.processedBooks).toBe(2);
    expect(run?.exportCount).toBe(1);

    expect(getLatestExportPath(runId)).toBe(result.exportPath);
  });

  it("export CSV has a C-Series header row and one data row per book", async () => {
    const { createRun, processRunSync, getLatestExportPath } = await import("../../src/lib/runs");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    await processRunSync(runId);

    const path = getLatestExportPath(runId);
    if (!path) throw new Error("export not written");

    const csv = readFileSync(path, "utf8");
    const lines = csv.split(/\r\n/).filter((l) => l.length > 0);
    expect(lines).toHaveLength(3); // header + 2 books

    const headers = lines[0]?.split(";") ?? [];
    expect(headers).toContain("EAN");
    expect(headers).toContain("Visible");
    expect(headers).toContain("_enrichment_errors");

    // EAN column should hold the book's ISBN-13
    const eanIdx = headers.indexOf("EAN");
    const visibleIdx = headers.indexOf("Visible");
    const titleIdx = headers.indexOf("NL_Title_Short");
    expect(lines[1]?.split(";")[eanIdx]).toBe("9789462673359");
    expect(lines[1]?.split(";")[visibleIdx]).toBe("Y");
    expect(lines[1]?.split(";")[titleIdx]).toContain("Het begin van mijn leven");

    // Per the M0 mapping config, Price/Tax/Stock_Level should be blank.
    for (const ignored of ["Price", "Tax", "Stock_Level", "Article_Code"]) {
      const idx = headers.indexOf(ignored);
      expect(lines[1]?.split(";")[idx], `${ignored} should be blank`).toBe("");
    }
  });

  it("listRuns returns runs ordered newest-first", async () => {
    const { createRun, processRunSync, listRuns } = await import("../../src/lib/runs");

    await createRun({ fileName: "first.csv", content: SAMPLE_CSV }).then((r) =>
      processRunSync(r.runId),
    );
    // Brief delay so the second run gets a later uploadedAt timestamp (ms precision).
    await new Promise((r) => setTimeout(r, 10));
    await createRun({ fileName: "second.csv", content: SAMPLE_CSV }).then((r) =>
      processRunSync(r.runId),
    );

    const runs = listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.sourceFileName).toBe("second.csv");
    expect(runs[1]?.sourceFileName).toBe("first.csv");
  });

  it("rejects unknown run IDs from getRun and processRunSync", async () => {
    const { getRun, processRunSync } = await import("../../src/lib/runs");

    expect(getRun("does-not-exist")).toBeUndefined();
    await expect(processRunSync("does-not-exist")).rejects.toThrow(/not found/);
  });
});

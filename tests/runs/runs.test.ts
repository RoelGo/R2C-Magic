import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTmpDir, useTmpEnv } from "../helpers/tmp-env";

const SAMPLE_CSV = `"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price","Tax","Brand","Publish to eCom","Season","Department","MSRP","Tax Class","Default Cost","Vendor","Category","Subcategory 1","Subcategory 2","Subcategory 3","Subcategory 4","Subcategory 5","Subcategory 6","Subcategory 7","Subcategory 8","Subcategory 9"
"210000000001","","9789462673359","","","Het begin van mijn leven was toen ik nog niet bestond","","0","€19.90","Yes","Fatima en Helen","No","","","19.90","Item","11.080000000","EPO","Boeken","Non-fictie","","","","","","","",""
"210000000003","","9789462673465","","","Angela Davis","","1","€25.00","Yes","Jan Reyniers","No","","","25.00","Item","14.090000000","CB","Boeken","Non-fictie","","","","","","","",""
`;

const CB_INTAKE_CSV = `EAN,Description,Brand,SKU,tag,aankoopprijs,verkoopprijs,leverancier,btw,gewenste voorraad,herbestellingspunt
9789083436999,Vrouwen die oorlog zien,Victoria Amelina,,nederlands,19.2,30.00,CB,Item,1,0
9789493399556,Het gore lef,Sarah Arnolds,,nederlands,12.74,22.50,CB,Item,1,0
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

  it("processRunInline writes a C-Series export and marks the run completed", async () => {
    const { createRun, getRun, getLatestExportPath } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    const result = await processRunInline(runId);

    expect(result.status).toBe("completed");
    const { exportPath } = result;
    if (!exportPath) throw new Error("export path missing");
    expect(existsSync(exportPath)).toBe(true);

    const run = getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.processedBooks).toBe(2);
    expect(run?.exportCount).toBe(1);

    expect(getLatestExportPath(runId)).toBe(exportPath);
  });

  it("export CSV has a C-Series header row and one data row per book", async () => {
    const { createRun, getLatestExportPath } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    await processRunInline(runId);

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
    const { createRun, listRuns } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");

    await createRun({ fileName: "first.csv", content: SAMPLE_CSV }).then((r) =>
      processRunInline(r.runId),
    );
    // Brief delay so the second run gets a later uploadedAt timestamp (ms precision).
    await new Promise((r) => setTimeout(r, 10));
    await createRun({ fileName: "second.csv", content: SAMPLE_CSV }).then((r) =>
      processRunInline(r.runId),
    );

    const runs = listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.sourceFileName).toBe("second.csv");
    expect(runs[1]?.sourceFileName).toBe("first.csv");
  });

  it("getRun returns undefined for unknown IDs; enqueueRun throws", async () => {
    const { getRun } = await import("../../src/lib/runs");
    const { enqueueRun } = await import("../../src/lib/jobs/run");

    expect(getRun("does-not-exist")).toBeUndefined();
    expect(() => enqueueRun("does-not-exist")).toThrow(/not found/);
  });

  it("detects R-Series format on the sample CSV and persists it on the run", async () => {
    const { createRun, getRun } = await import("../../src/lib/runs");
    const { runId, format } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    expect(format).toBe("r-series");
    expect(getRun(runId)?.format).toBe("r-series");
  });

  it("createRun also accepts a CB-intake template end-to-end", async () => {
    const { createRun, getLatestExportPath, getRun } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");

    const created = await createRun({ fileName: "cb-intake.csv", content: CB_INTAKE_CSV });
    expect(created.format).toBe("cb-intake");
    expect(created.totalBooks).toBe(2);

    const result = await processRunInline(created.runId);
    expect(result.status).toBe("completed");
    expect(getRun(created.runId)?.processedBooks).toBe(2);
    expect(getRun(created.runId)?.failedBooks).toBe(0);

    expect(getRun(created.runId)?.format).toBe("cb-intake");

    const path = getLatestExportPath(created.runId);
    if (!path) throw new Error("export not written");
    const csv = readFileSync(path, "utf8");

    // The CB-intake `Description` column should land in NL_Title_Short.
    expect(csv).toContain("Vrouwen die oorlog zien");
    expect(csv).toContain("Het gore lef");
    // And the EAN should come through (via `cb.ean` fallback in the mapping).
    expect(csv).toContain("9789083436999");
  });

  it("createRun throws UnknownInputFormatError when the header row matches no known format", async () => {
    const { createRun, UnknownInputFormatError } = await import("../../src/lib/runs");

    const csv = "foo,bar,baz\n1,2,3\n";
    await expect(createRun({ fileName: "weird.csv", content: csv })).rejects.toBeInstanceOf(
      UnknownInputFormatError,
    );
  });
});

describe("getRunDetail", () => {
  useTmpEnv();

  it("returns undefined for an unknown id", async () => {
    const { getRunDetail } = await import("../../src/lib/runs");
    expect(getRunDetail("does-not-exist")).toBeUndefined();
  });

  it("reports per-status book counts mid-run (no books processed yet)", async () => {
    const { createRun, getRunDetail } = await import("../../src/lib/runs");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    const detail = getRunDetail(runId);

    expect(detail?.bookStatusCounts).toEqual({
      pending: 2,
      enriching: 0,
      done: 0,
      failed: 0,
    });
    expect(detail?.recentErrors).toEqual([]);
  });

  it("samples enrichment errors from failed books for the polling UI", async () => {
    const { createRun, getRunDetail } = await import("../../src/lib/runs");
    const { getDb } = await import("../../src/lib/db/client");
    const { books } = await import("../../src/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });

    // Simulate one book finishing successfully and one failing with two
    // source errors. Updating the DB directly lets us exercise getRunDetail
    // without standing up real adapters.
    const db = getDb();
    const allBooks = db.select({ id: books.id, ean: books.ean }).from(books).all();
    const [first, second] = allBooks;
    if (!first || !second) throw new Error("expected the SAMPLE_CSV to produce 2 books");

    db.update(books).set({ status: "done" }).where(eq(books.id, first.id)).run();
    db.update(books)
      .set({
        status: "failed",
        errors: [
          { source: "google-books", message: "quota exceeded" },
          { source: "open-library", message: "timeout" },
        ],
      })
      .where(eq(books.id, second.id))
      .run();

    const detail = getRunDetail(runId);
    expect(detail?.bookStatusCounts).toEqual({
      pending: 0,
      enriching: 0,
      done: 1,
      failed: 1,
    });

    // The recentErrors list should flatten both per-source failures for the
    // one failed book, tagged with its EAN so the UI can show context.
    expect(detail?.recentErrors).toEqual([
      { ean: second.ean, source: "google-books", message: "quota exceeded" },
      { ean: second.ean, source: "open-library", message: "timeout" },
    ]);
  });
});

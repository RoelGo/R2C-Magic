import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

const SAMPLE_CSV = `"System ID","UPC","EAN","Custom SKU","Manufact. SKU","Item","Vendor ID","Qty.","Price","Tax","Brand","Publish to eCom","Season","Department","MSRP","Tax Class","Default Cost","Vendor","Category","Subcategory 1","Subcategory 2","Subcategory 3","Subcategory 4","Subcategory 5","Subcategory 6","Subcategory 7","Subcategory 8","Subcategory 9"
"210000000001","","9789462673359","","","Het begin van mijn leven was toen ik nog niet bestond","","0","€19.90","Yes","Fatima en Helen","No","","","19.90","Item","11.080000000","EPO","Boeken","Non-fictie","","","","","","","",""
`;

async function paramsOf(id: string) {
  return Promise.resolve({ id });
}

describe("GET /api/runs/[id]", () => {
  useTmpEnv();

  it("returns the run summary for a known id", async () => {
    const { createRun } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");
    const { GET } = await import("../../src/app/api/runs/[id]/route");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    await processRunInline(runId);

    const response = await GET(new Request(`http://localhost/api/runs/${runId}`), {
      params: paramsOf(runId),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe(runId);
    expect(body.status).toBe("completed");
    expect(body.totalBooks).toBe(1);
  });

  it("returns 404 for an unknown id", async () => {
    const { GET } = await import("../../src/app/api/runs/[id]/route");
    const response = await GET(new Request("http://localhost/api/runs/missing"), {
      params: paramsOf("missing"),
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/runs/[id]/export", () => {
  useTmpEnv();

  it("streams the export CSV with attachment headers", async () => {
    const { createRun } = await import("../../src/lib/runs");
    const { processRunInline } = await import("../../src/lib/jobs/run");
    const { GET } = await import("../../src/app/api/runs/[id]/export/route");

    const { runId } = await createRun({ fileName: "sample.csv", content: SAMPLE_CSV });
    await processRunInline(runId);

    const response = await GET(new Request(`http://localhost/api/runs/${runId}/export`), {
      params: paramsOf(runId),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/csv/);
    expect(response.headers.get("content-disposition")).toMatch(/attachment;\s*filename="r2c_/);
    const body = await response.text();
    expect(body).toContain("Visible;Brand"); // header row from mapping
    expect(body).toContain("9789462673359"); // EAN appears in the data row
  });

  it("returns 404 when the run is unknown", async () => {
    const { GET } = await import("../../src/app/api/runs/[id]/export/route");
    const response = await GET(new Request("http://localhost/api/runs/missing/export"), {
      params: paramsOf("missing"),
    });
    expect(response.status).toBe(404);
  });
});

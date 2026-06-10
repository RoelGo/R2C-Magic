"use server";

import { UnknownInputFormatError, createRun, processRunSync } from "@/lib/runs";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB, matches next.config bodySizeLimit

export interface UploadActionResult {
  ok: false;
  error: string;
}

/**
 * Server action: accept a multipart upload of a book CSV (R-Series export or
 * CB-intake template — format is detected from the header row), create a run,
 * process it synchronously (M1: no enrichment, just mapping), and redirect to
 * the run detail page. Returns a result object only on validation failure —
 * the happy path throws via `redirect()`.
 */
export async function uploadRunAction(formData: FormData): Promise<UploadActionResult | undefined> {
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return { ok: false, error: "No file uploaded." };
  }
  if (file.size === 0) {
    return { ok: false, error: "Uploaded file is empty." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`,
    };
  }

  const isCsv =
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.type === "application/octet-stream" ||
    file.type === "" ||
    file.name.toLowerCase().endsWith(".csv");
  if (!isCsv) {
    return { ok: false, error: `Unsupported file type: ${file.type || "unknown"}.` };
  }

  const content = await file.text();

  let runId: string;
  let totalBooks: number;
  try {
    const result = await createRun({ fileName: file.name, content });
    runId = result.runId;
    totalBooks = result.totalBooks;
  } catch (err) {
    if (err instanceof UnknownInputFormatError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  if (totalBooks === 0) {
    return {
      ok: false,
      error: "Could not find any valid books in the upload (every row failed validation).",
    };
  }

  await processRunSync(runId);

  revalidatePath("/");
  redirect(`/runs/${runId}`);
}

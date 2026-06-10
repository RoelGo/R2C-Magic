import { existsSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { getLatestExportPath, getRun } from "@/lib/runs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * Stream the latest C-Series export CSV for a run. We do not load the file
 * into memory — even with a few thousand books we want to stay tidy.
 */
export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const path = getLatestExportPath(id);
  if (!path || !existsSync(path)) {
    return NextResponse.json({ error: "no export available for this run" }, { status: 404 });
  }

  const stat = statSync(path);
  const nodeStream = createReadStream(path);
  // Cast to a web ReadableStream so Next's Response can consume it.
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

  const downloadName = buildDownloadName(run.sourceFileName);
  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${downloadName}"`,
      "Cache-Control": "no-store",
    },
  });
}

function buildDownloadName(sourceFileName: string): string {
  const base = sourceFileName.replace(/\.csv$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safe = base.length > 0 ? base : "export";
  return `r2c_${safe}.csv`;
}

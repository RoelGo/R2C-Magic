import { getRunDetail } from "@/lib/runs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * Live run state for the run-page poller. Returns the run summary plus
 * per-status book counts and a small sample of recent enrichment errors so
 * the client can render an informative progress UI.
 */
export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const detail = getRunDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  return NextResponse.json(detail);
}

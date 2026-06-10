import { getRun } from "@/lib/runs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}

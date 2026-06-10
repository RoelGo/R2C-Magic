import { RunProgress } from "@/components/run-progress";
import { getRunDetail } from "@/lib/runs";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const FORMAT_LABEL: Record<string, string> = {
  "r-series": "R-Series export",
  "cb-intake": "CB intake template",
};

export default async function RunDetailPage({ params }: Props) {
  const { id } = await params;
  const run = getRunDetail(id);
  if (!run) notFound();

  const canDownload = run.exportCount > 0 && run.status === "completed";

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/" className="text-blue-600 hover:underline dark:text-blue-400">
          ← All runs
        </Link>
      </nav>

      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Run {run.id}</h2>
          <p className="mt-1 font-mono text-sm text-slate-600 dark:text-slate-400">
            {run.sourceFileName}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${STATUS_STYLES[run.status] ?? STATUS_STYLES.pending}`}
        >
          {run.status}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Format" value={FORMAT_LABEL[run.format] ?? run.format} />
        <Stat label="Books" value={String(run.totalBooks)} />
        <Stat label="Processed" value={`${run.processedBooks} / ${run.totalBooks}`} />
        <Stat label="Failed" value={String(run.failedBooks)} />
      </dl>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Uploaded{" "}
        {new Date(run.uploadedAt).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </p>

      {/*
       * The progress component renders for every run (the bar is useful as
       * a static summary post-hoc) but only polls while status is
       * pending/running, and triggers `router.refresh()` on completion so
       * the download section below swaps in without a manual reload.
       */}
      <RunProgress runId={run.id} initial={run} />

      <section className="space-y-3 rounded-lg border border-slate-200 p-6 dark:border-slate-800">
        <h3 className="text-lg font-semibold">C-Series export</h3>
        {canDownload ? (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              The C-Series import CSV for this run is ready. Drop it into Lightspeed C-Series.
            </p>
            <a
              href={`/api/runs/${run.id}/export`}
              className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              download
            >
              Download CSV
            </a>
          </>
        ) : run.status === "failed" ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            This run failed before any export was produced. Check the server logs and re-upload.
          </p>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The export will appear here as soon as every book finishes enriching.
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-800">
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

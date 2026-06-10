import { RunTable } from "@/components/run-table";
import { UploadDropzone } from "@/components/upload-dropzone";
import { listRuns } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default function Home() {
  const runs = listRuns();
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <header>
          <h2 className="text-2xl font-semibold">Upload an R-Series export</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            R2C Magic parses your CSV, applies the mapping, and produces a C-Series-ready import
            file. Enrichment against online sources lands in milestone M2 — for now every enriched
            column is blank and only R-Series fields are populated.
          </p>
        </header>
        <UploadDropzone />
      </section>

      <section className="space-y-3">
        <header className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Recent runs</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Most recent first</p>
        </header>
        <RunTable runs={runs} />
      </section>
    </div>
  );
}

import type { RunSummary } from "@/lib/runs";

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

const STATUS_STYLES: Record<RunSummary["status"], string> = {
  pending: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export function RunTable({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No runs yet. Upload an R-Series CSV above to create the first one.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            <th className="px-4 py-2 font-medium">Uploaded</th>
            <th className="px-4 py-2 font-medium">File</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium text-right">Books</th>
            <th className="px-4 py-2 font-medium text-right">Failed</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                {new Date(r.uploadedAt).toLocaleString(undefined, DATE_FORMAT)}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">
                {r.sourceFileName}
              </td>
              <td className="px-4 py-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status]}`}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {r.processedBooks} / {r.totalBooks}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{r.failedBooks}</td>
              <td className="px-4 py-2 text-right">
                <a
                  href={`/runs/${r.id}`}
                  className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  View
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

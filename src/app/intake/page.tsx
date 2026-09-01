import { listSessions } from "@/lib/intake";
import Link from "next/link";
import { startIntakeSessionAction } from "./actions";

export const dynamic = "force-dynamic";

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

export default function IntakePage() {
  const sessions = listSessions();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <header>
          <h2 className="text-2xl font-semibold">New arrivals</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Add newly delivered books to the webshop one at a time: scan, snap a couple of photos,
            confirm the pre-filled details, and push to Lightspeed Retail. Start a session below.
          </p>
        </header>

        <p className="text-sm">
          <Link
            href="/settings/lightspeed"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Lightspeed connection settings →
          </Link>
        </p>

        <form action={startIntakeSessionAction} className="space-y-3">
          <div className="space-y-1">
            <label
              htmlFor="label"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              Session label (optional)
            </label>
            <input
              id="label"
              name="label"
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="e.g. CB delivery — 29 Aug"
              className="w-full rounded-md border border-slate-300 px-3 py-3 text-base dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700"
          >
            Start intake session
          </button>
        </form>
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Recent sessions</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No sessions yet. Start one above to begin adding books.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/intake/${s.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {s.label ?? "Untitled session"}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {new Date(s.startedAt).toLocaleString(undefined, DATE_FORMAT)} · {s.bookCount}{" "}
                      {s.bookCount === 1 ? "book" : "books"}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.status === "active"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {s.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

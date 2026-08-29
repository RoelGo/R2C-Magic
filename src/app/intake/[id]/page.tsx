import type { IntakeBookStatus } from "@/lib/intake";
import { getSessionDetail } from "@/lib/intake";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addIntakeBookAction } from "../actions";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

const BOOK_STATUS_STYLES: Record<IntakeBookStatus, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  pushed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export default async function IntakeSessionPage({ params }: Props) {
  const { id } = await params;
  const session = getSessionDetail(id);
  if (!session) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/intake" className="text-blue-600 hover:underline dark:text-blue-400">
          ← All sessions
        </Link>
      </nav>

      <header className="space-y-1">
        <h2 className="text-2xl font-semibold">{session.label ?? "Untitled session"}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {session.bookCount} {session.bookCount === 1 ? "book" : "books"} added
        </p>
      </header>

      <form action={addIntakeBookAction}>
        <input type="hidden" name="sessionId" value={session.id} />
        <button
          type="submit"
          className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700"
        >
          + Add a book
        </button>
      </form>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Books in this session</h3>
        {session.books.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No books yet. Tap “Add a book” to scan the first one.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {session.books.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/intake/${session.id}/books/${b.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {b.title ?? (b.ean ? `EAN ${b.ean}` : "Untitled book")}
                    </span>
                    {b.ean && b.title ? (
                      <span className="block font-mono text-xs text-slate-500 dark:text-slate-400">
                        {b.ean}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BOOK_STATUS_STYLES[b.status]}`}
                  >
                    {b.status}
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

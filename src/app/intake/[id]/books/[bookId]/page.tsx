import { getIntakeBook } from "@/lib/intake";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string; bookId: string }>;
}

/**
 * Per-book screen. In Slice A this is a placeholder that confirms the book was
 * created and links back to the session. Slices B–F replace the body with the
 * scan → photos → review → push flow.
 */
export default async function IntakeBookPage({ params }: Props) {
  const { id, bookId } = await params;
  const book = getIntakeBook(id, bookId);
  if (!book) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href={`/intake/${id}`} className="text-blue-600 hover:underline dark:text-blue-400">
          ← Back to session
        </Link>
      </nav>

      <header className="space-y-1">
        <h2 className="text-2xl font-semibold">
          {book.title ?? (book.ean ? `EAN ${book.ean}` : "New book")}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Status: <span className="font-medium">{book.status}</span>
        </p>
      </header>

      <div className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        The scan → photograph → review → push flow lands in the next slices. This book is saved as a
        draft in the session, so nothing is lost.
      </div>
    </div>
  );
}

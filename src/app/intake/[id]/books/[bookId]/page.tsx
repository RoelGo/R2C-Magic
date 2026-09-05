import { CoverStep } from "@/components/cover-step";
import { EanCapture } from "@/components/ean-capture";
import { EnrichmentStatus } from "@/components/enrichment-status";
import { PushStep } from "@/components/push-step";
import { ReviewForm } from "@/components/review-form";
import { getIntakeBook } from "@/lib/intake";
import { listIntakeImages } from "@/lib/intake/images";
import { buildReviewModel } from "@/lib/intake/review";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string; bookId: string }>;
}

/**
 * Per-book screen. Slice B captures the EAN (scan or manual). Photos, review,
 * and eCom push (Slices D–F) will render below the capture step once built.
 */
export default async function IntakeBookPage({ params }: Props) {
  const { id, bookId } = await params;
  const book = getIntakeBook(id, bookId);
  if (!book) notFound();

  const images = listIntakeImages(id, bookId);
  const captured = {
    front: images.some((i) => i.kind === "front"),
    back: images.some((i) => i.kind === "back"),
  };

  const reviewModel = buildReviewModel(id, bookId);

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

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">1. Barcode</h3>
        <EanCapture sessionId={id} bookId={bookId} initialEan={book.ean} />
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">2. Online lookup</h3>
        <EnrichmentStatus sessionId={id} bookId={bookId} hasEan={Boolean(book.ean)} />
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">3. Cover photos</h3>
        <CoverStep sessionId={id} bookId={bookId} captured={captured} />
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">4. Review</h3>
        {reviewModel ? (
          <ReviewForm
            sessionId={id}
            bookId={bookId}
            model={{ ...reviewModel, hasFrontImage: captured.front }}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">5. Push to webshop</h3>
        <PushStep
          sessionId={id}
          bookId={bookId}
          status={book.status}
          reviewed={Boolean(book.reviewedTitle?.trim())}
          pushError={book.pushError}
        />
      </section>
    </div>
  );
}

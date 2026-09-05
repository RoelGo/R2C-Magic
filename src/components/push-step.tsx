"use client";

import { pushIntakeBookAction } from "@/app/intake/actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

interface PushStepProps {
  sessionId: string;
  bookId: string;
  /** Current push lifecycle status of the book. */
  status: "draft" | "pushed" | "failed";
  /** Whether the review has been confirmed (a reviewed title exists). */
  reviewed: boolean;
  /** Last push failure message, if any. */
  pushError: string | null;
}

/**
 * Push-to-webshop step (spec v2 Slice F, US-F1/F3).
 *
 * Submits the confirmed book to Lightspeed Retail via the server action. Shows
 * a clear success confirmation with a prominent "Scan next book" path, or a
 * retryable error. Disabled until the review is confirmed (US-E3 gate).
 */
export function PushStep({ sessionId, bookId, status, reviewed, pushError }: PushStepProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(status === "failed" ? pushError : null);
  const [pushed, setPushed] = useState(status === "pushed");

  function push() {
    setError(null);
    startTransition(async () => {
      const result = await pushIntakeBookAction(sessionId, bookId);
      if (result.ok) {
        setPushed(true);
        router.refresh();
      } else {
        setError(result.error);
        router.refresh();
      }
    });
  }

  function nextBook() {
    startTransition(async () => {
      const { addIntakeBookAction } = await import("@/app/intake/actions");
      const form = new FormData();
      form.set("sessionId", sessionId);
      await addIntakeBookAction(form);
    });
  }

  if (pushed) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-emerald-50 px-3 py-3 text-sm font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          Added to the webshop.
        </p>
        <button
          type="button"
          onClick={nextBook}
          disabled={isPending}
          className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isPending ? "Opening…" : "Scan next book"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!reviewed ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          Confirm the review above before pushing to the webshop.
        </p>
      ) : null}

      <button
        type="button"
        onClick={push}
        disabled={!reviewed || isPending}
        className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Pushing…" : error ? "Retry push" : "Submit to webshop"}
      </button>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

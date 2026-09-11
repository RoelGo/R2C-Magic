"use client";

import { pushIntakeBookAction } from "@/app/intake/actions";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

type RetailLookupStatus = "idle" | "checking" | "found" | "missing" | "error";

interface PushStepProps {
  sessionId: string;
  bookId: string;
  /** Current push lifecycle status of the book. */
  status: "draft" | "pushed" | "failed";
  /** Whether the review has been confirmed (a reviewed title exists). */
  reviewed: boolean;
  /** Last push failure message, if any. */
  pushError: string | null;
  /** Live Retail lookup outcome for the captured EAN (US-B3). */
  retailLookupStatus: RetailLookupStatus;
  /** Reason the Retail lookup could not complete, if any. */
  retailLookupError: string | null;
}

/**
 * Push-to-webshop step (spec v2 Slice F, US-F1/F3 + US-B3 gating).
 *
 * Submits the confirmed book to Lightspeed Retail via the server action. The
 * live Retail lookup (run on EAN capture) gates the button:
 *   - `found`   → the item exists; submit updates it.
 *   - `missing` → submit is disabled unless the worker ticks "create on submit".
 *   - `error`   → not connected / API error; submit is disabled with a hint.
 *   - `checking`/`idle` → still resolving / no EAN yet.
 * On success it shows a confirmation with a prominent "Scan next book" path.
 */
export function PushStep({
  sessionId,
  bookId,
  status,
  reviewed,
  pushError,
  retailLookupStatus,
  retailLookupError,
}: PushStepProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(status === "failed" ? pushError : null);
  const [pushed, setPushed] = useState(status === "pushed");
  const [createIfMissing, setCreateIfMissing] = useState(false);
  // Synchronous guard against a double-dispatch of the push action (WI-1).
  const submitting = useRef(false);

  const missing = retailLookupStatus === "missing";
  const lookupBlocks = retailLookupStatus === "error" || retailLookupStatus === "checking";
  // Submit is allowed when the review is confirmed AND either the item exists,
  // or it's missing and the worker opted to create it. A lookup error / an
  // in-flight check blocks until it resolves.
  const canSubmit =
    reviewed && !lookupBlocks && (retailLookupStatus === "found" || (missing && createIfMissing));

  function push() {
    // WI-1: `isPending` only flips on the next render, so two quick taps on a
    // phone both get past `disabled` and dispatch the action twice — which
    // uploads the cover photos twice. This ref is a synchronous latch.
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await pushIntakeBookAction(sessionId, bookId, {
          createIfMissing: missing && createIfMissing,
        });
        if (result.ok) setPushed(true);
        else setError(result.error);
        router.refresh();
      } finally {
        submitting.current = false;
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

      <RetailLookupNotice status={retailLookupStatus} error={retailLookupError} />

      {missing ? (
        <label className="flex items-start gap-2 rounded-md border border-slate-300 px-3 py-3 text-sm dark:border-slate-700">
          <input
            type="checkbox"
            checked={createIfMissing}
            onChange={(e) => setCreateIfMissing(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">Create this book in Retail on submit</span>
            <span className="block text-slate-600 dark:text-slate-400">
              It isn&apos;t in Retail yet. Tick this to create a new item from the confirmed
              details.
            </span>
          </span>
        </label>
      ) : null}

      <button
        type="button"
        onClick={push}
        disabled={!canSubmit || isPending}
        className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending
          ? missing && createIfMissing
            ? "Creating…"
            : "Pushing…"
          : error
            ? "Retry push"
            : missing && createIfMissing
              ? "Create in webshop"
              : "Submit to webshop"}
      </button>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Inline banner describing the live Retail lookup outcome for this book. */
function RetailLookupNotice({
  status,
  error,
}: {
  status: RetailLookupStatus;
  error: string | null;
}) {
  if (status === "found") {
    return (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
        Found in Retail — submitting will update the existing item.
      </p>
    );
  }
  if (status === "missing") {
    return (
      <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
        Not found in Retail for this EAN.
      </p>
    );
  }
  if (status === "checking") {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">Checking Retail for this EAN…</p>
    );
  }
  if (status === "error") {
    return (
      <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
        {error ?? "Could not check Retail for this EAN."}
      </p>
    );
  }
  // idle: no EAN captured yet.
  return (
    <p className="text-sm text-slate-600 dark:text-slate-400">
      Capture the barcode above to check Retail.
    </p>
  );
}

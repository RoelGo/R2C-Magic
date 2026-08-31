"use client";

import type { IntakeOcrSnapshot } from "@/lib/intake/ocr";
import { useEffect, useRef, useState } from "react";

interface OcrStatusProps {
  sessionId: string;
  bookId: string;
  /** Whether any cover photo exists; without one there is nothing to OCR. */
  hasPhoto: boolean;
  /**
   * Bumped by the photo capture UI whenever a cover is (re)taken, so OCR
   * re-polls the freshly-triggered run.
   */
  photoVersion: number;
}

const POLL_MS = 2000;
const TERMINAL = new Set(["done", "empty", "failed"]);

/**
 * Non-blocking cover-OCR indicator (spec v2 US-D3/D4). Polls the OCR endpoint
 * while an engine is processing and renders the extracted title/author/
 * description as they arrive, or a clear "no text read" when empty. Purely
 * informational until the review form (Slice E) lets the worker adopt them.
 */
export function OcrStatus({ sessionId, bookId, hasPhoto, photoVersion }: OcrStatusProps) {
  const [snapshot, setSnapshot] = useState<IntakeOcrSnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasPhoto) return;
    let cancelled = false;

    // A newly captured photo (photoVersion bump) kicks off a fresh server-side
    // run; reset to the in-flight state so we don't show stale suggestions.
    if (photoVersion > 0) setSnapshot(null);

    async function poll() {
      try {
        const res = await fetch(`/api/intake/${sessionId}/books/${bookId}/ocr`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as IntakeOcrSnapshot;
        if (cancelled) return;
        setSnapshot(data);
        if (!TERMINAL.has(data.status)) {
          timerRef.current = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (!cancelled) timerRef.current = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, bookId, hasPhoto, photoVersion]);

  if (!hasPhoto) return null;

  const status = snapshot?.status ?? "running";
  const s = snapshot?.suggestions;

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <span className="text-sm font-medium">{statusLabel(status)}</span>
        </div>
        {snapshot?.engine ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {snapshot.engine}
          </span>
        ) : null}
      </div>

      {s && status === "done" ? (
        <dl className="mt-3 space-y-2 text-sm">
          <Suggestion label="Title (cover)" value={s.title} />
          <Suggestion label="Author (cover)" value={s.author} />
          <Suggestion
            label="Description (back)"
            value={s.description ? truncate(s.description, 200) : undefined}
          />
        </dl>
      ) : null}

      {status === "empty" ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No text read from the cover. You can type the details in the review step.
        </p>
      ) : null}

      {status === "failed" ? (
        <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
          OCR could not process the photo. You can retake it or enter details manually.
        </p>
      ) : null}
    </div>
  );
}

function Suggestion({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-800 dark:text-slate-200">{value}</dd>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "done"
      ? "bg-emerald-500"
      : status === "empty"
        ? "bg-slate-400"
        : status === "failed"
          ? "bg-amber-500"
          : "bg-blue-500 animate-pulse";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function statusLabel(status: string): string {
  switch (status) {
    case "running":
      return "Reading the cover…";
    case "done":
      return "Text read from cover";
    case "empty":
      return "No text read";
    case "failed":
      return "OCR failed (you can still continue)";
    default:
      return "Waiting…";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

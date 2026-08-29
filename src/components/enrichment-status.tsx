"use client";

import type { IntakeEnrichmentSnapshot } from "@/lib/intake/enrichment";
import { useEffect, useRef, useState } from "react";

interface EnrichmentStatusProps {
  sessionId: string;
  bookId: string;
  /** Whether an EAN is present; without one there is nothing to look up. */
  hasEan: boolean;
}

const POLL_MS = 2000;
const TERMINAL = new Set(["done", "empty", "failed"]);

/**
 * Non-blocking online-enrichment indicator (spec v2 US-C2). Polls the intake
 * enrichment endpoint while a lookup is in flight and renders the suggested
 * values as they arrive, or a clear "no online match" when empty. The worker
 * is never forced to wait on this — it is purely informational until the
 * review form (Slice E) lets them adopt these suggestions.
 */
export function EnrichmentStatus({ sessionId, bookId, hasEan }: EnrichmentStatusProps) {
  const [snapshot, setSnapshot] = useState<IntakeEnrichmentSnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!hasEan) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/intake/${sessionId}/books/${bookId}/enrichment`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as IntakeEnrichmentSnapshot;
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
  }, [sessionId, bookId, hasEan]);

  if (!hasEan) return null;

  const status = snapshot?.status ?? "searching";
  const s = snapshot?.suggestions;

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="text-sm font-medium">{statusLabel(status)}</span>
      </div>

      {s && (status === "done" || status === "empty") ? (
        <dl className="mt-3 space-y-2 text-sm">
          <Suggestion label="Title" value={s.title} />
          <Suggestion label="Author" value={s.authors?.join(", ")} />
          <Suggestion label="Publisher" value={s.publisher} />
          <Suggestion
            label="Description"
            value={s.descriptionShort ? truncate(s.descriptionShort, 160) : undefined}
          />
          {s.coverImageUrl ? (
            <div className="flex items-center gap-3 pt-1">
              <img
                src={s.coverImageUrl}
                alt="Suggested cover"
                className="h-16 w-auto rounded border border-slate-200 dark:border-slate-700"
              />
              <span className="text-xs text-slate-500 dark:text-slate-400">Cover found online</span>
            </div>
          ) : null}
        </dl>
      ) : null}

      {status === "empty" && !hasAnySuggestion(s) ? (
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          No online match. You can still add the book from the cover photos and manual entry.
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
          ? "bg-red-500"
          : "bg-blue-500 animate-pulse";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function statusLabel(status: string): string {
  switch (status) {
    case "searching":
      return "Searching online…";
    case "done":
      return "Online match found";
    case "empty":
      return "No online match";
    case "failed":
      return "Online lookup failed (you can still continue)";
    default:
      return "Waiting…";
  }
}

function hasAnySuggestion(s?: IntakeEnrichmentSnapshot["suggestions"]): boolean {
  return Boolean(
    s && (s.title || s.authors?.length || s.publisher || s.descriptionShort || s.coverImageUrl),
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

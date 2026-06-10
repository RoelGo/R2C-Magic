"use client";

import type { RunDetail } from "@/lib/runs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 1000;

/** Statuses that mean "more updates are coming". */
const ACTIVE_STATUSES = new Set<RunDetail["status"]>(["pending", "running"]);

interface Props {
  runId: string;
  initial: RunDetail;
}

/**
 * Client-side run page body. Polls `GET /api/runs/[id]` once per second
 * while the run is still pending/running. On terminal state it stops
 * polling and calls `router.refresh()` once so the server-rendered shell
 * re-renders with the up-to-date `canDownload` view + a fresh export link.
 *
 * We render the same progress UI from initial server data, so the page is
 * useful instantly even before the first poll lands.
 */
export function RunProgress({ runId, initial }: Props) {
  const router = useRouter();
  const [detail, setDetail] = useState<RunDetail>(initial);

  // `useRef` instead of state for the "did we already refresh?" flag — we
  // don't want toggling it to cause another render.
  const hasRefreshedRef = useRef(false);

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(detail.status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) {
          // Don't crash the UI on a transient 5xx — just back off and retry.
          if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS * 3);
          return;
        }
        const next = (await res.json()) as RunDetail;
        if (cancelled) return;
        setDetail(next);
        if (ACTIVE_STATUSES.has(next.status)) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        } else if (!hasRefreshedRef.current) {
          // Terminal state. Pull the full server view in so the download
          // link / failure message swaps in without the user reloading.
          hasRefreshedRef.current = true;
          router.refresh();
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS * 3);
      }
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, detail.status, router]);

  const total = detail.totalBooks;
  const counts = detail.bookStatusCounts;
  const done = counts.done;
  const failed = counts.failed;
  const enriching = counts.enriching;
  const pending = counts.pending;
  const completedCount = done + failed;
  const percent = total === 0 ? 100 : Math.round((completedCount / total) * 100);
  const isActive = ACTIVE_STATUSES.has(detail.status);

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 p-6 dark:border-slate-800">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-lg font-semibold">Enrichment progress</h3>
        <span className="text-sm tabular-nums text-slate-600 dark:text-slate-400">
          {completedCount} / {total} books ({percent}%)
        </span>
      </div>

      <ProgressBar
        total={total}
        done={done}
        failed={failed}
        enriching={enriching}
        pending={pending}
      />

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <CountStat label="Done" value={done} tone="emerald" />
        <CountStat label="Enriching" value={enriching} tone={isActive ? "blue-pulse" : "slate"} />
        <CountStat label="Pending" value={pending} tone="slate" />
        <CountStat label="Failed" value={failed} tone={failed > 0 ? "red" : "slate"} />
      </dl>

      {detail.recentErrors.length > 0 ? (
        <details className="rounded-md border border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-300">
            Recent errors ({detail.recentErrors.length})
          </summary>
          <ul className="max-h-64 divide-y divide-slate-200 overflow-y-auto text-sm dark:divide-slate-800">
            {detail.recentErrors.map((e, i) => (
              <li
                // EAN + source uniquely identifies an attempt; index disambiguates if a
                // book somehow has two errors from the same source (e.g. retry chain).
                key={`${e.ean}-${e.source}-${i}`}
                className="px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                    {e.ean}
                  </span>
                  <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {e.source}
                  </span>
                </div>
                <p className="mt-1 text-slate-700 dark:text-slate-300">{e.message}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

interface ProgressBarProps {
  total: number;
  done: number;
  failed: number;
  enriching: number;
  pending: number;
}

function ProgressBar({ total, done, failed, enriching, pending }: ProgressBarProps) {
  if (total === 0) {
    return (
      <div className="h-3 w-full rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
    );
  }
  const donePct = (done / total) * 100;
  const failedPct = (failed / total) * 100;
  const enrichingPct = (enriching / total) * 100;
  const pendingPct = (pending / total) * 100;
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
      role="progressbar"
      // The progress bar is informative (announces "12 of 50 books, 24%")
      // so it's worth a keyboard tab stop while a run is active.
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done + failed}
      aria-label="Enrichment progress"
    >
      <div className="bg-emerald-500 transition-[width]" style={{ width: `${donePct}%` }} />
      <div className="bg-red-500 transition-[width]" style={{ width: `${failedPct}%` }} />
      <div
        className="animate-pulse bg-blue-500 transition-[width]"
        style={{ width: `${enrichingPct}%` }}
      />
      <div className="bg-transparent" style={{ width: `${pendingPct}%` }} />
    </div>
  );
}

type Tone = "emerald" | "red" | "blue-pulse" | "slate";

function CountStat({ label, value, tone }: { label: string; value: number; tone: Tone }) {
  const toneClasses: Record<Tone, string> = {
    emerald: "text-emerald-700 dark:text-emerald-300",
    red: "text-red-700 dark:text-red-300",
    "blue-pulse": "text-blue-700 dark:text-blue-300 animate-pulse",
    slate: "text-slate-700 dark:text-slate-300",
  };
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800">
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${toneClasses[tone]}`}>{value}</dd>
    </div>
  );
}

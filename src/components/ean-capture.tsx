"use client";

import { setBookEanAction } from "@/app/intake/actions";
import { BarcodeScanner } from "@/components/barcode-scanner";
import { cleanEan, isValidEan13 } from "@/lib/intake/ean";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

interface EanCaptureProps {
  sessionId: string;
  bookId: string;
  /** EAN already stored on the book, if any (re-open / after capture). */
  initialEan: string | null;
}

/**
 * EAN capture step for an intake book (spec v2 US-B1 scan, US-B2 manual).
 *
 * Offers a camera scan and a manual numeric entry that share a single
 * confirmation + save path. Validation (length + EAN-13 check digit) runs
 * client-side for instant inline feedback and again server-side in
 * `setBookEanAction` (the authoritative boundary).
 */
export function EanCapture({ sessionId, bookId, initialEan }: EanCaptureProps) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [value, setValue] = useState(initialEan ?? "");
  const [savedEan, setSavedEan] = useState<string | null>(initialEan);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cleaned = cleanEan(value);
  const looksValid = isValidEan13(cleaned);

  function save(rawEan: string) {
    setError(null);
    startTransition(async () => {
      const result = await setBookEanAction(sessionId, bookId, rawEan);
      if (result.ok) {
        setSavedEan(result.ean);
        setValue(result.ean);
        setManual(false);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  function handleDetected(rawValue: string) {
    setScanning(false);
    const digits = cleanEan(rawValue);
    setValue(digits);
    if (isValidEan13(digits)) {
      save(digits);
    } else {
      setManual(true);
      setError("Scanned code is not a valid EAN-13. Check the number and confirm.");
    }
  }

  if (scanning) {
    return (
      <BarcodeScanner
        onDetected={handleDetected}
        onCancel={() => {
          setScanning(false);
          setManual(true);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {savedEan ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
          <p className="text-sm text-emerald-700 dark:text-emerald-300">Barcode captured</p>
          <p className="mt-1 font-mono text-lg font-semibold">{savedEan}</p>
        </div>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Scan the book&apos;s barcode, or enter the EAN/ISBN manually.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setScanning(true);
          }}
          className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700"
        >
          {savedEan ? "Rescan barcode" : "Scan barcode"}
        </button>

        {!manual ? (
          <button
            type="button"
            onClick={() => {
              setManual(true);
              setError(null);
            }}
            className="w-full rounded-md border border-slate-300 px-4 py-3 text-base font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            Enter manually
          </button>
        ) : (
          <div className="space-y-2">
            <label
              htmlFor="ean"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300"
            >
              EAN / ISBN-13
            </label>
            <input
              id="ean"
              name="ean"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder="9789462673359"
              className="w-full rounded-md border border-slate-300 px-3 py-3 font-mono text-base tracking-wide dark:border-slate-700 dark:bg-slate-900"
            />
            {cleaned.length > 0 && !looksValid ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Not a valid EAN-13 yet ({cleaned.length}/13 digits, check digit must match).
              </p>
            ) : null}
            <button
              type="button"
              disabled={!looksValid || isPending}
              onClick={() => save(cleaned)}
              className="w-full rounded-md bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? "Saving…" : "Confirm EAN"}
            </button>
          </div>
        )}
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

interface CoverPhotosProps {
  sessionId: string;
  bookId: string;
  /** Which covers already have a stored photo, from the server. */
  captured: { front: boolean; back: boolean };
  /** Notified after each successful upload so a sibling (OCR) can re-poll. */
  onUploaded?: () => void;
}

type Kind = "front" | "back";

/**
 * Front + back cover photo capture for an intake book (spec v2 US-D1/US-D2).
 *
 * Uses the native OS camera via a hidden `<input capture="environment">`:
 * tapping a slot opens the phone's camera app (with its own focus/flash/retake
 * UX), and the returned file is uploaded to the images route. The backend,
 * table, and validation are unchanged. OCR is a separate slice.
 */
export function CoverPhotos({ sessionId, bookId, captured, onUploaded }: CoverPhotosProps) {
  const router = useRouter();
  const [uploading, setUploading] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cache-buster so a retake's <img> re-fetches instead of showing the old one.
  const [version, setVersion] = useState(0);

  const inputRefs: Record<Kind, React.RefObject<HTMLInputElement | null>> = {
    front: useRef<HTMLInputElement>(null),
    back: useRef<HTMLInputElement>(null),
  };

  async function upload(kind: Kind, file: File) {
    setUploading(kind);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file, `${kind}.jpg`);
      const res = await fetch(`/api/intake/${sessionId}/books/${bookId}/images/${kind}`, {
        method: "POST",
        body,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Upload failed");
      }
      setVersion((v) => v + 1);
      onUploaded?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
    }
  }

  function handleFile(kind: Kind, event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so picking the same file again (or a retake) still fires onChange.
    event.target.value = "";
    if (file) upload(kind, file);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {(["front", "back"] as const).map((kind) => (
          <CoverSlot
            key={kind}
            kind={kind}
            hasPhoto={captured[kind]}
            uploading={uploading === kind}
            version={version}
            src={`/api/intake/${sessionId}/books/${bookId}/images/${kind}`}
            onTake={() => {
              setError(null);
              inputRefs[kind].current?.click();
            }}
          />
        ))}
      </div>

      {/* Hidden native-camera inputs, one per slot. `capture="environment"`
          asks phones for the rear camera; desktops fall back to a file
          picker. */}
      {(["front", "back"] as const).map((kind) => (
        <input
          key={kind}
          ref={inputRefs[kind]}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => handleFile(kind, e)}
        />
      ))}

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface CoverSlotProps {
  kind: Kind;
  hasPhoto: boolean;
  uploading: boolean;
  version: number;
  src: string;
  onTake: () => void;
}

function CoverSlot({ kind, hasPhoto, uploading, version, src, onTake }: CoverSlotProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium capitalize text-slate-700 dark:text-slate-300">
        {kind} cover
      </span>
      <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
        {hasPhoto ? (
          <img
            src={`${src}?v=${version}`}
            alt={`${kind} cover`}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="px-2 text-center text-xs text-slate-400">No photo yet</span>
        )}
        {uploading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
            Uploading…
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onTake}
        disabled={uploading}
        className="w-full rounded-md bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {hasPhoto ? "Retake" : `Take ${kind} photo`}
      </button>
    </div>
  );
}

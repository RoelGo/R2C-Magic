"use client";

import { CameraCapture } from "@/components/camera-capture";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface CoverPhotosProps {
  sessionId: string;
  bookId: string;
  /** Which covers already have a stored photo, from the server. */
  captured: { front: boolean; back: boolean };
}

type Kind = "front" | "back";

const KIND_LABEL: Record<Kind, string> = {
  front: "front cover",
  back: "back cover",
};

/**
 * Front + back cover photo capture for an intake book (spec v2 US-D1/US-D2).
 *
 * Each slot shows the currently stored photo (served from the API) or a
 * "take photo" prompt. Capturing opens the live camera, then uploads the
 * JPEG to the images route; on success we refresh so the stored preview and
 * the review form (later slice) see the new photo. OCR is a separate slice.
 */
export function CoverPhotos({ sessionId, bookId, captured }: CoverPhotosProps) {
  const router = useRouter();
  const [activeKind, setActiveKind] = useState<Kind | null>(null);
  const [uploading, setUploading] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cache-buster so a retake's <img> re-fetches instead of showing the old one.
  const [version, setVersion] = useState(0);

  async function handleCapture(kind: Kind, blob: Blob) {
    setActiveKind(null);
    setUploading(kind);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", blob, `${kind}.jpg`);
      const res = await fetch(`/api/intake/${sessionId}/books/${bookId}/images/${kind}`, {
        method: "POST",
        body,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Upload failed");
      }
      setVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
    }
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
              setActiveKind(kind);
            }}
          />
        ))}
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {activeKind ? (
        <CameraCapture
          label={KIND_LABEL[activeKind]}
          onCapture={(blob) => handleCapture(activeKind, blob)}
          onCancel={() => setActiveKind(null)}
        />
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

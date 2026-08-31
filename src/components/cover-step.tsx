"use client";

import { CoverPhotos } from "@/components/cover-photos";
import { OcrStatus } from "@/components/ocr-status";
import { useState } from "react";

interface CoverStepProps {
  sessionId: string;
  bookId: string;
  captured: { front: boolean; back: boolean };
}

/**
 * Client wrapper that pairs the cover-photo capture (US-D1/D2) with the live
 * OCR indicator (US-D3/D4). It owns a shared `version` counter so a retake both
 * cache-busts the photo preview and re-triggers OCR polling, without either
 * child needing to know about the other.
 */
export function CoverStep({ sessionId, bookId, captured }: CoverStepProps) {
  const [version, setVersion] = useState(0);
  const hasPhoto = captured.front || captured.back;

  return (
    <div className="space-y-4">
      <CoverPhotos
        sessionId={sessionId}
        bookId={bookId}
        captured={captured}
        onUploaded={() => setVersion((v) => v + 1)}
      />
      <OcrStatus sessionId={sessionId} bookId={bookId} hasPhoto={hasPhoto} photoVersion={version} />
    </div>
  );
}

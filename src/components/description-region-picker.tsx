"use client";

import { type BackCoverRegions, joinRegions } from "@/lib/ocr/description";
import { useState } from "react";

interface DescriptionRegionPickerProps {
  sessionId: string;
  bookId: string;
  regions: BackCoverRegions;
  /** The description currently in the form, used to pre-select regions. */
  currentValue: string;
  /** Called with the composed text when the worker confirms the selection. */
  onSave: (description: string) => void;
  onCancel: () => void;
}

/**
 * Tap-to-select description regions on the back cover (spec v2 US-D8).
 *
 * The layout pass (US-D7) already detected paragraph regions with boxes, so we
 * draw them as tappable overlays on the stored back-cover photo. Tapping
 * toggles a region; "Save as description" concatenates the selected regions in
 * top-to-bottom reading order into the description field, which stays editable.
 *
 * Boxes are in source-image pixels, so they are converted to percentages of the
 * image dimensions — that keeps them correct at any displayed size without
 * measuring the rendered element. Mobile-first: the overlays are full-size tap
 * targets and the actions are large buttons below the image.
 */
export function DescriptionRegionPicker({
  sessionId,
  bookId,
  regions,
  currentValue,
  onSave,
  onCancel,
}: DescriptionRegionPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(() =>
    initialSelection(regions, currentValue),
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const preview = joinRegions(regions.regions, [...selected]);

  return (
    <div className="space-y-3 rounded-md border border-slate-300 p-3 dark:border-slate-700">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Tap the paragraphs you want in the description.
      </p>

      <div className="relative w-full select-none">
        {/* Plain <img>: the photo is served from a dynamic API route, as in CoverPhotos. */}
        <img
          src={`/api/intake/${sessionId}/books/${bookId}/images/back`}
          alt="Back cover"
          className="w-full rounded-md"
        />
        {regions.regions.map((region) => {
          const active = selected.has(region.id);
          return (
            <button
              key={region.id}
              type="button"
              aria-pressed={active}
              aria-label={`${active ? "Deselect" : "Select"} region: ${region.text.slice(0, 60)}`}
              onClick={() => toggle(region.id)}
              style={{
                left: `${(region.box.x / regions.imageWidth) * 100}%`,
                top: `${(region.box.y / regions.imageHeight) * 100}%`,
                width: `${(region.box.width / regions.imageWidth) * 100}%`,
                height: `${(region.box.height / regions.imageHeight) * 100}%`,
              }}
              className={`absolute rounded border-2 transition-colors ${
                active ? "border-blue-500 bg-blue-500/35" : "border-white/70 bg-slate-900/10"
              }`}
            />
          );
        })}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {selected.size === 0
          ? "Nothing selected yet."
          : `${selected.size} region${selected.size === 1 ? "" : "s"} selected — ${preview.length} characters.`}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => onSave(preview)}
          className="flex-1 rounded-md bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save as description
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-3 text-base dark:border-slate-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Which regions to open with: the ones whose text is already part of the
 * current description (so re-opening the picker shows the previous selection,
 * US-G1), falling back to the auto-picked region (US-D7).
 */
function initialSelection(regions: BackCoverRegions, currentValue: string): Set<string> {
  const value = currentValue.trim();
  if (value.length > 0) {
    const matching = regions.regions.filter((r) => value.includes(r.text));
    if (matching.length > 0) return new Set(matching.map((r) => r.id));
  }
  return new Set(regions.regions.filter((r) => r.autoSelected).map((r) => r.id));
}

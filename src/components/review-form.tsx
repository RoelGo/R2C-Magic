"use client";

import { saveIntakeReviewAction } from "@/app/intake/actions";
import { DescriptionRegionPicker } from "@/components/description-region-picker";
import type {
  ReviewFieldSource,
  ReviewModel,
  ReviewSuggestion,
  SaveReviewInput,
} from "@/lib/intake/review";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

interface ReviewFormProps {
  sessionId: string;
  bookId: string;
  model: ReviewModel;
}

/**
 * Assisted review form (spec v2 Slice E, US-E1/E2/E3).
 *
 * Each text field is pre-filled with the best available value (online > OCR >
 * blank) and shows its alternatives as **selectable options above the input**.
 * Tapping an option fills the field and records that provenance; the field
 * stays fully editable, and any manual edit flips provenance back to `manual`.
 * Title + a front cover are required before the book can be saved (US-E3); the
 * webshop push is a separate, later step (Slice F).
 */
export function ReviewForm({ sessionId, bookId, model }: ReviewFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(model.saved !== null);
  const [pickingRegions, setPickingRegions] = useState(false);

  const [title, setTitle] = useState<FieldState>(
    initField(model.title, model.saved?.title, model.saved?.titleSource),
  );
  const [author, setAuthor] = useState<FieldState>(
    initField(model.author, model.saved?.author, model.saved?.authorSource),
  );
  const [description, setDescription] = useState<FieldState>(
    initField(model.description, model.saved?.description, model.saved?.descriptionSource),
  );
  const [weight, setWeight] = useState<string>(
    model.saved?.weightGrams != null
      ? String(model.saved.weightGrams)
      : model.weightGrams != null
        ? String(model.weightGrams)
        : "",
  );

  const titleMissing = title.value.trim().length === 0;
  const canSave = !titleMissing && model.hasFrontImage && !isPending;

  function save() {
    setError(null);
    const weightGrams = weight.trim().length > 0 ? Number(weight) : undefined;
    if (weightGrams !== undefined && (!Number.isInteger(weightGrams) || weightGrams <= 0)) {
      setError("Weight must be a positive whole number of grams, or left blank.");
      return;
    }

    const input: SaveReviewInput = {
      title: title.value,
      author: author.value.trim() || undefined,
      description: description.value.trim() || undefined,
      weightGrams,
      titleSource: title.source,
      authorSource: author.source,
      descriptionSource: description.source,
    };

    startTransition(async () => {
      const result = await saveIntakeReviewAction(sessionId, bookId, input);
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <SuggestField
        id="review-title"
        label="Title"
        required
        state={title}
        suggestions={model.title.suggestions}
        onChange={setTitle}
        placeholder="Book title"
      />

      <SuggestField
        id="review-author"
        label="Author"
        state={author}
        suggestions={model.author.suggestions}
        onChange={setAuthor}
        placeholder="Author name(s)"
      />

      <div className="space-y-2">
        <SuggestField
          id="review-description"
          label="Description"
          multiline
          state={description}
          suggestions={model.description.suggestions}
          onChange={setDescription}
          placeholder="Back-cover blurb / description"
        />

        {/* US-D8: hidden entirely when layout detection found no regions. */}
        {model.backRegions ? (
          pickingRegions ? (
            <DescriptionRegionPicker
              sessionId={sessionId}
              bookId={bookId}
              regions={model.backRegions}
              currentValue={description.value}
              onSave={(value) => {
                setDescription({ value, source: "ocr" });
                setPickingRegions(false);
              }}
              onCancel={() => setPickingRegions(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPickingRegions(true)}
              className="w-full rounded-md border border-slate-300 px-4 py-3 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Select description from back cover
            </button>
          )
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="review-weight"
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          Weight (grams) <span className="text-slate-400">— optional</span>
        </label>
        <input
          id="review-weight"
          type="text"
          inputMode="numeric"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          placeholder="e.g. 350"
          className="w-full rounded-md border border-slate-300 px-3 py-3 text-base dark:border-slate-700 dark:bg-slate-900"
        />
      </div>

      {!model.hasFrontImage ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          A front-cover photo is required before saving. Add one in step 3.
        </p>
      ) : null}
      {titleMissing ? (
        <p className="text-sm text-amber-600 dark:text-amber-400">A title is required.</p>
      ) : null}

      <button
        type="button"
        disabled={!canSave}
        onClick={save}
        className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Saving…" : saved ? "Save changes" : "Save review"}
      </button>

      {saved && !isPending && !error ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          Review saved. Push it to the webshop in step 5.
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface FieldState {
  value: string;
  source: ReviewFieldSource;
}

/** Seed a field from the model, preferring a previously-saved value. */
function initField(
  field: ReviewModel["title"],
  savedValue: string | null | undefined,
  savedSource: ReviewFieldSource | null | undefined,
): FieldState {
  if (savedValue != null) {
    return { value: savedValue, source: savedSource ?? "manual" };
  }
  return { value: field.value, source: field.source };
}

interface SuggestFieldProps {
  id: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
  placeholder?: string;
  state: FieldState;
  suggestions: ReviewSuggestion[];
  onChange: (next: FieldState) => void;
}

/**
 * A labelled text field with its suggestions as selectable option buttons
 * above the input. Selecting an option fills the field and adopts its
 * provenance; typing in the field marks the value as `manual`. The currently
 * adopted option is highlighted.
 */
function SuggestField({
  id,
  label,
  required,
  multiline,
  placeholder,
  state,
  suggestions,
  onChange,
}: SuggestFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => {
            const active = state.source === s.source && state.value === s.value;
            return (
              <button
                key={`${s.source}:${s.value}`}
                type="button"
                onClick={() => onChange({ value: s.value, source: s.source })}
                aria-pressed={active}
                title={s.value}
                className={`max-w-full rounded-full border px-3 py-1.5 text-left text-sm ${
                  active
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                }`}
              >
                <span className="mr-1.5 text-xs uppercase tracking-wide opacity-70">{s.label}</span>
                <span className="align-middle">{truncate(s.value, 60)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {multiline ? (
        <textarea
          id={id}
          rows={5}
          value={state.value}
          placeholder={placeholder}
          onChange={(e) => onChange({ value: e.target.value, source: "manual" })}
          className="w-full rounded-md border border-slate-300 px-3 py-3 text-base dark:border-slate-700 dark:bg-slate-900"
        />
      ) : (
        <input
          id={id}
          type="text"
          value={state.value}
          placeholder={placeholder}
          onChange={(e) => onChange({ value: e.target.value, source: "manual" })}
          className="w-full rounded-md border border-slate-300 px-3 py-3 text-base dark:border-slate-700 dark:bg-slate-900"
        />
      )}
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

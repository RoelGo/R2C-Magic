"use client";

import { uploadRunAction } from "@/app/actions";
import { useRef, useState, useTransition } from "react";

/**
 * HTML5 file dropzone + form, no external deps. Submits the file via the
 * `uploadRunAction` server action. On success the action redirects to the
 * run detail page; on validation failure it returns an error string.
 */
export function UploadDropzone() {
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(file: File) {
    setError(null);
    setFileName(file.name);
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => {
      const result = await uploadRunAction(fd);
      if (result && !result.ok) {
        setError(result.error);
      }
    });
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) submit(file);
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) submit(file);
  }

  return (
    <div className="space-y-3">
      <label
        htmlFor="r2c-file-input"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        className={[
          "block cursor-pointer rounded-lg border-2 border-dashed p-12 text-center transition",
          isDragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : "border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600",
          isPending ? "pointer-events-none opacity-60" : "",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          id="r2c-file-input"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={onChange}
          disabled={isPending}
        />
        <p className="text-base font-medium text-slate-800 dark:text-slate-100">
          {isPending ? `Processing ${fileName ?? "upload"}…` : "Drop an R-Series CSV here"}
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {isPending ? "Hang on, this should be quick." : "or click to choose a file (max 20 MB)"}
        </p>
        {fileName && !isPending ? (
          <p className="mt-3 text-xs text-slate-500">Last selected: {fileName}</p>
        ) : null}
      </label>
      {error ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

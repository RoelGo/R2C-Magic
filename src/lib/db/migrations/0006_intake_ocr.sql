-- v2 (Slice D, OCR): server-side cover OCR (US-D3 title, US-D4 description).
-- Adds the OCR lifecycle + extracted-field columns to `intake_books`, filled
-- after a cover photo is uploaded and surfaced non-blockingly like the online
-- enrichment. `ocr_engine` records which engine produced the result so the
-- two adapters (ocrs, PP-OCRv6) can be benchmarked.
ALTER TABLE `intake_books` ADD `ocr_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `ocr_engine` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `ocr_title` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `ocr_author` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `ocr_description` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `ocr_errors` text;

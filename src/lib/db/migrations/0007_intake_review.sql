-- v2 (Slice E, assisted review form): the worker-confirmed values that Slice F
-- pushes to the webshop (US-E1/E2). These are distinct from the enrichment/OCR
-- suggestion columns: the review form pre-fills from those (online > OCR >
-- blank) and the worker adopts or overrides per field. The *_source columns
-- record which suggestion was chosen (or `manual`) for later QA / source
-- tuning. All nullable — populated only once the review form is saved.
ALTER TABLE `intake_books` ADD `reviewed_title` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `reviewed_author` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `reviewed_description` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `reviewed_weight_grams` integer;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `title_source` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `author_source` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `description_source` text;

-- v2 (Slice C): background online enrichment for intake books. Adds the
-- enrichment lifecycle + merged result columns to `intake_books`, kicked off
-- when an EAN is captured (US-C1) and surfaced non-blockingly (US-C2).
ALTER TABLE `intake_books` ADD `enrichment_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `enriched_payload` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `enrichment_errors` text;

-- M2 (Piece 3): the enrichment cache now stores per-source HTTP status and
-- error messages so we can distinguish "cached not-found" from "cached error"
-- without re-running the live call. Both new columns are nullable.
ALTER TABLE `enrichment_cache` ADD COLUMN `http_status` integer;
--> statement-breakpoint
ALTER TABLE `enrichment_cache` ADD COLUMN `error` text;

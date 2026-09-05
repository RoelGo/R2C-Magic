-- v2 (Slice F, push to Lightspeed Retail): push state layered onto the
-- intake_books.status lifecycle (US-F1/F2). `retail_item_id` records the
-- matched Retail Item on a successful push so a re-push stays idempotent and
-- update-only (rokko's decision); `push_error` holds the last failure message
-- for the retry UI (set with status = 'failed'); `pushed_at` marks the last
-- successful push. All nullable — populated only once a push is attempted.
ALTER TABLE `intake_books` ADD `retail_item_id` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `push_error` text;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `pushed_at` integer;

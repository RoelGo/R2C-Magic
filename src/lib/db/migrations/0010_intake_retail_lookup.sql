-- v2 (Slice B, US-B3): live Retail lookup state for an intake book. The moment
-- an EAN is captured we look the book up against the Lightspeed Retail API to
-- see whether it already exists as an Item. `retail_lookup_status` drives the
-- submit gate (found → update; missing → blocked unless the worker opts to
-- create it); `retail_lookup_error` holds the last failure message (set with
-- status = 'error'). `retail_item_id` (added in 0009) is populated with the
-- matched Item on a 'found' result so the push can update it directly.
ALTER TABLE `intake_books` ADD `retail_lookup_status` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `intake_books` ADD `retail_lookup_error` text;

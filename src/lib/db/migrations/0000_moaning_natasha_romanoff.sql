CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ean` text NOT NULL,
	`r_series_payload` text NOT NULL,
	`enriched_payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`errors` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `enrichment_cache` (
	`source` text NOT NULL,
	`ean` text NOT NULL,
	`payload` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`source`, `ean`)
);
--> statement-breakpoint
CREATE TABLE `enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`source` text NOT NULL,
	`payload` text,
	`fetched_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`http_status` integer,
	`error` text,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_path` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_name` text NOT NULL,
	`source_file_path` text NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_books` integer DEFAULT 0 NOT NULL,
	`processed_books` integer DEFAULT 0 NOT NULL,
	`failed_books` integer DEFAULT 0 NOT NULL,
	`error` text
);

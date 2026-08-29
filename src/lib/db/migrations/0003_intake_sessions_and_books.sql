-- v2 (Slice A): mobile single-book intake. Two new tables backing the
-- "New arrivals" session flow. `intake_sessions` is a lightweight container
-- started by a worker; `intake_books` holds one row per book being added,
-- persisted so progress survives a reload / phone lock (US-A1/US-A2).
CREATE TABLE `intake_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_books` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ean` text,
	`title` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `intake_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);

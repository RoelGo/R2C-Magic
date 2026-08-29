-- v2 (Slice D): cover photography. `intake_images` holds one current photo
-- per (book, kind) — front (US-D1) and back (US-D2). Bytes live on disk under
-- DATA_DIR/intake-images/<bookId>/; this table stores only metadata + the
-- relative path so retakes upsert cleanly and files are ready for the eCom
-- image upload in Slice F.
CREATE TABLE `intake_images` (
	`id` text NOT NULL,
	`book_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`book_id`, `kind`),
	FOREIGN KEY (`book_id`) REFERENCES `intake_books`(`id`) ON UPDATE no action ON DELETE cascade
);

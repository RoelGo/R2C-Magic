-- Custom SQL migration file, put your code below! --

-- Add a `format` column to `runs` so the worker knows which parser produced
-- the row payloads. Default to 'r-series' for any rows that pre-date this
-- migration (M1 only knew about R-Series exports).
ALTER TABLE `runs` ADD COLUMN `format` text DEFAULT 'r-series' NOT NULL;
--> statement-breakpoint

-- Rename `books.r_series_payload` to `books.source_payload`. The column now
-- stores a discriminated union (`{ kind, rSeries|cb }`) rather than a bare
-- RSeriesRow, so every pre-existing value also needs to be re-wrapped under
-- a `kind: "r-series"` envelope before the application reads it back.
ALTER TABLE `books` RENAME COLUMN `r_series_payload` TO `source_payload`;
--> statement-breakpoint

-- Re-wrap legacy payloads as `BookSource` discriminated-union JSON. Only
-- touches rows whose payload does not yet have a `kind` key, so the
-- migration is idempotent and safe to re-run.
UPDATE `books`
SET `source_payload` = json_object('kind', 'r-series', 'rSeries', json(`source_payload`))
WHERE json_extract(`source_payload`, '$.kind') IS NULL;

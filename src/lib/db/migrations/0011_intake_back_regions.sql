-- v2 (Slice D, US-D7/US-D8): persisted back-cover layout regions for an intake
-- book. The layout pass segments the back cover into regions; we store them as
-- JSON ({ imageWidth, imageHeight, regions: [{ id, label, box, text,
-- autoSelected }] }) so the worker can tap-select which paragraphs make up the
-- description, and so that selection survives a reload (US-G1). Null when
-- layout detection is disabled, failed, or found no regions.
ALTER TABLE `intake_books` ADD `ocr_back_regions` text;

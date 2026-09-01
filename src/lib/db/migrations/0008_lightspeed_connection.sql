-- v2 (Slice F): the app's single OAuth link to a Lightspeed Retail (R-Series)
-- account. rokko is on an omnichannel plan, so products are pushed through the
-- Retail API; this table stores the access/refresh tokens from the
-- authorization-code-grant + PKCE flow. Single-tenant, self-hosted app, so
-- exactly one row (`id = 'default'`); the refresh token rotates on every use.
CREATE TABLE `lightspeed_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`scope` text,
	`connected_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);

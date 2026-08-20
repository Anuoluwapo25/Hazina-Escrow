CREATE TABLE `sentinel_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`invariant` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`escrow_id` integer,
	`tx_hash` text,
	`ledger` integer,
	`message` text NOT NULL,
	`details` text,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_notified_at` text,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sentinel_alerts_dedupe_key_unique` ON `sentinel_alerts` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `sentinel_cursor` (
	`id` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_ledger` integer DEFAULT 0 NOT NULL,
	`backfill_complete` integer DEFAULT 0 NOT NULL,
	`last_wasm_hash` text,
	`last_progress_at` text NOT NULL,
	`updated_at` text NOT NULL
);

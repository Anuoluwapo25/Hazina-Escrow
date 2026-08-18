CREATE TABLE `dataset_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`encoding` text DEFAULT 'gzip+base64' NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`byte_size` integer NOT NULL,
	`raw_byte_size` integer NOT NULL,
	`observations` integer DEFAULT 1 NOT NULL,
	`last_observed_at` text NOT NULL,
	`provider_run_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dataset_snapshots_dataset_valid_from_idx` ON `dataset_snapshots` (`dataset_id`,`valid_from`);--> statement-breakpoint
CREATE INDEX `dataset_snapshots_content_hash_idx` ON `dataset_snapshots` (`content_hash`);--> statement-breakpoint
CREATE INDEX `dataset_snapshots_current_idx` ON `dataset_snapshots` (`dataset_id`,`valid_to`);--> statement-breakpoint
ALTER TABLE `datasets` ADD `snapshot_policy` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `snapshot_id` text;

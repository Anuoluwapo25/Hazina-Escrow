ALTER TABLE `datasets` ADD `category` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `datasets` ADD `live` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `datasets` ADD `last_refreshed_at` text;--> statement-breakpoint
ALTER TABLE `datasets` ADD `tags` text;--> statement-breakpoint
CREATE INDEX `datasets_category_idx` ON `datasets` (`category`);
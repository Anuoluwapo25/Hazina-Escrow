CREATE TABLE `datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`type` text NOT NULL,
	`price_per_query` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`seller_wallet` text NOT NULL,
	`notification_email` text,
	`data` text DEFAULT '{}' NOT NULL,
	`queries_served` integer DEFAULT 0 NOT NULL,
	`total_earned` text DEFAULT '0' NOT NULL,
	`created_at` text NOT NULL,
	`ratings` text,
	`price_history` text
);
--> statement-breakpoint
CREATE INDEX `datasets_type_idx` ON `datasets` (`type`);--> statement-breakpoint
CREATE INDEX `datasets_seller_wallet_idx` ON `datasets` (`seller_wallet`);--> statement-breakpoint
CREATE INDEX `datasets_created_at_idx` ON `datasets` (`created_at`);--> statement-breakpoint
CREATE TABLE `payout_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`seller_wallet` text NOT NULL,
	`buyer_tx_hash` text NOT NULL,
	`intended_amount` text NOT NULL,
	`seller_tx_hash` text,
	`status` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` text NOT NULL,
	`last_error` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payout_failures_buyer_tx_hash_unique` ON `payout_failures` (`buyer_tx_hash`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`amount` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`buyer_wallet` text,
	`memo` text,
	`status` text,
	`delivery_status` text,
	`seller_paid` integer,
	`seller_amount` text,
	`seller_tx_hash` text,
	`seller_notified_at` text,
	`seller_notification_error` text,
	`seller_notification_attempts` integer,
	`buyer_query` text,
	`ai_summary` text,
	`delivery_attempts` integer,
	`delivery_error` text,
	`verified_at` text,
	`delivered_at` text,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_tx_hash_unique` ON `transactions` (`tx_hash`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_wallet` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);

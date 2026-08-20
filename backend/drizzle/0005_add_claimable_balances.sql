CREATE TABLE `claimable_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`balance_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`seller_wallet` text NOT NULL,
	`buyer_tx_hash` text NOT NULL,
	`amount` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`status` text NOT NULL,
	`creation_tx_hash` text NOT NULL,
	`reclaimable_at` text NOT NULL,
	`claimed_tx_hash` text,
	`claimed_at` text,
	`reclaimed_tx_hash` text,
	`reclaimed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claimable_balances_balance_id_unique` ON `claimable_balances` (`balance_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `balance_id` text;
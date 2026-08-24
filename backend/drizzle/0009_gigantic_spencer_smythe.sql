CREATE TABLE `bundle_components` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`share_bps` integer NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bundle_components_bundle_id_idx` ON `bundle_components` (`bundle_id`);--> statement-breakpoint
CREATE INDEX `bundle_components_dataset_id_idx` ON `bundle_components` (`dataset_id`);--> statement-breakpoint
CREATE TABLE `bundle_purchase_components` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`role` text NOT NULL,
	`escrow_id` integer NOT NULL,
	`seller_wallet` text NOT NULL,
	`amount` text NOT NULL,
	`buyer_confirmed` integer DEFAULT 0 NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`delivery_error` text,
	`delivery_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bundle_purchase_components_purchase_id_idx` ON `bundle_purchase_components` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `bundle_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`buyer_wallet` text NOT NULL,
	`first_escrow_id` integer NOT NULL,
	`escrow_ids` text NOT NULL,
	`total_amount` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`status` text NOT NULL,
	`lock_tx_hash` text,
	`release_tx_hash` text,
	`ai_summary` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`curator_wallet` text NOT NULL,
	`total_price` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`curator_fee_bps` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);

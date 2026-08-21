CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`buyer` text NOT NULL,
	`seller` text NOT NULL,
	`amount` text NOT NULL,
	`payment_token` text DEFAULT 'USDC' NOT NULL,
	`tx_hash` text NOT NULL,
	`leaf_hash` text NOT NULL,
	`receipt_hash` text NOT NULL,
	`anchor_mode` text NOT NULL,
	`anchor_status` text NOT NULL,
	`anchor_tx_hash` text,
	`merkle_root` text,
	`merkle_index` integer,
	`merkle_proof` text,
	`delivered_at` text NOT NULL,
	`anchored_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_tx_hash_unique` ON `receipts` (`tx_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_receipt_hash_unique` ON `receipts` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `receipts_dataset_idx` ON `receipts` (`dataset_id`);--> statement-breakpoint
CREATE INDEX `receipts_buyer_idx` ON `receipts` (`buyer`);--> statement-breakpoint
CREATE INDEX `receipts_seller_idx` ON `receipts` (`seller`);--> statement-breakpoint
CREATE INDEX `receipts_tx_hash_idx` ON `receipts` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `receipts_receipt_hash_idx` ON `receipts` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `receipts_anchor_status_idx` ON `receipts` (`anchor_status`);
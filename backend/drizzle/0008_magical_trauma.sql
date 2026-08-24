CREATE TABLE `sep10_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`client_account` text NOT NULL,
	`home_domain` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`redeemed_at` integer
);
--> statement-breakpoint
CREATE INDEX `sep10_nonces_expires_at_idx` ON `sep10_nonces` (`expires_at`);
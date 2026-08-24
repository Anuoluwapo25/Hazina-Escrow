CREATE TABLE `dataset_embeddings` (
	`dataset_id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dataset_embeddings_content_hash_idx` ON `dataset_embeddings` (`content_hash`);
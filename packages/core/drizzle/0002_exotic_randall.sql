ALTER TABLE `servers` ADD `callback_token_hash` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `plan_token_hash` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `plan_token_expires_at` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `plan_token_uses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `plan_token_replayed_at` text;
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`server_id` text,
	`user_id` text,
	`run_id` text,
	`payload` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_server_id_idx` ON `events` (`server_id`);--> statement-breakpoint
CREATE INDEX `events_created_at_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `packs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tools` text NOT NULL,
	`display_order` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`image_url` text,
	`theme` text,
	`requires_repos` integer DEFAULT false NOT NULL,
	`requires_rdp` integer DEFAULT false NOT NULL,
	`desktop` text,
	`source_file` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`auth_tag` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `secrets_owner_id_idx` ON `secrets` (`owner_id`);--> statement-breakpoint
CREATE INDEX `secrets_kind_idx` ON `secrets` (`kind`);--> statement-breakpoint
CREATE TABLE `server_repositories` (
	`server_id` text NOT NULL,
	`repository_url` text NOT NULL,
	PRIMARY KEY(`server_id`, `repository_url`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`size` text NOT NULL,
	`offering_id` text NOT NULL,
	`arch` text NOT NULL,
	`region` text,
	`status` text NOT NULL,
	`provisioning_step` text,
	`error_message` text,
	`provider_data` text,
	`bootstrap_mode` text DEFAULT 'push' NOT NULL,
	`install_plan` text,
	`ssh_user` text DEFAULT 'rocky' NOT NULL,
	`managed_key_secret_id` text,
	`host_key_fingerprint` text,
	`public_ip` text,
	`public_dns` text,
	`previous_ip` text,
	`ip_changed_at` text,
	`pack_id` text,
	`tools` text,
	`repositories` text,
	`idempotency_key` text NOT NULL,
	`hourly_cost_amount` real,
	`hourly_cost_currency` text,
	`hourly_cost_fetched_at` text,
	`total_uptime_seconds` integer DEFAULT 0 NOT NULL,
	`estimated_total_cost` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`stopped_at` text,
	`terminated_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_idempotency_key_idx` ON `servers` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `servers_user_id_idx` ON `servers` (`user_id`);--> statement-breakpoint
CREATE INDEX `servers_status_idx` ON `servers` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`url` text NOT NULL,
	`install_script` text NOT NULL,
	`setup_script` text,
	`enabled` integer DEFAULT true NOT NULL,
	`install_order` integer NOT NULL,
	`bootstrap` integer DEFAULT false NOT NULL,
	`run_as` text DEFAULT 'rocky' NOT NULL,
	`source_file` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_username` text NOT NULL,
	`github_id` text NOT NULL,
	`email` text,
	`avatar_url` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`server_limit` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_username_idx` ON `users` (`github_username`);
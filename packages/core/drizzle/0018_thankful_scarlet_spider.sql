ALTER TABLE `packs` ADD `derived_from_pack_id` text;--> statement-breakpoint
ALTER TABLE `tools` ADD `always_install` integer DEFAULT false NOT NULL;
CREATE TABLE `visual_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_visual_presets_user_updated` ON `visual_presets` (`user_id`,`updated_at`,`id`);
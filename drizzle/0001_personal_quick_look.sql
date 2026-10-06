ALTER TABLE `visual_presets` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `visual_presets` ADD `quick_look_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `visual_presets` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_visual_presets_user_pinned_order` ON `visual_presets` (`user_id`,`pinned`,`quick_look_order`,`id`);
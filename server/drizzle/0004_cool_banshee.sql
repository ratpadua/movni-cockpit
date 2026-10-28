ALTER TABLE `payments` ADD `recurrence_id` varchar(36);--> statement-breakpoint
ALTER TABLE `settings` ADD `min_installment_value` decimal(12,2) DEFAULT '150' NOT NULL;
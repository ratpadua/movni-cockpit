CREATE TABLE `customer_credits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customer_id` int NOT NULL,
	`description` varchar(255) NOT NULL,
	`value` decimal(12,2) NOT NULL DEFAULT '0',
	`remaining` decimal(12,2) NOT NULL DEFAULT '0',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customer_credits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoice_modifiers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`price` decimal(12,2) NOT NULL DEFAULT '0',
	`discount_percent` decimal(5,2) NOT NULL DEFAULT '0',
	CONSTRAINT `invoice_modifiers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contract_modifiers` ADD `discount_percent` decimal(5,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `credit_id` int;--> statement-breakpoint
ALTER TABLE `contracts` ADD `credit_applied` decimal(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `status` enum('aguardando_pagamento','agendado','realizado','em_edicao','enviado','finalizado') DEFAULT 'aguardando_pagamento' NOT NULL;--> statement-breakpoint
ALTER TABLE `contracts` ADD `status_changed_at` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `ref_number` varchar(16);--> statement-breakpoint
ALTER TABLE `invoices` ADD `credit_id` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `credit_applied` decimal(12,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `edit_window_days` int DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `preview_window_days` int DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_credits` ADD CONSTRAINT `customer_credits_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_modifiers` ADD CONSTRAINT `invoice_modifiers_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_credit_id_customer_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `customer_credits`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_credit_id_customer_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `customer_credits`(`id`) ON DELETE set null ON UPDATE no action;
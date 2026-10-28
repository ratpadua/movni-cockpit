CREATE TABLE `bank_imports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`file_name` varchar(512) NOT NULL,
	`bank_id` varchar(64),
	`account_id` varchar(64),
	`item_count` int NOT NULL DEFAULT 0,
	`imported_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bank_imports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`flow` enum('in','out'),
	CONSTRAINT `categories_id` PRIMARY KEY(`id`),
	CONSTRAINT `categories_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `contract_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_id` int,
	`invoice_id` int,
	`comments` text,
	`file_name` varchar(512) NOT NULL,
	`file_path` varchar(1024) NOT NULL,
	`format` varchar(16) NOT NULL DEFAULT 'docx',
	`generated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contract_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `item_additionals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_item_id` int NOT NULL,
	`additional_id` int,
	`name` varchar(255) NOT NULL,
	`unit_price` decimal(12,2) NOT NULL DEFAULT '0',
	`quantity` int NOT NULL DEFAULT 1,
	`discount_percent` decimal(5,2) NOT NULL DEFAULT '0',
	`line_total` decimal(12,2) NOT NULL DEFAULT '0',
	CONSTRAINT `item_additionals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contract_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_id` int NOT NULL,
	`service_version_id` int,
	`service_name` varchar(255) NOT NULL,
	`base_price` decimal(12,2) NOT NULL DEFAULT '0',
	`quantity` int NOT NULL DEFAULT 1,
	`discount_percent` decimal(5,2) NOT NULL DEFAULT '0',
	`line_total` decimal(12,2) NOT NULL DEFAULT '0',
	`description` text,
	`performed_at` date,
	`invoice_id` int,
	CONSTRAINT `contract_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contract_modifiers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`price` decimal(12,2) NOT NULL DEFAULT '0',
	CONSTRAINT `contract_modifiers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`number` varchar(16),
	`customer_id` int,
	`type` enum('contract','invoice') NOT NULL DEFAULT 'contract',
	`title` varchar(255),
	`template_id` int,
	`invoice_template_id` int,
	`execution_date` date,
	`execution_time` varchar(16),
	`execution_address` varchar(512),
	`comments` text,
	`installments` int NOT NULL DEFAULT 1,
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contracts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`nickname` varchar(255),
	`address` varchar(512),
	`neighborhood` varchar(255),
	`city` varchar(255),
	`state` varchar(64),
	`email` varchar(255),
	`phone` varchar(64),
	`whatsapp` varchar(64),
	`preferred_contact` enum('whatsapp','email'),
	`document` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_id` int NOT NULL,
	`reference` varchar(255),
	`comments` text,
	`discount_percent` decimal(5,2) NOT NULL DEFAULT '0',
	`installments` int NOT NULL DEFAULT 1,
	`total` decimal(12,2) NOT NULL DEFAULT '0',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`contract_id` int,
	`invoice_id` int,
	`customer_id` int,
	`category_id` int,
	`description` varchar(255) NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`flow` enum('in','out') NOT NULL DEFAULT 'in',
	`status` enum('upcoming','done') NOT NULL DEFAULT 'upcoming',
	`receipt_status` enum('open','received','sent') NOT NULL DEFAULT 'open',
	`installment_number` int,
	`installment_count` int,
	`due_date` date,
	`paid_date` date,
	`received_date` date,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `service_additionals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`version_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`price` decimal(12,2) NOT NULL DEFAULT '0',
	CONSTRAINT `service_additionals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `service_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`service_id` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`base_price` decimal(12,2) NOT NULL DEFAULT '0',
	`active` boolean NOT NULL DEFAULT true,
	`notes` varchar(512),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `service_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `services_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int NOT NULL,
	`menu_color` varchar(16),
	`accent_color` varchar(16),
	`bg_color` varchar(16),
	`logo` longtext,
	`logo_mime` varchar(64),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` varchar(32) NOT NULL,
	`name` varchar(255) NOT NULL,
	`file_name` varchar(512) NOT NULL,
	`content` longtext NOT NULL,
	`is_default` boolean NOT NULL DEFAULT false,
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`import_id` int,
	`fit_id` varchar(255),
	`date` date,
	`description` varchar(512),
	`memo` varchar(512),
	`amount` decimal(12,2) NOT NULL,
	`flow` enum('in','out') NOT NULL,
	`category_id` int,
	`matched_payment_id` int,
	`invoice_generated` boolean NOT NULL DEFAULT false,
	`invoice_link` varchar(1024),
	`receipt_link` varchar(1024),
	`imported` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_documents` ADD CONSTRAINT `contract_documents_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_additionals` ADD CONSTRAINT `item_additionals_contract_item_id_contract_items_id_fk` FOREIGN KEY (`contract_item_id`) REFERENCES `contract_items`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_additionals` ADD CONSTRAINT `item_additionals_additional_id_service_additionals_id_fk` FOREIGN KEY (`additional_id`) REFERENCES `service_additionals`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_items` ADD CONSTRAINT `contract_items_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_items` ADD CONSTRAINT `contract_items_service_version_id_service_versions_id_fk` FOREIGN KEY (`service_version_id`) REFERENCES `service_versions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_items` ADD CONSTRAINT `contract_items_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contract_modifiers` ADD CONSTRAINT `contract_modifiers_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_template_id_templates_id_fk` FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_invoice_template_id_templates_id_fk` FOREIGN KEY (`invoice_template_id`) REFERENCES `templates`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_additionals` ADD CONSTRAINT `service_additionals_version_id_service_versions_id_fk` FOREIGN KEY (`version_id`) REFERENCES `service_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `service_versions` ADD CONSTRAINT `service_versions_service_id_services_id_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_import_id_bank_imports_id_fk` FOREIGN KEY (`import_id`) REFERENCES `bank_imports`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_category_id_categories_id_fk` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_matched_payment_id_payments_id_fk` FOREIGN KEY (`matched_payment_id`) REFERENCES `payments`(`id`) ON DELETE set null ON UPDATE no action;
CREATE TABLE `credit_applications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`credit_id` int NOT NULL,
	`contract_id` int,
	`invoice_id` int,
	`amount` decimal(12,2) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_applications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `credit_applications` ADD CONSTRAINT `credit_applications_credit_id_customer_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `customer_credits`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_applications` ADD CONSTRAINT `credit_applications_contract_id_contracts_id_fk` FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_applications` ADD CONSTRAINT `credit_applications_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;
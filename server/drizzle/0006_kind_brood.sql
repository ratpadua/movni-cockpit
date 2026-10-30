ALTER TABLE `contracts` ADD CONSTRAINT `contracts_number_uq` UNIQUE(`number`);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_ref_number_uq` UNIQUE(`ref_number`);
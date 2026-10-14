CREATE TABLE `app_settings` (
	`name` varchar(64) NOT NULL,
	`value` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_settings_name` PRIMARY KEY(`name`)
);

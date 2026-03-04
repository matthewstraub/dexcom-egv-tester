ALTER TABLE `health_upload_jobs` ADD `fileRef` text NOT NULL;--> statement-breakpoint
ALTER TABLE `health_upload_jobs` DROP COLUMN `s3Key`;--> statement-breakpoint
ALTER TABLE `health_upload_jobs` DROP COLUMN `s3Url`;
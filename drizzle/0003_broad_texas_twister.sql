CREATE TABLE `health_buckets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`bucketStart` varchar(30) NOT NULL,
	`bucketEnd` varchar(30) NOT NULL,
	`metric` varchar(64) NOT NULL,
	`avg` text NOT NULL,
	`min` text NOT NULL,
	`max` text NOT NULL,
	`sum` text NOT NULL,
	`count` int NOT NULL,
	CONSTRAINT `health_buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `health_upload_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`s3Key` text NOT NULL,
	`s3Url` text NOT NULL,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`totalRecordsScanned` int,
	`relevantDataPoints` int,
	`workoutCount` int,
	`metricsFound` text,
	`dataRangeStart` text,
	`dataRangeEnd` text,
	`bucketCount` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `health_upload_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `health_workouts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` int NOT NULL,
	`activityType` varchar(128) NOT NULL,
	`activityLabel` varchar(128) NOT NULL,
	`duration` text NOT NULL,
	`totalDistance` text,
	`distanceUnit` varchar(32),
	`totalEnergyBurned` text,
	`energyUnit` varchar(32),
	`startDate` varchar(30) NOT NULL,
	`endDate` varchar(30) NOT NULL,
	`sourceName` varchar(256),
	CONSTRAINT `health_workouts_id` PRIMARY KEY(`id`)
);

import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Stores Dexcom OAuth tokens per user.
 * Each user can have one active Dexcom connection.
 */
export const dexcomTokens = mysqlTable("dexcom_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  accessToken: text("accessToken").notNull(),
  refreshToken: text("refreshToken").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  sandboxUser: varchar("sandboxUser", { length: 64 }),
  /** Which Dexcom environment this token is for: "sandbox" or "production" */
  environment: mysqlEnum("environment", ["sandbox", "production"]).default("sandbox").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DexcomToken = typeof dexcomTokens.$inferSelect;
export type InsertDexcomToken = typeof dexcomTokens.$inferInsert;

/**
 * Tracks Apple Health upload processing jobs.
 * Supports async background processing with status polling.
 */
export const healthUploadJobs = mysqlTable("health_upload_jobs", {
  id: int("id").autoincrement().primaryKey(),
  /** Identifier for the upload (e.g. temp file name or reference) */
  fileRef: text("fileRef").notNull(),
  /** Processing status */
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"]).default("pending").notNull(),
  /** Error message if processing failed */
  errorMessage: text("errorMessage"),
  /** Total records scanned in the XML */
  totalRecordsScanned: int("totalRecordsScanned"),
  /** Number of relevant data points extracted */
  relevantDataPoints: int("relevantDataPoints"),
  /** Number of workouts found */
  workoutCount: int("workoutCount"),
  /** Comma-separated list of metrics found */
  metricsFound: text("metricsFound"),
  /** Start of the health data date range (ISO string) */
  dataRangeStart: text("dataRangeStart"),
  /** End of the health data date range (ISO string) */
  dataRangeEnd: text("dataRangeEnd"),
  /** Number of aggregated buckets */
  bucketCount: int("bucketCount"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type HealthUploadJob = typeof healthUploadJobs.$inferSelect;
export type InsertHealthUploadJob = typeof healthUploadJobs.$inferInsert;

/**
 * Stores aggregated health data buckets (15-minute windows).
 * Each row is one metric's aggregation for one time bucket.
 */
export const healthBuckets = mysqlTable("health_buckets", {
  id: int("id").autoincrement().primaryKey(),
  /** Reference to the upload job */
  jobId: int("jobId").notNull(),
  /** Bucket start time (ISO string) */
  bucketStart: varchar("bucketStart", { length: 30 }).notNull(),
  /** Bucket end time (ISO string) */
  bucketEnd: varchar("bucketEnd", { length: 30 }).notNull(),
  /** Metric key (e.g., 'heartRate', 'stepCount') */
  metric: varchar("metric", { length: 64 }).notNull(),
  /** Average value in this bucket */
  avg: text("avg").notNull(),
  /** Minimum value */
  min: text("min").notNull(),
  /** Maximum value */
  max: text("max").notNull(),
  /** Sum of all values */
  sum: text("sum").notNull(),
  /** Count of data points */
  count: int("count").notNull(),
});

export type HealthBucket = typeof healthBuckets.$inferSelect;
export type InsertHealthBucket = typeof healthBuckets.$inferInsert;

/**
 * Stores parsed workout records from Apple Health.
 */
export const healthWorkouts = mysqlTable("health_workouts", {
  id: int("id").autoincrement().primaryKey(),
  /** Reference to the upload job */
  jobId: int("jobId").notNull(),
  activityType: varchar("activityType", { length: 128 }).notNull(),
  activityLabel: varchar("activityLabel", { length: 128 }).notNull(),
  /** Duration in minutes */
  duration: text("duration").notNull(),
  totalDistance: text("totalDistance"),
  distanceUnit: varchar("distanceUnit", { length: 32 }),
  totalEnergyBurned: text("totalEnergyBurned"),
  energyUnit: varchar("energyUnit", { length: 32 }),
  startDate: varchar("startDate", { length: 30 }).notNull(),
  endDate: varchar("endDate", { length: 30 }).notNull(),
  sourceName: varchar("sourceName", { length: 256 }),
});

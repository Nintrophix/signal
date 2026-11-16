CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`user_id` integer,
	`event` text NOT NULL,
	`ip` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `candles` (
	`token` integer NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`ts` integer NOT NULL,
	`o` real NOT NULL,
	`h` real NOT NULL,
	`l` real NOT NULL,
	`c` real NOT NULL,
	`v` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`token`, `timeframe`, `ts`)
);
--> statement-breakpoint
CREATE TABLE `evaluations` (
	`timeframe` text NOT NULL,
	`ts` integer NOT NULL,
	`expiry` text NOT NULL,
	`spot` real NOT NULL,
	`ce_strike` real NOT NULL,
	`pe_strike` real NOT NULL,
	`ce_low` real NOT NULL,
	`ce_high` real NOT NULL,
	`pe_low` real NOT NULL,
	`pe_high` real NOT NULL,
	`pattern` text NOT NULL,
	`direction` text NOT NULL,
	`signal_value` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`timeframe`, `ts`)
);
--> statement-breakpoint
CREATE TABLE `instruments` (
	`token` integer PRIMARY KEY NOT NULL,
	`tradingsymbol` text NOT NULL,
	`name` text NOT NULL,
	`expiry` text NOT NULL,
	`strike` real NOT NULL,
	`type` text NOT NULL,
	`fetched_on` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `instruments_lookup_idx` ON `instruments` (`name`,`expiry`,`strike`,`type`);--> statement-breakpoint
CREATE TABLE `kite_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_token_enc` text NOT NULL,
	`kite_user_id` text,
	`connected_by` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`csrf_token` text NOT NULL,
	`kite_state` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`timeframe` text NOT NULL,
	`expiry` text NOT NULL,
	`spot` real NOT NULL,
	`ce_strike` real NOT NULL,
	`pe_strike` real NOT NULL,
	`ce_low` real NOT NULL,
	`ce_high` real NOT NULL,
	`pe_low` real NOT NULL,
	`pe_high` real NOT NULL,
	`pattern` text NOT NULL,
	`prev_pattern` text NOT NULL,
	`direction` text NOT NULL,
	`signal_value` real,
	`rule` text,
	`diff` real,
	`formula` text NOT NULL,
	`sorted` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signals_dedupe_idx` ON `signals` (`timeframe`,`ts`,`prev_pattern`,`pattern`);--> statement-breakpoint
CREATE INDEX `signals_ts_idx` ON `signals` (`ts`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
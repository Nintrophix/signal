-- Signals are append-only history: block UPDATE and DELETE at the database level.
CREATE TRIGGER `signals_no_update` BEFORE UPDATE ON `signals`
BEGIN
  SELECT RAISE(ABORT, 'signals are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `signals_no_delete` BEFORE DELETE ON `signals`
BEGIN
  SELECT RAISE(ABORT, 'signals are append-only');
END;
--> statement-breakpoint
-- Hard cap of 5 active users (also enforced in application code).
CREATE TRIGGER `users_cap_insert` BEFORE INSERT ON `users`
WHEN NEW.active = 1 AND (SELECT COUNT(*) FROM `users` WHERE `active` = 1) >= 5
BEGIN
  SELECT RAISE(ABORT, 'user cap reached (5 active users)');
END;
--> statement-breakpoint
CREATE TRIGGER `users_cap_reactivate` BEFORE UPDATE OF `active` ON `users`
WHEN NEW.active = 1 AND OLD.active = 0 AND (SELECT COUNT(*) FROM `users` WHERE `active` = 1) >= 5
BEGIN
  SELECT RAISE(ABORT, 'user cap reached (5 active users)');
END;

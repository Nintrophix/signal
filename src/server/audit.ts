import type { DB } from './db/client.js';
import { auditLog } from './db/schema.js';

export type AuditEvent =
  | 'login.success'
  | 'login.failure'
  | 'login.locked'
  | 'logout'
  | 'kite.connect'
  | 'kite.connect.failed'
  | 'kite.expired'
  | 'backfill.start'
  | 'user.created'
  | 'user.disabled'
  | 'user.password_reset';

/** Never pass secrets in `detail`. */
export function audit(db: DB, event: AuditEvent, opts: { userId?: number | null; ip?: string | null; detail?: string } = {}) {
  db.insert(auditLog)
    .values({ event, userId: opts.userId ?? null, ip: opts.ip ?? null, detail: opts.detail ?? null })
    .run();
}

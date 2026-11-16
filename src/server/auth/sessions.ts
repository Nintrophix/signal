import { and, eq, gt, lt } from 'drizzle-orm';
import { randomToken, sha256 } from '../crypto.js';
import type { DB } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { nowS } from '../time.js';

export interface SessionUser {
  sessionId: string;
  userId: number;
  email: string;
  role: 'admin' | 'member';
  csrfToken: string;
  kiteState: string | null;
}

/** Idle timeout on top of the absolute TTL. */
const IDLE_SECONDS = 4 * 3600;

export function createSession(db: DB, userId: number, ttlHours: number): { token: string; csrfToken: string } {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  db.insert(sessions)
    .values({ id: sha256(token), userId, csrfToken, expiresAt: nowS() + Math.round(ttlHours * 3600) })
    .run();
  // Opportunistic cleanup of expired sessions.
  db.delete(sessions).where(lt(sessions.expiresAt, nowS())).run();
  return { token, csrfToken };
}

export function loadSession(db: DB, token: string | undefined): SessionUser | null {
  if (!token || token.length > 128) return null;
  const id = sha256(token);
  const now = nowS();
  const row = db
    .select({
      id: sessions.id,
      userId: users.id,
      email: users.email,
      role: users.role,
      active: users.active,
      csrfToken: sessions.csrfToken,
      kiteState: sessions.kiteState,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
    .get();
  if (!row || !row.active) return null;
  if (row.lastSeenAt + IDLE_SECONDS < now) {
    destroySession(db, id);
    return null;
  }
  if (now - row.lastSeenAt > 60) db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();
  return { sessionId: row.id, userId: row.userId, email: row.email, role: row.role, csrfToken: row.csrfToken, kiteState: row.kiteState };
}

export function destroySession(db: DB, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export function setKiteState(db: DB, sessionId: string, state: string | null): void {
  db.update(sessions).set({ kiteState: state }).where(eq(sessions.id, sessionId)).run();
}

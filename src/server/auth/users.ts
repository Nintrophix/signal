import { hash, verify } from '@node-rs/argon2';
import { count, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { sessions, users, type User } from '../db/schema.js';
import { nowS } from '../time.js';

export const MAX_ACTIVE_USERS = 5;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: Promise<string> | null = null;

export class UserCapError extends Error {
  constructor() {
    super(`User cap reached: at most ${MAX_ACTIVE_USERS} active users are allowed.`);
    this.name = 'UserCapError';
  }
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePassword(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters.';
  if (pw.length > 256) return 'Password is too long.';
  return null;
}

export const hashPassword = (pw: string) => hash(pw, ARGON);

export function activeUserCount(db: DB): number {
  return db.select({ n: count() }).from(users).where(eq(users.active, true)).get()?.n ?? 0;
}

export async function createUser(db: DB, email: string, password: string, role: 'admin' | 'member' = 'member'): Promise<User> {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new Error('Invalid email address.');
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(pwErr);
  const passwordHash = await hashPassword(password);
  return db.transaction((tx) => {
    const n = tx.select({ n: count() }).from(users).where(eq(users.active, true)).get()?.n ?? 0;
    if (n >= MAX_ACTIVE_USERS) throw new UserCapError();
    const existing = tx.select().from(users).where(eq(users.email, e)).get();
    if (existing) throw new Error('A user with that email already exists.');
    return tx.insert(users).values({ email: e, passwordHash, role }).returning().get();
  });
}

export function disableUser(db: DB, email: string): boolean {
  const e = normalizeEmail(email);
  const u = db.select().from(users).where(eq(users.email, e)).get();
  if (!u) return false;
  db.transaction((tx) => {
    tx.update(users).set({ active: false }).where(eq(users.id, u.id)).run();
    tx.delete(sessions).where(eq(sessions.userId, u.id)).run();
  });
  return true;
}

export async function setPassword(db: DB, email: string, password: string): Promise<boolean> {
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(pwErr);
  const u = db.select().from(users).where(eq(users.email, normalizeEmail(email))).get();
  if (!u) return false;
  const passwordHash = await hashPassword(password);
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash, failedAttempts: 0, lockedUntil: null }).where(eq(users.id, u.id)).run();
    tx.delete(sessions).where(eq(sessions.userId, u.id)).run();
  });
  return true;
}

export type LoginResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'locked' };

/**
 * Verifies credentials with per-account lockout. Unknown emails still spend
 * an argon2 verify so response time doesn't reveal which emails exist.
 */
export async function checkLogin(db: DB, email: string, password: string): Promise<LoginResult> {
  const u = db.select().from(users).where(eq(users.email, normalizeEmail(email))).get();
  if (!u || !u.active) {
    dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
    await verify(await dummyHash, password).catch(() => false);
    return { ok: false, reason: 'invalid' };
  }
  const now = nowS();
  if (u.lockedUntil && u.lockedUntil > now) return { ok: false, reason: 'locked' };
  const ok = await verify(u.passwordHash, password).catch(() => false);
  if (!ok) {
    const attempts = u.failedAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    db.update(users)
      .set({ failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? now + LOCKOUT_SECONDS : null })
      .where(eq(users.id, u.id))
      .run();
    return { ok: false, reason: lock ? 'locked' : 'invalid' };
  }
  db.update(users).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: sql`(unixepoch())` }).where(eq(users.id, u.id)).run();
  return { ok: true, user: u };
}

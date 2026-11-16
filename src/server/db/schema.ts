/**
 * Portable schema: integers for unix-second timestamps, text for JSON,
 * real for prices. Translates 1:1 to Postgres (bigint / text / double).
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch())`;

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until'),
  createdAt: integer('created_at').notNull().default(now),
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256(token) — the raw token only ever lives in the cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    csrfToken: text('csrf_token').notNull(),
    kiteState: text('kite_state'),
    createdAt: integer('created_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const kiteTokens = sqliteTable('kite_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** AES-256-GCM ciphertext (iv:tag:data, base64). */
  accessTokenEnc: text('access_token_enc').notNull(),
  kiteUserId: text('kite_user_id'),
  connectedBy: integer('connected_by').references(() => users.id),
  status: text('status', { enum: ['active', 'expired', 'invalid'] }).notNull().default('active'),
  createdAt: integer('created_at').notNull().default(now),
  expiresAt: integer('expires_at').notNull(),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull().default(now),
    userId: integer('user_id'),
    event: text('event').notNull(),
    ip: text('ip'),
    detail: text('detail'),
  },
  (t) => [index('audit_ts_idx').on(t.ts)],
);

export const instruments = sqliteTable(
  'instruments',
  {
    token: integer('token').primaryKey(),
    tradingsymbol: text('tradingsymbol').notNull(),
    name: text('name').notNull(),
    /** YYYY-MM-DD */
    expiry: text('expiry').notNull(),
    strike: real('strike').notNull(),
    type: text('type', { enum: ['CE', 'PE'] }).notNull(),
    fetchedOn: text('fetched_on').notNull(),
  },
  (t) => [index('instruments_lookup_idx').on(t.name, t.expiry, t.strike, t.type)],
);

export const candles = sqliteTable(
  'candles',
  {
    token: integer('token').notNull(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    ts: integer('ts').notNull(),
    o: real('o').notNull(),
    h: real('h').notNull(),
    l: real('l').notNull(),
    c: real('c').notNull(),
    v: real('v').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.token, t.timeframe, t.ts] })],
);

/** One row per evaluated candle window. Makes trigger detection restart-safe. */
export const evaluations = sqliteTable(
  'evaluations',
  {
    timeframe: text('timeframe').notNull(),
    ts: integer('ts').notNull(),
    expiry: text('expiry').notNull(),
    spot: real('spot').notNull(),
    ceStrike: real('ce_strike').notNull(),
    peStrike: real('pe_strike').notNull(),
    ceLow: real('ce_low').notNull(),
    ceHigh: real('ce_high').notNull(),
    peLow: real('pe_low').notNull(),
    peHigh: real('pe_high').notNull(),
    pattern: text('pattern').notNull(),
    direction: text('direction').notNull(),
    signalValue: real('signal_value'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.timeframe, t.ts] })],
);

/** Append-only. UPDATE and DELETE are blocked by triggers (see migrations). */
export const signals = sqliteTable(
  'signals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    timeframe: text('timeframe').notNull(),
    expiry: text('expiry').notNull(),
    spot: real('spot').notNull(),
    ceStrike: real('ce_strike').notNull(),
    peStrike: real('pe_strike').notNull(),
    ceLow: real('ce_low').notNull(),
    ceHigh: real('ce_high').notNull(),
    peLow: real('pe_low').notNull(),
    peHigh: real('pe_high').notNull(),
    pattern: text('pattern').notNull(),
    prevPattern: text('prev_pattern').notNull(),
    direction: text('direction').notNull(),
    signalValue: real('signal_value'),
    rule: text('rule'),
    diff: real('diff'),
    formula: text('formula').notNull(),
    /** JSON: [{value, source, kind}] in sorted order. */
    sorted: text('sorted').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('signals_dedupe_idx').on(t.timeframe, t.ts, t.prevPattern, t.pattern),
    index('signals_ts_idx').on(t.ts),
  ],
);

export type User = typeof users.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;
export type EvaluationRow = typeof evaluations.$inferSelect;

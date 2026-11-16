import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const TIMEFRAMES = ['minute', '3minute', '5minute', '10minute', '15minute', '30minute', '60minute'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_SECONDS: Record<Timeframe, number> = {
  minute: 60,
  '3minute': 180,
  '5minute': 300,
  '10minute': 600,
  '15minute': 900,
  '30minute': 1800,
  '60minute': 3600,
};

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATA_DIR: z.string().default('./data'),
  DATABASE_PATH: z.string().optional(),
  /** Exact public origin, e.g. https://signal.example.com. Used for Origin checks. */
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:8080'),
  TRUST_PROXY: bool(false),
  COOKIE_SECURE: z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  /** 32 random bytes, base64 or hex. Encrypts Kite tokens at rest. */
  TOKEN_ENC_KEY: z.string().min(32).optional(),
  KITE_MODE: z.enum(['live', 'mock']).default('mock'),
  KITE_API_KEY: z.string().optional(),
  KITE_API_SECRET: z.string().optional(),
  TIMEFRAME: z.enum(TIMEFRAMES).default('15minute'),
  LIVE_ENABLED: bool(true),
  BACKUP_DIR: z.string().optional(),
  BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  BACKUP_ENABLED: bool(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema> & { databasePath: string; cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Local convenience: load ./.env if present (never baked into the Docker image).
  if (env === process.env && fs.existsSync('.env')) process.loadEnvFile('.env');
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (!c.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY is required in production');
    if (c.KITE_MODE === 'live' && (!c.KITE_API_KEY || !c.KITE_API_SECRET)) {
      throw new Error('KITE_API_KEY and KITE_API_SECRET are required when KITE_MODE=live');
    }
  }
  return {
    ...c,
    databasePath: c.DATABASE_PATH ?? path.join(c.DATA_DIR, 'signal.db'),
    cookieSecure: c.COOKIE_SECURE ?? c.PUBLIC_ORIGIN.startsWith('https://'),
  };
}

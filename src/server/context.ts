import type { Config } from './config.js';
import { deriveKey, randomToken } from './crypto.js';
import { openDb, type DB } from './db/client.js';
import { MockKiteClient } from './kite/mock.js';
import { RealKiteClient } from './kite/real.js';
import type { MarketDataClient } from './kite/types.js';
import { BackfillJob } from './services/backfill.js';
import { KiteSession } from './services/kiteSession.js';
import { LiveRunner } from './services/live.js';
import { Processor } from './services/processor.js';

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
const silent: Log = { info: () => {}, warn: () => {} };

export function createContext(config: Config, opts: { db?: DB; client?: MarketDataClient; log?: Log } = {}) {
  const db = opts.db ?? openDb(config.databasePath);
  const client =
    opts.client ??
    (config.KITE_MODE === 'live' ? new RealKiteClient(config.KITE_API_KEY ?? '', config.KITE_API_SECRET ?? '') : new MockKiteClient());
  // In dev without TOKEN_ENC_KEY, use an ephemeral key: stored Kite tokens
  // simply won't survive a restart (you'll be asked to reconnect).
  const key = deriveKey(config.TOKEN_ENC_KEY ?? randomToken(32));
  const kite = new KiteSession(db, client, key);
  const processor = new Processor(db, client, undefined, () => kite.markExpired('token rejected by Kite'));
  const live = new LiveRunner(processor, kite, config.TIMEFRAME, opts.log ?? silent);
  const backfill = new BackfillJob(processor, kite);
  kite.restore();
  return { config, db, client, kite, processor, live, backfill };
}

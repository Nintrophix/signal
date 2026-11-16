import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { scheduleBackups } from './services/backup.js';
import { addDays, istDate, nowS } from './time.js';

const config = loadConfig();
const logRef: { log?: FastifyBaseLogger } = {};
const ctx = createContext(config, {
  log: { info: (o, m) => logRef.log?.info(o, m), warn: (o, m) => logRef.log?.warn(o, m) },
});
const app = await buildApp(ctx);
logRef.log = app.log;

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info({ mode: config.KITE_MODE, timeframe: config.TIMEFRAME, kite: ctx.kite.current().status }, 'nifty-signal up');

if (config.LIVE_ENABLED) ctx.live.start();
if (config.BACKUP_ENABLED) {
  scheduleBackups(ctx.db, config.BACKUP_DIR ?? `${config.DATA_DIR}/backups`, config.BACKUP_KEEP, (m) => app.log.info(m));
}

// Make the chart useful before the open: replay the last week on boot.
if (ctx.kite.isConnected()) {
  const today = istDate(nowS());
  void ctx.backfill.start(addDays(today, -7), today, config.TIMEFRAME);
}

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  ctx.live.stop();
  await app.close();
  ctx.db.$client.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

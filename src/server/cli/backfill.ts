/**
 * Replay / backfill from the command line:
 *   npm run backfill -- 2026-11-02 2026-11-13 [15minute]
 * Uses the stored (encrypted) Kite token, or the mock provider in mock mode.
 */
import { loadConfig, TIMEFRAMES, type Timeframe } from '../config.js';
import { createContext } from '../context.js';
import { isDateString } from '../time.js';

const [from, to, tfArg] = process.argv.slice(2);
if (!isDateString(from) || !isDateString(to)) {
  console.error('Usage: npm run backfill -- YYYY-MM-DD YYYY-MM-DD [timeframe]');
  process.exit(1);
}
const config = loadConfig();
const tf = (tfArg && (TIMEFRAMES as readonly string[]).includes(tfArg) ? tfArg : config.TIMEFRAME) as Timeframe;
const ctx = createContext(config);
if (!ctx.kite.isConnected()) {
  console.error('Kite is not connected. Connect it from the app (/connect) first.');
  process.exit(1);
}
await ctx.backfill.start(from, to, tf);
for (const r of ctx.backfill.state.results) {
  console.log(`${r.date}  windows=${r.windows} evaluated=${r.evaluated} skipped=${r.skipped} new=${r.newSignals}${r.note ? `  (${r.note})` : ''}`);
}
if (ctx.backfill.state.lastError) {
  console.error(`Stopped: ${ctx.backfill.state.lastError}`);
  process.exitCode = 1;
}
console.log(`Done. ${ctx.backfill.state.newSignals} new signal(s).`);
ctx.db.$client.close();

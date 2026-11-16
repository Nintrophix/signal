import type { Timeframe } from '../config.js';
import { KiteAuthError, KiteNotConnectedError } from '../kite/types.js';
import { eachDate, isWeekend } from '../time.js';
import type { KiteSession } from './kiteSession.js';
import type { DayResult, Processor } from './processor.js';

export interface BackfillState {
  running: boolean;
  from: string | null;
  to: string | null;
  timeframe: Timeframe | null;
  done: number;
  total: number;
  newSignals: number;
  lastError: string | null;
  results: DayResult[];
}

/** One backfill job at a time, processed day by day (rate limits apply inside the client). */
export class BackfillJob {
  state: BackfillState = { running: false, from: null, to: null, timeframe: null, done: 0, total: 0, newSignals: 0, lastError: null, results: [] };

  constructor(
    private readonly processor: Processor,
    private readonly kite: KiteSession,
  ) {}

  start(from: string, to: string, tf: Timeframe): Promise<void> | null {
    if (this.state.running) return null;
    const days = eachDate(from, to).filter((d) => !isWeekend(d));
    this.state = { running: true, from, to, timeframe: tf, done: 0, total: days.length, newSignals: 0, lastError: null, results: [] };
    return (async () => {
      try {
        for (const d of days) {
          const r = await this.processor.processDay(d, tf);
          this.state.results.push(r);
          this.state.newSignals += r.newSignals;
          this.state.done++;
        }
      } catch (e) {
        if (e instanceof KiteAuthError || e instanceof KiteNotConnectedError) {
          this.kite.markExpired('token rejected during backfill');
          this.state.lastError = 'Kite session expired — reconnect';
        } else {
          this.state.lastError = e instanceof Error ? e.message : String(e);
        }
      } finally {
        this.state.running = false;
      }
    })();
  }
}

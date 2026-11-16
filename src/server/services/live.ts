/**
 * Live mode: after every candle close (+ a small delay so Kite has
 * published the candle) re-process today. Polling historical candles keeps a
 * single, tested code path shared with backfill.
 */
import { TF_SECONDS, type Timeframe } from '../config.js';
import { KiteAuthError, KiteNotConnectedError } from '../kite/types.js';
import { istDate, istToTs, isWeekend, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, nowS } from '../time.js';
import type { KiteSession } from './kiteSession.js';
import type { Processor } from './processor.js';

const SETTLE_S = 8;

export interface LiveState {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  nextRunAt: number | null;
}

export class LiveRunner {
  readonly state: LiveState = { enabled: false, running: false, lastRunAt: null, lastResult: null, lastError: null, nextRunAt: null };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly processor: Processor,
    private readonly kite: KiteSession,
    private readonly tf: Timeframe,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void },
  ) {}

  start(): void {
    this.state.enabled = true;
    void this.tick();
  }

  stop(): void {
    this.state.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Next candle-close boundary (+settle) during market hours, in unix seconds. */
  static nextRun(now: number, tf: Timeframe): number {
    const tfs = TF_SECONDS[tf];
    let date = istDate(now);
    for (let i = 0; i < 10; i++) {
      if (!isWeekend(date)) {
        const open = istToTs(date, MARKET_OPEN_MIN);
        const close = istToTs(date, MARKET_CLOSE_MIN);
        for (let b = open + tfs; b <= close; b += tfs) {
          if (b + SETTLE_S > now) return b + SETTLE_S;
        }
      }
      date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    }
    return now + 3600;
  }

  async runOnce(): Promise<void> {
    if (this.state.running) return;
    if (!this.kite.isConnected()) {
      this.state.lastError = 'Kite not connected';
      return;
    }
    this.state.running = true;
    try {
      const r = await this.processor.processDay(istDate(nowS()), this.tf);
      this.state.lastResult = `${r.evaluated} evaluated, ${r.newSignals} new signal(s)${r.note ? ` — ${r.note}` : ''}`;
      this.state.lastError = null;
      if (r.newSignals) this.log.info({ ...r }, 'live: new signals');
    } catch (e) {
      if (e instanceof KiteAuthError || e instanceof KiteNotConnectedError) {
        this.kite.markExpired('token rejected by Kite');
        this.state.lastError = 'Kite session expired — reconnect';
      } else {
        this.state.lastError = e instanceof Error ? e.message : String(e);
      }
      this.log.warn({ err: this.state.lastError }, 'live run failed');
    } finally {
      this.state.running = false;
      this.state.lastRunAt = nowS();
    }
  }

  private async tick(): Promise<void> {
    if (!this.state.enabled) return;
    await this.runOnce();
    const next = LiveRunner.nextRun(nowS(), this.tf);
    this.state.nextRunAt = next;
    // Cap the sleep so clock drift / sleep-wake can't strand the loop.
    const delayMs = Math.min(Math.max(1, next - nowS()), 3600) * 1000;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }
}

/**
 * Turns market data into evaluations and signals. The same code path serves
 * backfill/replay (past dates) and live mode (today, called after each
 * candle close). All writes are idempotent.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm';
import { TF_SECONDS, type Timeframe } from '../config.js';
import type { DB } from '../db/client.js';
import { candles, evaluations, instruments, signals } from '../db/schema.js';
import { DIRECTION_MAP, type Pattern } from '../signal/config.js';
import { evaluate, isTrigger, selectStrikes } from '../signal/engine.js';
import { KiteAuthError, NIFTY_SPOT_SYMBOL, NIFTY_SPOT_TOKEN, type Candle, type MarketDataClient, type OptionInstrument } from '../kite/types.js';
import { istDate, istToTs, isWeekend, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, nowS } from '../time.js';

export interface DayResult {
  date: string;
  windows: number;
  evaluated: number;
  skipped: number;
  newSignals: number;
  note?: string;
}

export class Processor {
  constructor(
    private readonly db: DB,
    private readonly client: MarketDataClient,
    private readonly clock: () => number = nowS,
    private readonly onAuthError: (e: KiteAuthError) => void = () => {},
  ) {}

  /** Refresh the instruments cache at most once per IST day. */
  async ensureInstruments(): Promise<void> {
    const today = istDate(this.clock());
    const fresh = this.db.select({ t: instruments.token }).from(instruments).where(eq(instruments.fetchedOn, today)).limit(1).get();
    if (fresh) return;
    const list = await this.guard(() => this.client.niftyOptions());
    this.db.transaction((tx) => {
      tx.delete(instruments).run();
      for (let i = 0; i < list.length; i += 500) {
        tx.insert(instruments)
          .values(list.slice(i, i + 500).map((x) => ({ ...x, fetchedOn: today })))
          .run();
      }
    });
  }

  /** Nearest weekly expiry on or after `date`. */
  nearestExpiry(date: string): string | null {
    const row = this.db
      .select({ e: instruments.expiry })
      .from(instruments)
      .where(gte(instruments.expiry, date))
      .orderBy(asc(instruments.expiry))
      .limit(1)
      .get();
    return row?.e ?? null;
  }

  private findOption(expiry: string, strike: number, type: 'CE' | 'PE'): OptionInstrument | undefined {
    return this.db
      .select()
      .from(instruments)
      .where(and(eq(instruments.expiry, expiry), eq(instruments.strike, strike), eq(instruments.type, type)))
      .get() as OptionInstrument | undefined;
  }

  /** Closed candles for one token/day, from cache or Kite. */
  async dayCandles(token: number, symbol: string, tf: Timeframe, date: string): Promise<Candle[]> {
    const tfs = TF_SECONDS[tf];
    const open = istToTs(date, MARKET_OPEN_MIN);
    const close = istToTs(date, MARKET_CLOSE_MIN);
    const now = this.clock();
    const lastClosedStart = Math.min(close, now) - tfs;
    const expected = lastClosedStart >= open ? Math.floor((lastClosedStart - open) / tfs) + 1 : 0;
    if (expected === 0) return [];

    const cached = this.db
      .select()
      .from(candles)
      .where(and(eq(candles.token, token), eq(candles.timeframe, tf), gte(candles.ts, open), lt(candles.ts, close)))
      .orderBy(asc(candles.ts))
      .all();
    if (cached.length >= expected) return cached.map(toCandle);

    const fetched = await this.guard(() => this.client.historical(token, tf, open, close - 1));
    const closed = fetched.filter((c) => c.ts >= open && c.ts + tfs <= Math.min(now, close));
    if (closed.length) {
      this.db.transaction((tx) => {
        for (const c of closed) {
          tx.insert(candles)
            .values({ token, symbol, timeframe: tf, ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })
            .onConflictDoUpdate({ target: [candles.token, candles.timeframe, candles.ts], set: { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v } })
            .run();
        }
      });
    }
    return closed;
  }

  async processDay(date: string, tf: Timeframe): Promise<DayResult> {
    const res: DayResult = { date, windows: 0, evaluated: 0, skipped: 0, newSignals: 0 };
    if (isWeekend(date)) return { ...res, note: 'weekend' };
    if (date > istDate(this.clock())) return { ...res, note: 'future date' };
    await this.ensureInstruments();
    const expiry = this.nearestExpiry(date);
    if (!expiry) return { ...res, note: 'no live expiry covers this date (expired contracts are not in the Kite dump)' };

    const spot = await this.dayCandles(NIFTY_SPOT_TOKEN, NIFTY_SPOT_SYMBOL, tf, date);
    res.windows = spot.length;
    if (!spot.length) return { ...res, note: 'no spot candles (holiday or before first close)' };

    const done = new Set(
      this.db
        .select({ ts: evaluations.ts })
        .from(evaluations)
        .where(and(eq(evaluations.timeframe, tf), inArray(evaluations.ts, spot.map((s) => s.ts))))
        .all()
        .map((r) => r.ts),
    );

    const legCache = new Map<number, Map<number, Candle>>();
    const leg = async (inst: OptionInstrument) => {
      let m = legCache.get(inst.token);
      if (!m) {
        const list = await this.dayCandles(inst.token, inst.tradingsymbol, tf, date);
        m = new Map(list.map((c) => [c.ts, c]));
        legCache.set(inst.token, m);
      }
      return m;
    };

    for (const s of spot) {
      if (done.has(s.ts)) continue;
      const strikes = selectStrikes(s.c);
      const ceInst = this.findOption(expiry, strikes.ce, 'CE');
      const peInst = this.findOption(expiry, strikes.pe, 'PE');
      if (!ceInst || !peInst) {
        res.skipped++;
        continue;
      }
      const ce = (await leg(ceInst)).get(s.ts);
      const pe = (await leg(peInst)).get(s.ts);
      if (!ce || !pe) {
        res.skipped++;
        continue;
      }
      const ev = evaluate({ low: ce.l, high: ce.h }, { low: pe.l, high: pe.h });
      this.db
        .insert(evaluations)
        .values({
          timeframe: tf,
          ts: s.ts,
          expiry,
          spot: s.c,
          ceStrike: strikes.ce,
          peStrike: strikes.pe,
          ceLow: ce.l,
          ceHigh: ce.h,
          peLow: pe.l,
          peHigh: pe.h,
          pattern: ev.pattern,
          direction: ev.direction,
          signalValue: ev.signal.value,
        })
        .onConflictDoNothing()
        .run();
      res.evaluated++;
    }

    res.newSignals = this.deriveSignals(tf, spot[0]!.ts, spot[spot.length - 1]!.ts);
    return res;
  }

  /**
   * Walk stored evaluations in [fromTs, toTs] (seeded by the last directional
   * evaluation before fromTs) and insert a signal on each group flip.
   */
  deriveSignals(tf: Timeframe, fromTs: number, toTs: number): number {
    const seed = this.db
      .select({ pattern: evaluations.pattern })
      .from(evaluations)
      .where(and(eq(evaluations.timeframe, tf), lt(evaluations.ts, fromTs), inArray(evaluations.direction, ['bullish', 'bearish'])))
      .orderBy(desc(evaluations.ts))
      .limit(1)
      .get();
    const rows = this.db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.timeframe, tf), gte(evaluations.ts, fromTs), lte(evaluations.ts, toTs)))
      .orderBy(asc(evaluations.ts))
      .all();

    let last: Pattern | null = (seed?.pattern as Pattern | undefined) ?? null;
    let inserted = 0;
    for (const r of rows) {
      const pattern = r.pattern as Pattern;
      const dir = DIRECTION_MAP[pattern];
      if (last && isTrigger(DIRECTION_MAP[last], dir)) {
        const ev = evaluate({ low: r.ceLow, high: r.ceHigh }, { low: r.peLow, high: r.peHigh });
        const out = this.db
          .insert(signals)
          .values({
            ts: r.ts,
            timeframe: tf,
            expiry: r.expiry,
            spot: r.spot,
            ceStrike: r.ceStrike,
            peStrike: r.peStrike,
            ceLow: r.ceLow,
            ceHigh: r.ceHigh,
            peLow: r.peLow,
            peHigh: r.peHigh,
            pattern,
            prevPattern: last,
            direction: dir,
            signalValue: ev.signal.value,
            rule: ev.signal.rule,
            diff: ev.signal.diff,
            formula: ev.signal.formula,
            sorted: JSON.stringify(ev.sorted),
          })
          .onConflictDoNothing()
          .run();
        inserted += out.changes;
      }
      if (dir !== 'neutral') last = pattern;
    }
    return inserted;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KiteAuthError) this.onAuthError(e);
      throw e;
    }
  }
}

function toCandle(r: typeof candles.$inferSelect): Candle {
  return { ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
}

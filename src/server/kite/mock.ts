/**
 * Deterministic synthetic market for local development, demos and tests.
 * Spot follows a seeded random walk per day; option premiums are
 * intrinsic value + a smooth time value, so CE/PE ranges cross naturally.
 */
import { TF_SECONDS, type Timeframe } from '../config.js';
import { addDays, istDate, istToTs, isWeekend, MARKET_CLOSE_MIN, MARKET_OPEN_MIN, nowS } from '../time.js';
import { KiteAuthError, NIFTY_SPOT_TOKEN, type Candle, type MarketDataClient, type OptionInstrument } from './types.js';

const MOCK_BASE = 900_000_000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Token encodes expiry (day number mod 100), strike and type. */
export function mockToken(strike: number, type: 'CE' | 'PE', expiry: string): number {
  const day = Math.floor(Date.parse(`${expiry}T00:00:00Z`) / 86400_000) % 100;
  return MOCK_BASE + day * 1_000_000 + strike * 10 + (type === 'CE' ? 1 : 2);
}

export class MockKiteClient implements MarketDataClient {
  readonly mode = 'mock' as const;
  private token: string | null = 'mock-token';
  /** Test hook: force the next calls to fail as if the token expired. */
  expired = false;
  private dayCache = new Map<string, number[]>();

  constructor(private readonly clock: () => number = nowS) {}

  loginUrl(state: string): string {
    return `/kite/callback?status=success&request_token=mock-request&state=${encodeURIComponent(state)}`;
  }

  async createSession(requestToken: string) {
    if (!requestToken) throw new KiteAuthError('missing request token');
    this.expired = false;
    return { accessToken: `mock-${Date.now()}`, kiteUserId: 'MOCK01' };
  }

  setAccessToken(token: string | null): void {
    this.token = token;
  }

  hasAccessToken(): boolean {
    return !!this.token;
  }

  async profile() {
    this.guard();
    return { kiteUserId: 'MOCK01' };
  }

  async niftyOptions(): Promise<OptionInstrument[]> {
    this.guard();
    const today = istDate(this.clock());
    // Weekly expiries: next 4 Tuesdays (including today if Tuesday).
    const expiries: string[] = [];
    for (let d = addDays(today, -14); expiries.length < 6; d = addDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === 2) expiries.push(d);
    }
    const out: OptionInstrument[] = [];
    for (const expiry of expiries) {
      for (let strike = 20000; strike <= 28000; strike += 50) {
        for (const type of ['CE', 'PE'] as const) {
          out.push({ token: mockToken(strike, type, expiry), tradingsymbol: `NIFTY${expiry.replaceAll('-', '')}${strike}${type}`, name: 'NIFTY', expiry, strike, type });
        }
      }
    }
    return out;
  }

  async historical(token: number, interval: Timeframe, fromTs: number, toTs: number): Promise<Candle[]> {
    this.guard();
    const tf = TF_SECONDS[interval];
    const out: Candle[] = [];
    const now = this.clock();
    for (let date = istDate(fromTs); date <= istDate(toTs); date = addDays(date, 1)) {
      if (isWeekend(date)) continue;
      const minutes = this.spotMinutes(date);
      const open = istToTs(date, MARKET_OPEN_MIN);
      const close = istToTs(date, MARKET_CLOSE_MIN);
      for (let start = open; start < close; start += tf) {
        if (start < fromTs || start > toTs || start > now) continue;
        const prices: number[] = [];
        for (let m = 0; m < tf / 60; m++) {
          const idx = (start - open) / 60 + m;
          const ts = start + m * 60;
          if (idx >= minutes.length || ts > now) break;
          prices.push(this.priceAt(token, minutes[idx]!, idx, date));
        }
        if (!prices.length) continue;
        out.push({
          ts: start,
          o: r2(prices[0]!),
          h: r2(Math.max(...prices)),
          l: r2(Math.min(...prices)),
          c: r2(prices[prices.length - 1]!),
          v: token === NIFTY_SPOT_TOKEN ? 0 : 1000 + prices.length * 75,
        });
      }
    }
    return out;
  }

  private guard() {
    if (!this.token) throw new KiteAuthError('not connected');
    if (this.expired) throw new KiteAuthError();
  }

  /** 375 one-minute spot prices for a trading day. */
  private spotMinutes(date: string): number[] {
    const hit = this.dayCache.get(date);
    if (hit) return hit;
    const rnd = mulberry32(hash(date));
    const dayIndex = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400_000);
    let p = 24000 + 600 * Math.sin(dayIndex / 23) + 250 * Math.sin(dayIndex / 5.3);
    const drift = (rnd() - 0.5) * 0.6;
    const out: number[] = [];
    for (let i = 0; i < MARKET_CLOSE_MIN - MARKET_OPEN_MIN; i++) {
      p += drift + (rnd() - 0.5) * 9 + 3.5 * Math.sin(i / 17);
      out.push(p);
    }
    this.dayCache.set(date, out);
    return out;
  }

  private priceAt(token: number, spot: number, idx: number, date: string): number {
    if (token === NIFTY_SPOT_TOKEN) return spot;
    const rel = (token - MOCK_BASE) % 1_000_000;
    const strike = Math.floor(rel / 10);
    const isCe = rel % 10 === 1;
    const intrinsic = Math.max(0, isCe ? spot - strike : strike - spot);
    const decay = 1 - idx / 1500;
    const wobble = 6 * Math.sin((idx + (hash(date) % 50)) / (isCe ? 11 : 13));
    const tv = (isCe ? 92 : 84) * decay + wobble;
    return Math.max(0.05, intrinsic + tv);
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

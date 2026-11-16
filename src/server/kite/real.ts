import { KiteConnect } from 'kiteconnect';
import type { Timeframe } from '../config.js';
import { kiteDateTime } from '../time.js';
import { Throttle, withRetry } from './throttle.js';
import { KiteAuthError, KiteNotConnectedError, type Candle, type MarketDataClient, type OptionInstrument } from './types.js';

interface KiteError {
  error_type?: string;
  message?: string;
  status?: string;
}

const errType = (e: unknown) => (e && typeof e === 'object' ? (e as KiteError).error_type : undefined);

function toYmd(d: unknown): string {
  if (d instanceof Date) {
    // Kite expiry dates are date-only; format in IST to avoid off-by-one.
    return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

/**
 * Thin adapter over the official kiteconnect SDK. Only read-only market-data
 * and session methods are called. Order methods are never referenced.
 */
export class RealKiteClient implements MarketDataClient {
  readonly mode = 'live' as const;
  private readonly kc: InstanceType<typeof KiteConnect>;
  private token: string | null = null;
  /** Kite historical API: 3 requests / second. */
  private readonly histThrottle = new Throttle(3);
  /** Everything else: stay well under 10 / second. */
  private readonly apiThrottle = new Throttle(5);

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    this.kc = new KiteConnect({ api_key: apiKey });
  }

  loginUrl(state: string): string {
    const params = new URLSearchParams({ v: '3', api_key: this.apiKey, redirect_params: `state=${state}` });
    return `https://kite.zerodha.com/connect/login?${params.toString()}`;
  }

  async createSession(requestToken: string) {
    const s = await this.call(() => this.kc.generateSession(requestToken, this.apiSecret), false);
    return { accessToken: s.access_token, kiteUserId: s.user_id };
  }

  setAccessToken(token: string | null): void {
    this.token = token;
    this.kc.setAccessToken(token ?? '');
  }

  hasAccessToken(): boolean {
    return !!this.token;
  }

  async profile() {
    const p = await this.call(() => this.kc.getProfile());
    return { kiteUserId: p.user_id };
  }

  async niftyOptions(): Promise<OptionInstrument[]> {
    const all = await this.call(() => this.kc.getInstruments('NFO'));
    return all
      .filter((i) => i.name === 'NIFTY' && i.segment === 'NFO-OPT' && (i.instrument_type === 'CE' || i.instrument_type === 'PE'))
      .map((i) => ({
        token: Number(i.instrument_token),
        tradingsymbol: i.tradingsymbol,
        name: i.name,
        expiry: toYmd(i.expiry),
        strike: Number(i.strike),
        type: i.instrument_type as 'CE' | 'PE',
      }));
  }

  async historical(token: number, interval: Timeframe, fromTs: number, toTs: number): Promise<Candle[]> {
    const rows = await this.call(
      () => this.kc.getHistoricalData(token, interval, kiteDateTime(fromTs), kiteDateTime(toTs)),
      true,
      this.histThrottle,
    );
    return rows.map((r) => ({
      ts: Math.floor(new Date(r.date).getTime() / 1000),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume ?? 0,
    }));
  }

  private async call<T>(fn: () => Promise<T>, needsToken = true, throttle = this.apiThrottle): Promise<T> {
    if (needsToken && !this.token) throw new KiteNotConnectedError();
    try {
      return await withRetry(() => throttle.run(fn), {
        retries: 4,
        baseMs: 500,
        // Retry network blips and 429s; never retry auth or input errors.
        isRetryable: (e) => {
          const t = errType(e);
          return t === 'NetworkException' || t === 'GeneralException' || t === undefined;
        },
      });
    } catch (e) {
      if (errType(e) === 'TokenException') throw new KiteAuthError();
      const message = e && typeof e === 'object' && 'message' in e ? String((e as KiteError).message) : String(e);
      throw new Error(`Kite API error (${errType(e) ?? "unknown"}): ${message}`, { cause: e });
    }
  }
}

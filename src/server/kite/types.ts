/**
 * Read-only market-data interface. This is the ONLY surface the app uses.
 * It deliberately exposes no order, GTT, margin or portfolio methods.
 */
import type { Timeframe } from '../config.js';

export const NIFTY_SPOT_TOKEN = 256265; // NSE:NIFTY 50
export const NIFTY_SPOT_SYMBOL = 'NIFTY 50';

export interface OptionInstrument {
  token: number;
  tradingsymbol: string;
  name: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  type: 'CE' | 'PE';
}

export interface Candle {
  ts: number; // unix seconds, candle open time
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MarketDataClient {
  readonly mode: 'live' | 'mock';
  /** Login URL with a CSRF state round-tripped via redirect_params. */
  loginUrl(state: string): string;
  /** Exchange request_token → access_token. */
  createSession(requestToken: string): Promise<{ accessToken: string; kiteUserId: string }>;
  setAccessToken(token: string | null): void;
  hasAccessToken(): boolean;
  /** Cheap authenticated call, used to verify a token. */
  profile(): Promise<{ kiteUserId: string }>;
  /** NIFTY index options from the NFO instruments dump. */
  niftyOptions(): Promise<OptionInstrument[]>;
  historical(token: number, interval: Timeframe, fromTs: number, toTs: number): Promise<Candle[]>;
}

export class KiteAuthError extends Error {
  constructor(message = 'Kite session expired or invalid') {
    super(message);
    this.name = 'KiteAuthError';
  }
}

export class KiteNotConnectedError extends Error {
  constructor() {
    super('Kite is not connected');
    this.name = 'KiteNotConnectedError';
  }
}

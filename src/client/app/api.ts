export type Pattern = 'CCPP' | 'PPCC' | 'CPCP' | 'PCPC' | 'CPPC' | 'PCCP';
export type Direction = 'bullish' | 'bearish' | 'neutral';

export interface SortedPoint {
  value: number;
  source: 'C' | 'P';
  kind: 'low' | 'high';
}

export interface Signal {
  id: number;
  ts: number;
  timeframe: string;
  expiry: string;
  spot: number;
  ceStrike: number;
  peStrike: number;
  ceLow: number;
  ceHigh: number;
  peLow: number;
  peHigh: number;
  pattern: Pattern;
  prevPattern: Pattern;
  direction: Direction;
  signalValue: number | null;
  rule: 'cross' | 'average' | null;
  diff: number | null;
  formula: string;
  sorted: SortedPoint[];
}

export interface Evaluation {
  timeframe: string;
  ts: number;
  expiry: string;
  spot: number;
  ceStrike: number;
  peStrike: number;
  ceLow: number;
  ceHigh: number;
  peLow: number;
  peHigh: number;
  pattern: Pattern;
  direction: Direction;
  signalValue: number | null;
}

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Me {
  email: string;
  role: 'admin' | 'member';
  csrfToken: string;
}

export interface Status {
  kite: { status: 'connected' | 'expired' | 'disconnected'; connectedAt: number | null; expiresAt: number | null; mode: 'live' | 'mock' };
  live: { enabled: boolean; running: boolean; lastRunAt: number | null; lastResult: string | null; lastError: string | null; nextRunAt: number | null };
  backfill: {
    running: boolean;
    from: string | null;
    to: string | null;
    timeframe: string | null;
    done: number;
    total: number;
    newSignals: number;
    lastError: string | null;
    results: Array<{ date: string; windows: number; evaluated: number; skipped: number; newSignals: number; note?: string }>;
  };
  timeframe: string;
  lastEvaluation: { ts: number; pattern: Pattern; direction: Direction } | null;
  rules: { strikeStep: number; threshold: number; crossValueMode: string; directions: Record<Pattern, Direction> };
  serverTime: number;
}

export interface Meta {
  timeframes: string[];
  defaultTimeframe: string;
  expiries: string[];
  firstDate: string | null;
  lastDate: string | null;
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'signed out');
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, b.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

const qs = (p: Record<string, string | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  return u.toString();
};

export interface RangeParams {
  tf?: string;
  from?: string;
  to?: string;
}
export interface SignalParams extends RangeParams {
  pattern?: string;
  direction?: string;
  expiry?: string;
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  status: () => request<Status>('GET', '/api/status'),
  meta: () => request<Meta>('GET', '/api/meta'),
  candles: (p: RangeParams) => request<Candle[]>('GET', `/api/candles?${qs({ ...p })}`),
  evaluations: (p: RangeParams) => request<Evaluation[]>('GET', `/api/evaluations?${qs({ ...p })}`),
  signals: (p: SignalParams) => request<Signal[]>('GET', `/api/signals?${qs({ ...p })}`),
  csvUrl: (p: SignalParams) => `/api/signals.csv?${qs({ ...p })}`,
  backfill: (from: string, to: string, tf: string) => request<{ ok: true }>('POST', '/api/backfill', { from, to, tf }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
};

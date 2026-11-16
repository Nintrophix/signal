/** IST helpers. India has no DST, so a fixed +05:30 offset is exact. */
export const IST_OFFSET_S = 5.5 * 3600;
export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30

export const nowS = () => Math.floor(Date.now() / 1000);

/** 'YYYY-MM-DD' (IST) for a unix-second timestamp. */
export function istDate(ts: number): string {
  return new Date((ts + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
}

/** Unix seconds for an IST wall-clock time on a given IST date. */
export function istToTs(date: string, minutesOfDay: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 1000 + minutesOfDay * 60 - IST_OFFSET_S;
}

/** Kite expects 'YYYY-MM-DD HH:mm:ss' in IST. */
export function kiteDateTime(ts: number): string {
  return new Date((ts + IST_OFFSET_S) * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`).getTime() + n * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isDateString(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** Kite access tokens expire at 06:00 IST the next morning. */
export function nextKiteExpiry(fromTs: number): number {
  const today = istDate(fromTs);
  const sixToday = istToTs(today, 6 * 60);
  return fromTs < sixToday ? sixToday : istToTs(addDays(today, 1), 6 * 60);
}

const IST = 19800;

/** Shift a unix-second timestamp so the chart's UTC axis reads IST. */
export const toChartTime = (ts: number) => ts + IST;
export const fromChartTime = (t: number) => t - IST;

export function istParts(ts: number) {
  const iso = new Date((ts + IST) * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(date: string): string {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
export function fmtDateTime(ts: number): string {
  const p = istParts(ts);
  return `${fmtDay(p.date)} · ${p.time}`;
}
export function fmtShort(ts: number): string {
  const p = istParts(ts);
  const [, m, d] = p.date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${p.time}`;
}

export const fmtNum = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtInt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

export const todayIst = () => istParts(Math.floor(Date.now() / 1000)).date;
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}

export const tfLabel = (tf: string) => (tf === 'minute' ? '1m' : tf.replace('minute', 'm'));

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

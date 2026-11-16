/**
 * Pure signal engine. No I/O, no clock, no globals beyond config constants.
 * Everything here is deterministic and unit-tested.
 */
import {
  CROSS_VALUE_MODE,
  DIRECTION_MAP,
  INTERLEAVED,
  SIGNAL_THRESHOLD,
  STRIKE_STEP,
  type CrossValueMode,
  type Direction,
  type Pattern,
} from './config.js';

export type Source = 'C' | 'P';
export type Kind = 'low' | 'high';

export interface SortedPoint {
  value: number;
  source: Source;
  kind: Kind;
}

export interface LegRange {
  low: number;
  high: number;
}

export interface Strikes {
  ce: number;
  pe: number;
}

export interface SignalValueResult {
  /** null for non-interleaved patterns. */
  value: number | null;
  /** The two middle values in sorted order (only for interleaved). */
  middle: [number, number] | null;
  diff: number | null;
  rule: 'cross' | 'average' | null;
  /** Human readable formula, shown in the UI. */
  formula: string;
}

export interface Evaluation {
  sorted: SortedPoint[];
  pattern: Pattern;
  direction: Direction;
  signal: SignalValueResult;
}

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * ITM strikes. CE = highest strike <= spot. PE = lowest strike >= spot.
 * When spot sits exactly on a strike both legs use that strike.
 */
export function selectStrikes(spot: number, step: number = STRIKE_STEP): Strikes {
  if (!isFiniteNumber(spot) || spot <= 0) throw new RangeError(`invalid spot: ${spot}`);
  if (!isFiniteNumber(step) || step <= 0) throw new RangeError(`invalid step: ${step}`);
  // Round to cents first so float noise (e.g. 22549.999999) doesn't shift strikes.
  const s = Math.round(spot * 100) / 100;
  return { ce: Math.floor(s / step) * step, pe: Math.ceil(s / step) * step };
}

/**
 * Deterministic order: ascending by value; ties broken by source (C before P),
 * then by kind (low before high).
 */
export function sortPoints(ce: LegRange, pe: LegRange): SortedPoint[] {
  for (const [name, r] of [['CE', ce], ['PE', pe]] as const) {
    if (!r || !isFiniteNumber(r.low) || !isFiniteNumber(r.high)) {
      throw new RangeError(`missing ${name} high/low`);
    }
    if (r.low > r.high) throw new RangeError(`${name} low > high`);
  }
  const pts: SortedPoint[] = [
    { value: ce.low, source: 'C', kind: 'low' },
    { value: ce.high, source: 'C', kind: 'high' },
    { value: pe.low, source: 'P', kind: 'low' },
    { value: pe.high, source: 'P', kind: 'high' },
  ];
  const srcRank = (s: Source) => (s === 'C' ? 0 : 1);
  const kindRank = (k: Kind) => (k === 'low' ? 0 : 1);
  return pts.sort(
    (a, b) => a.value - b.value || srcRank(a.source) - srcRank(b.source) || kindRank(a.kind) - kindRank(b.kind),
  );
}

export function patternOf(sorted: SortedPoint[]): Pattern {
  return sorted.map((p) => p.source).join('') as Pattern;
}

export function directionOf(pattern: Pattern): Direction {
  return DIRECTION_MAP[pattern];
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function signalValue(
  sorted: SortedPoint[],
  threshold: number = SIGNAL_THRESHOLD,
  mode: CrossValueMode = CROSS_VALUE_MODE,
): SignalValueResult {
  const pattern = patternOf(sorted);
  if (!INTERLEAVED.includes(pattern)) {
    return { value: null, middle: null, diff: null, rule: null, formula: `${pattern}: no signal value (not interleaved)` };
  }
  const a = sorted[1]!;
  const b = sorted[2]!;
  const v1 = a.value;
  const v2 = b.value;
  const diff = Math.abs(v1 - v2);
  const avg = (v1 + v2) / 2;
  // Compare with a tiny epsilon so 20.0000000001 from float maths still counts as 20.
  if (diff <= threshold + 1e-9) {
    let value = avg;
    if (mode === 'call') value = a.source === 'C' ? v1 : v2;
    if (mode === 'put') value = a.source === 'P' ? v1 : v2;
    return {
      value: round2(value),
      middle: [v1, v2],
      diff: round2(diff),
      rule: 'cross',
      formula: `|${fmt(v1)} − ${fmt(v2)}| = ${fmt(round2(diff))} ≤ ${threshold} → cross value (${mode}) = ${fmt(round2(value))}`,
    };
  }
  return {
    value: round2(avg),
    middle: [v1, v2],
    diff: round2(diff),
    rule: 'average',
    formula: `|${fmt(v1)} − ${fmt(v2)}| = ${fmt(round2(diff))} > ${threshold} → (${fmt(v1)} + ${fmt(v2)}) / 2 = ${fmt(round2(avg))}`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Evaluate one candle window. Throws RangeError on missing / invalid data. */
export function evaluate(ce: LegRange, pe: LegRange, threshold?: number, mode?: CrossValueMode): Evaluation {
  const sorted = sortPoints(ce, pe);
  const pattern = patternOf(sorted);
  return { sorted, pattern, direction: directionOf(pattern), signal: signalValue(sorted, threshold, mode) };
}

/** Same as evaluate, but returns null instead of throwing for missing data. */
export function tryEvaluate(ce: LegRange | null | undefined, pe: LegRange | null | undefined): Evaluation | null {
  if (!ce || !pe) return null;
  try {
    return evaluate(ce, pe);
  } catch {
    return null;
  }
}

/**
 * Trigger: fires when the directional group flips. Neutral patterns are
 * transparent: `lastDirection` should be the last non-neutral direction seen.
 * Returns true only for bullish↔bearish flips; the first directional
 * evaluation (no history) does not fire.
 */
export function isTrigger(lastDirection: Direction | null, current: Direction): boolean {
  if (current === 'neutral') return false;
  if (lastDirection === null || lastDirection === 'neutral') return false;
  return lastDirection !== current;
}

export interface SequenceInput {
  ts: number;
  ce: LegRange | null;
  pe: LegRange | null;
}

export interface SequenceSignal {
  ts: number;
  evaluation: Evaluation;
  prevPattern: Pattern;
}

/**
 * Run a series of windows and return the signals. `seed` is the last
 * directional pattern seen before the series (for restart continuity).
 */
export function runSequence(inputs: SequenceInput[], seed: Pattern | null = null): SequenceSignal[] {
  const out: SequenceSignal[] = [];
  let last: Pattern | null = seed && directionOf(seed) !== 'neutral' ? seed : null;
  for (const inp of [...inputs].sort((a, b) => a.ts - b.ts)) {
    const ev = tryEvaluate(inp.ce, inp.pe);
    if (!ev) continue;
    if (last && isTrigger(directionOf(last), ev.direction)) {
      out.push({ ts: inp.ts, evaluation: ev, prevPattern: last });
    }
    if (ev.direction !== 'neutral') last = ev.pattern;
  }
  return out;
}

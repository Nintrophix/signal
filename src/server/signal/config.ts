/**
 * Signal configuration. Every rule constant lives here so that it can be
 * changed in exactly one place.
 */

export type Pattern = 'CCPP' | 'PPCC' | 'CPCP' | 'PCPC' | 'CPPC' | 'PCCP';
export type Direction = 'bullish' | 'bearish' | 'neutral';

/** Strike step for Nifty options. */
export const STRIKE_STEP = 50;

/**
 * |v1 - v2| <= this → "cross value" rule, otherwise the average rule.
 * The comparison is inclusive: a diff of exactly 20 uses the cross value.
 */
export const SIGNAL_THRESHOLD = 20;

/**
 * What "the cross value" means when the two middle values are within the
 * threshold. 'average' (default) is (v1 + v2) / 2, which equals either value
 * when the diff is 0. 'call' / 'put' pick the middle value from that leg.
 */
export type CrossValueMode = 'average' | 'call' | 'put';
export const CROSS_VALUE_MODE: CrossValueMode = 'average';

/**
 * Direction mapping. The source rules define CCPP/CPCP as bullish and
 * PPCC/PCPC as bearish. CPPC (put range inside call range) and PCCP (call
 * range inside put range) are not covered by the source doc; they are
 * treated as neutral: recorded, but they neither fire nor reset a signal.
 */
export const DIRECTION_MAP: Record<Pattern, Direction> = {
  CCPP: 'bullish',
  CPCP: 'bullish',
  PPCC: 'bearish',
  PCPC: 'bearish',
  CPPC: 'neutral',
  PCCP: 'neutral',
};

/** Patterns whose two middle values are one C and one P. */
export const INTERLEAVED: readonly Pattern[] = ['CPCP', 'PCPC'];

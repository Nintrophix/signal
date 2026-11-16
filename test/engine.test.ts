import { describe, expect, it } from 'vitest';
import {
  evaluate,
  isTrigger,
  patternOf,
  runSequence,
  selectStrikes,
  signalValue,
  sortPoints,
  tryEvaluate,
} from '../src/server/signal/engine.js';

describe('strike selection', () => {
  it('worked example: spot 22515 → 22500 CE / 22550 PE', () => {
    expect(selectStrikes(22515)).toEqual({ ce: 22500, pe: 22550 });
  });
  it('spot exactly on a strike uses that strike for both legs', () => {
    expect(selectStrikes(22500)).toEqual({ ce: 22500, pe: 22500 });
  });
  it('handles float noise near a boundary', () => {
    expect(selectStrikes(22549.999999)).toEqual({ ce: 22550, pe: 22550 });
    expect(selectStrikes(22549.99)).toEqual({ ce: 22500, pe: 22550 });
  });
  it('rejects invalid spot', () => {
    expect(() => selectStrikes(NaN)).toThrow(RangeError);
    expect(() => selectStrikes(0)).toThrow(RangeError);
  });
});

describe('worked example (source doc)', () => {
  const ev = evaluate({ low: 102, high: 202 }, { low: 85, high: 165 });
  it('sorts 85(P) 102(C) 165(P) 202(C)', () => {
    expect(ev.sorted.map((p) => `${p.value}${p.source}`)).toEqual(['85P', '102C', '165P', '202C']);
  });
  it('pattern is PCPC (doc label CPCP is wrong)', () => {
    expect(ev.pattern).toBe('PCPC');
    expect(ev.direction).toBe('bearish');
  });
  it('diff 63 > 20 → average 133.5', () => {
    expect(ev.signal.middle).toEqual([102, 165]);
    expect(ev.signal.diff).toBe(63);
    expect(ev.signal.rule).toBe('average');
    expect(ev.signal.value).toBe(133.5);
  });
});

describe('patterns', () => {
  it('CCPP', () => expect(evaluate({ low: 10, high: 20 }, { low: 30, high: 40 }).pattern).toBe('CCPP'));
  it('PPCC', () => expect(evaluate({ low: 30, high: 40 }, { low: 10, high: 20 }).pattern).toBe('PPCC'));
  it('CPCP', () => expect(evaluate({ low: 10, high: 30 }, { low: 20, high: 40 }).pattern).toBe('CPCP'));
  it('PCPC', () => expect(evaluate({ low: 20, high: 40 }, { low: 10, high: 30 }).pattern).toBe('PCPC'));
  it('CPPC (put inside call) is neutral', () => {
    const ev = evaluate({ low: 10, high: 40 }, { low: 20, high: 30 });
    expect(ev.pattern).toBe('CPPC');
    expect(ev.direction).toBe('neutral');
    expect(ev.signal.value).toBeNull();
  });
  it('PCCP (call inside put) is neutral', () => {
    expect(evaluate({ low: 20, high: 30 }, { low: 10, high: 40 }).pattern).toBe('PCCP');
  });
  it('non-interleaved patterns have no signal value', () => {
    expect(evaluate({ low: 10, high: 20 }, { low: 30, high: 40 }).signal.value).toBeNull();
  });
});

describe('ties are deterministic (C before P, then low before high)', () => {
  it('CE low == PE low', () => {
    const s = sortPoints({ low: 100, high: 150 }, { low: 100, high: 200 });
    expect(patternOf(s)).toBe('CPCP');
  });
  it('CE high == PE low', () => {
    const s = sortPoints({ low: 50, high: 100 }, { low: 100, high: 150 });
    expect(patternOf(s)).toBe('CCPP');
  });
  it('PE high == CE low → P high sorts after C low', () => {
    const s = sortPoints({ low: 100, high: 150 }, { low: 50, high: 100 });
    expect(patternOf(s)).toBe('PCPC');
  });
  it('all four equal', () => {
    const s = sortPoints({ low: 5, high: 5 }, { low: 5, high: 5 });
    expect(patternOf(s)).toBe('CCPP');
  });
  it('is independent of input object order', () => {
    const a = sortPoints({ low: 100, high: 150 }, { low: 100, high: 150 });
    const b = sortPoints({ high: 150, low: 100 }, { high: 150, low: 100 });
    expect(a).toEqual(b);
  });
});

describe('signal value', () => {
  it('diff exactly 20 → cross value (average) ', () => {
    const ev = evaluate({ low: 100, high: 200 }, { low: 80, high: 120 });
    expect(ev.pattern).toBe('PCPC');
    expect(ev.signal.diff).toBe(20);
    expect(ev.signal.rule).toBe('cross');
    expect(ev.signal.value).toBe(110);
  });
  it('diff 20.01 → average rule', () => {
    const ev = evaluate({ low: 100, high: 200 }, { low: 80, high: 120.01 });
    expect(ev.signal.rule).toBe('average');
  });
  it('diff 0 → cross value equals the value', () => {
    // C low 100, P low 100 → CPCP with middle P low? use distinct: P low 90, C low 100, P high 100, C high 150
    const ev = evaluate({ low: 100, high: 150 }, { low: 90, high: 100 });
    expect(ev.pattern).toBe('PCPC');
    expect(ev.signal.diff).toBe(0);
    expect(ev.signal.value).toBe(100);
  });
  it('call / put cross modes pick that leg', () => {
    const sorted = sortPoints({ low: 100, high: 200 }, { low: 80, high: 110 });
    expect(signalValue(sorted, 20, 'call').value).toBe(100);
    expect(signalValue(sorted, 20, 'put').value).toBe(110);
  });
  it('threshold is configurable', () => {
    const sorted = sortPoints({ low: 102, high: 202 }, { low: 85, high: 165 });
    expect(signalValue(sorted, 100).rule).toBe('cross');
  });
  it('formula string is human readable', () => {
    expect(evaluate({ low: 102, high: 202 }, { low: 85, high: 165 }).signal.formula).toContain('133.5');
  });
});

describe('missing / invalid data', () => {
  it('throws for NaN', () => expect(() => evaluate({ low: NaN, high: 1 }, { low: 1, high: 2 })).toThrow(RangeError));
  it('throws for low > high', () => expect(() => evaluate({ low: 5, high: 1 }, { low: 1, high: 2 })).toThrow(RangeError));
  it('tryEvaluate returns null for missing legs', () => {
    expect(tryEvaluate(null, { low: 1, high: 2 })).toBeNull();
    expect(tryEvaluate({ low: 1, high: 2 }, undefined)).toBeNull();
  });
});

describe('trigger', () => {
  it('fires on bearish → bullish and bullish → bearish', () => {
    expect(isTrigger('bearish', 'bullish')).toBe(true);
    expect(isTrigger('bullish', 'bearish')).toBe(true);
  });
  it('does not fire within the same group', () => {
    expect(isTrigger('bullish', 'bullish')).toBe(false);
    expect(isTrigger('bearish', 'bearish')).toBe(false);
  });
  it('does not fire without history or on neutral', () => {
    expect(isTrigger(null, 'bullish')).toBe(false);
    expect(isTrigger('bullish', 'neutral')).toBe(false);
  });

  const bull = { ce: { low: 10, high: 30 }, pe: { low: 20, high: 40 } }; // CPCP
  const bear = { ce: { low: 20, high: 40 }, pe: { low: 10, high: 30 } }; // PCPC
  const bull2 = { ce: { low: 10, high: 20 }, pe: { low: 30, high: 40 } }; // CCPP
  const neutral = { ce: { low: 10, high: 40 }, pe: { low: 20, high: 30 } }; // CPPC

  it('sequence: PCPC → PCPC → CPCP → CCPP → PCPC fires twice', () => {
    const s = runSequence([
      { ts: 1, ...bear },
      { ts: 2, ...bear },
      { ts: 3, ...bull },
      { ts: 4, ...bull2 },
      { ts: 5, ...bear },
    ]);
    expect(s.map((x) => [x.ts, x.prevPattern, x.evaluation.pattern])).toEqual([
      [3, 'PCPC', 'CPCP'],
      [5, 'CCPP', 'PCPC'],
    ]);
  });
  it('neutral patterns are transparent', () => {
    const s = runSequence([
      { ts: 1, ...bear },
      { ts: 2, ...neutral },
      { ts: 3, ...bull },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]!.prevPattern).toBe('PCPC');
  });
  it('missing windows are skipped', () => {
    const s = runSequence([
      { ts: 1, ...bear },
      { ts: 2, ce: null, pe: null },
      { ts: 3, ...bull },
    ]);
    expect(s).toHaveLength(1);
  });
  it('seed continues from a previous run', () => {
    expect(runSequence([{ ts: 9, ...bull }], 'PPCC')).toHaveLength(1);
    expect(runSequence([{ ts: 9, ...bull }], null)).toHaveLength(0);
  });
});

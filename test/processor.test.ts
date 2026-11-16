import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/server/db/client.js';
import { evaluations, signals } from '../src/server/db/schema.js';
import { MockKiteClient } from '../src/server/kite/mock.js';
import { KiteAuthError } from '../src/server/kite/types.js';
import { LiveRunner } from '../src/server/services/live.js';
import { Processor } from '../src/server/services/processor.js';
import { istToTs } from '../src/server/time.js';

// Fixed clock: Wed 2026-11-11 16:00 IST (after close).
const CLOCK = istToTs('2026-11-11', 16 * 60);
let db: DB;

afterEach(() => db?.$client.close());

function setup(clock = CLOCK) {
  db = openDb(':memory:');
  const client = new MockKiteClient(() => clock);
  return { client, p: new Processor(db, client, () => clock) };
}

describe('processor (mock Kite)', () => {
  it('backfills a day: evaluations for every 15m window, some signals', async () => {
    const { p } = setup();
    const r = await p.processDay('2026-11-11', '15minute');
    expect(r.windows).toBe(25);
    expect(r.evaluated).toBe(25);
    expect(db.select().from(evaluations).all()).toHaveLength(25);
    const sigs = db.select().from(signals).all();
    expect(sigs.length).toBe(r.newSignals);
    for (const s of sigs) {
      expect(['bullish', 'bearish']).toContain(s.direction);
      expect(s.prevPattern).not.toBe(s.pattern);
      if (s.pattern === 'CPCP' || s.pattern === 'PCPC') expect(s.signalValue).not.toBeNull();
    }
  });

  it('replay over several days produces signals', async () => {
    const { p } = setup();
    let total = 0;
    for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) total += (await p.processDay(d, '15minute')).newSignals;
    expect(total).toBeGreaterThan(0);
  });

  it('is idempotent: re-running a day adds nothing', async () => {
    const { p } = setup();
    await p.processDay('2026-11-11', '15minute');
    const before = db.select().from(signals).all().length;
    const again = await p.processDay('2026-11-11', '15minute');
    expect(again.evaluated).toBe(0);
    expect(again.newSignals).toBe(0);
    expect(db.select().from(signals).all()).toHaveLength(before);
  });

  it('live mid-day only evaluates closed candles', async () => {
    const midday = istToTs('2026-11-11', 10 * 60 + 20); // 10:20 → 09:15..09:45 closed + 10:00 open? 10:00-10:15 closed
    const { p } = setup(midday);
    const r = await p.processDay('2026-11-11', '15minute');
    expect(r.windows).toBe(4); // 09:15, 09:30, 09:45, 10:00
  });

  it('skips weekends and future dates', async () => {
    const { p } = setup();
    expect((await p.processDay('2026-11-08', '15minute')).note).toBe('weekend');
    expect((await p.processDay('2026-11-20', '15minute')).note).toBe('future date');
  });

  it('signals table is append-only', async () => {
    const { p } = setup();
    for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) await p.processDay(d, '15minute');
    expect(() => db.$client.prepare('DELETE FROM signals').run()).toThrow(/append-only/);
    expect(() => db.$client.prepare('UPDATE signals SET pattern = 1').run()).toThrow(/append-only/);
  });

  it('surfaces Kite auth errors via the callback', async () => {
    const { client } = setup();
    let called = false;
    const p = new Processor(db, client, () => CLOCK, () => (called = true));
    client.expired = true;
    await expect(p.processDay('2026-11-11', '15minute')).rejects.toBeInstanceOf(KiteAuthError);
    expect(called).toBe(true);
  });
});

describe('live scheduling', () => {
  it('next run is the next 15m close + settle', () => {
    const t = istToTs('2026-11-11', 9 * 60 + 31);
    expect(LiveRunner.nextRun(t, '15minute')).toBe(istToTs('2026-11-11', 9 * 60 + 45) + 8);
  });
  it('after close rolls to next trading day (skips weekend)', () => {
    const fri = istToTs('2026-11-13', 16 * 60);
    expect(LiveRunner.nextRun(fri, '15minute')).toBe(istToTs('2026-11-16', 9 * 60 + 30) + 8);
  });
});

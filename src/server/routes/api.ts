import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { audit } from '../audit.js';
import { TIMEFRAMES } from '../config.js';
import { candles, evaluations, signals, type SignalRow } from '../db/schema.js';
import { NIFTY_SPOT_TOKEN } from '../kite/types.js';
import { DIRECTION_MAP, SIGNAL_THRESHOLD, CROSS_VALUE_MODE, STRIKE_STEP } from '../signal/config.js';
import { addDays, istDate, istToTs, isDateString, nowS } from '../time.js';

const dateStr = z.string().refine(isDateString, 'expected YYYY-MM-DD');
const PATTERNS = ['CCPP', 'PPCC', 'CPCP', 'PCPC', 'CPPC', 'PCCP'] as const;

const RangeQuery = z.object({
  tf: z.enum(TIMEFRAMES).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

const SignalQuery = RangeQuery.extend({
  pattern: z.enum(PATTERNS).optional(),
  direction: z.enum(['bullish', 'bearish']).optional(),
  expiry: dateStr.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

const BackfillBody = z.object({ from: dateStr, to: dateStr, tf: z.enum(TIMEFRAMES).optional() });

export const apiRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db, config } = deps;

    const range = (q: z.infer<typeof RangeQuery>) => {
      const today = istDate(nowS());
      const to = q.to ?? today;
      const from = q.from ?? addDays(to, -6);
      return { tf: q.tf ?? config.TIMEFRAME, fromTs: istToTs(from, 0), toTs: istToTs(addDays(to, 1), 0), from, to };
    };

    const signalWhere = (q: z.infer<typeof SignalQuery>) => {
      const r = range(q);
      const conds: SQL[] = [eq(signals.timeframe, r.tf), gte(signals.ts, r.fromTs), lt(signals.ts, r.toTs)];
      if (q.pattern) conds.push(eq(signals.pattern, q.pattern));
      if (q.direction) conds.push(eq(signals.direction, q.direction));
      if (q.expiry) conds.push(eq(signals.expiry, q.expiry));
      return and(...conds);
    };

    app.get('/api/status', async () => {
      const last = db
        .select({ ts: evaluations.ts, pattern: evaluations.pattern, direction: evaluations.direction })
        .from(evaluations)
        .where(eq(evaluations.timeframe, config.TIMEFRAME))
        .orderBy(desc(evaluations.ts))
        .limit(1)
        .get();
      return {
        kite: deps.kite.current(),
        live: deps.live.state,
        backfill: { ...deps.backfill.state, results: deps.backfill.state.results.slice(-10) },
        timeframe: config.TIMEFRAME,
        lastEvaluation: last ?? null,
        rules: { strikeStep: STRIKE_STEP, threshold: SIGNAL_THRESHOLD, crossValueMode: CROSS_VALUE_MODE, directions: DIRECTION_MAP },
        serverTime: nowS(),
      };
    });

    app.get('/api/meta', async () => {
      const tfs = db.selectDistinct({ tf: evaluations.timeframe }).from(evaluations).all().map((r) => r.tf);
      const expiries = db.selectDistinct({ e: evaluations.expiry }).from(evaluations).orderBy(desc(evaluations.expiry)).all().map((r) => r.e);
      const bounds = db
        .select({ min: sql<number | null>`min(${evaluations.ts})`, max: sql<number | null>`max(${evaluations.ts})` })
        .from(evaluations)
        .get();
      return {
        timeframes: tfs.length ? tfs : [config.TIMEFRAME],
        defaultTimeframe: config.TIMEFRAME,
        expiries,
        firstDate: bounds?.min ? istDate(bounds.min) : null,
        lastDate: bounds?.max ? istDate(bounds.max) : null,
      };
    });

    app.get('/api/candles', async (req, reply) => {
      const q = RangeQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad query' });
      const r = range(q.data);
      return db
        .select({ ts: candles.ts, o: candles.o, h: candles.h, l: candles.l, c: candles.c })
        .from(candles)
        .where(and(eq(candles.token, NIFTY_SPOT_TOKEN), eq(candles.timeframe, r.tf), gte(candles.ts, r.fromTs), lt(candles.ts, r.toTs)))
        .orderBy(asc(candles.ts))
        .all();
    });

    app.get('/api/evaluations', async (req, reply) => {
      const q = RangeQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad query' });
      const r = range(q.data);
      return db
        .select()
        .from(evaluations)
        .where(and(eq(evaluations.timeframe, r.tf), gte(evaluations.ts, r.fromTs), lt(evaluations.ts, r.toTs)))
        .orderBy(asc(evaluations.ts))
        .all()
        .map(({ createdAt: _c, ...rest }) => rest);
    });

    app.get('/api/signals', async (req, reply) => {
      const q = SignalQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad query' });
      return db.select().from(signals).where(signalWhere(q.data)).orderBy(desc(signals.ts)).limit(q.data.limit).all().map(present);
    });

    app.get('/api/signals.csv', async (req, reply) => {
      const q = SignalQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'bad query' });
      const rows = db.select().from(signals).where(signalWhere(q.data)).orderBy(asc(signals.ts)).limit(q.data.limit).all();
      const cols = ['id', 'time_ist', 'timeframe', 'expiry', 'spot', 'ce_strike', 'pe_strike', 'ce_low', 'ce_high', 'pe_low', 'pe_high', 'prev_pattern', 'pattern', 'direction', 'signal_value', 'rule', 'diff'];
      const lines = [cols.join(',')];
      for (const s of rows) {
        lines.push(
          [s.id, istTime(s.ts), s.timeframe, s.expiry, s.spot, s.ceStrike, s.peStrike, s.ceLow, s.ceHigh, s.peLow, s.peHigh, s.prevPattern, s.pattern, s.direction, s.signalValue ?? '', s.rule ?? '', s.diff ?? '']
            .map(csvCell)
            .join(','),
        );
      }
      const r = range(q.data);
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="signals_${r.from}_${r.to}_${r.tf}.csv"`)
        .send(lines.join('\r\n') + '\r\n');
    });

    app.get('/api/signals/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad id' });
      const row = db.select().from(signals).where(eq(signals.id, id)).get();
      if (!row) return reply.code(404).send({ error: 'not found' });
      return present(row);
    });

    app.post('/api/backfill', async (req, reply) => {
      if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
      const b = BackfillBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'from and to (YYYY-MM-DD) are required' });
      if (b.data.from > b.data.to) return reply.code(400).send({ error: 'from must be on or before to' });
      if (istToTs(b.data.to, 0) - istToTs(b.data.from, 0) > 120 * 86400) return reply.code(400).send({ error: 'max 120 days per backfill' });
      if (!deps.kite.isConnected()) return reply.code(409).send({ error: 'Kite is not connected' });
      const started = deps.backfill.start(b.data.from, b.data.to, b.data.tf ?? config.TIMEFRAME);
      if (!started) return reply.code(409).send({ error: 'a backfill is already running' });
      audit(db, 'backfill.start', { userId: req.user!.userId, ip: req.ip, detail: `${b.data.from}..${b.data.to}` });
      return reply.code(202).send({ ok: true });
    });
  };

function present(s: SignalRow) {
  return { ...s, sorted: JSON.parse(s.sorted) as unknown };
}

function istTime(ts: number): string {
  return new Date((ts + 19800) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** CSV cell with formula-injection protection. */
function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

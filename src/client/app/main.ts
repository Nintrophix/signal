import '../shared/tokens.css';
import './styles.css';
import { applyStoredTheme, toggleTheme } from '../shared/theme.js';
import { api, setCsrf, type Me, type Meta, type Signal, type Status } from './api.js';
import { SignalChart } from './chart.js';
import { addDays, el, fmtDateTime, fmtDay, tfLabel, todayIst } from './format.js';
import { SignalPanel } from './panel.js';
import { renderTable } from './table.js';

applyStoredTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface State {
  me: Me | null;
  meta: Meta | null;
  status: Status | null;
  from: string;
  to: string;
  tf: string;
  expiry: string;
  pattern: string;
  direction: string;
  signals: Signal[];
  lastEvalTs: number | null;
}

const url = new URL(location.href);
const state: State = {
  me: null,
  meta: null,
  status: null,
  to: url.searchParams.get('to') ?? todayIst(),
  from: url.searchParams.get('from') ?? addDays(todayIst(), -4),
  tf: url.searchParams.get('tf') ?? '',
  expiry: url.searchParams.get('expiry') ?? '',
  pattern: url.searchParams.get('pattern') ?? '',
  direction: url.searchParams.get('direction') ?? '',
  signals: [],
  lastEvalTs: null,
};

let chart: SignalChart | null = null;
let panel: SignalPanel;

async function boot() {
  panel = new SignalPanel($('panel'));
  panel.onNavigate = (d) => step(d);

  $('theme').addEventListener('click', () => toggleTheme());
  $('logout').addEventListener('click', async () => {
    await api.logout().catch(() => undefined);
    location.href = '/login';
  });

  document.querySelectorAll<HTMLAnchorElement>('[data-route]').forEach((a) =>
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      history.pushState(null, '', a.getAttribute('href'));
      route();
    }),
  );
  window.addEventListener('popstate', route);

  const me = await api.me();
  state.me = me;
  setCsrf(me.csrfToken);
  const [meta, status] = await Promise.all([api.meta(), api.status()]);
  state.meta = meta;
  state.status = status;
  state.tf ||= meta.defaultTimeframe;
  state.lastEvalTs = status.lastEvaluation?.ts ?? null;
  // If there's no data in the default window yet but there is history, jump to it.
  if (!url.searchParams.has('to') && meta.lastDate && meta.lastDate < addDays(state.to, -4)) {
    state.to = meta.lastDate;
    state.from = addDays(meta.lastDate, -4);
  }

  renderStatus();
  initToolbar();
  route();
  setInterval(poll, 30_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void poll());
}

function route() {
  const isConnect = location.pathname === '/connect';
  $('view-chart').hidden = isConnect;
  $('view-connect').hidden = !isConnect;
  document.querySelectorAll<HTMLAnchorElement>('[data-route]').forEach((a) => {
    if (a.dataset.route === (isConnect ? '/connect' : '/')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (isConnect) {
    panel.close();
    renderConnect();
  } else {
    chart ??= new SignalChart($('chart'));
    chart.onSignalClick((s) => openSignal(s));
    void loadChart();
  }
}

// ── Toolbar ────────────────────────────────────────────────────────────────
function initToolbar() {
  const from = $<HTMLInputElement>('from');
  const to = $<HTMLInputElement>('to');
  const tf = $<HTMLSelectElement>('tf');
  const expiry = $<HTMLSelectElement>('expiry');
  const fp = $<HTMLSelectElement>('f-pattern');
  const fd = $<HTMLSelectElement>('f-direction');

  from.value = state.from;
  to.value = state.to;
  to.max = todayIst();
  from.max = todayIst();
  tf.replaceChildren(...(state.meta?.timeframes ?? [state.tf]).map((t) => el('option', { value: t, selected: t === state.tf }, tfLabel(t))));
  expiry.replaceChildren(
    el('option', { value: '' }, 'All'),
    ...(state.meta?.expiries ?? []).map((e) => el('option', { value: e, selected: e === state.expiry }, fmtDay(e))),
  );
  fp.value = state.pattern;
  fd.value = state.direction;

  const changed = () => {
    state.from = from.value || state.from;
    state.to = to.value || state.to;
    if (state.from > state.to) [state.from, state.to] = [state.to, state.from];
    state.tf = tf.value;
    state.expiry = expiry.value;
    state.pattern = fp.value;
    state.direction = fd.value;
    syncUrl();
    void loadChart();
  };
  for (const c of [from, to, tf, expiry, fp, fd]) c.addEventListener('change', changed);

  document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const days = Number(b.dataset.range);
      to.value = state.meta?.lastDate && state.meta.lastDate < todayIst() ? state.meta.lastDate : todayIst();
      from.value = addDays(to.value, -(days === 1 ? 0 : days - 1));
      changed();
    }),
  );
}

function syncUrl() {
  const u = new URL(location.href);
  for (const k of ['from', 'to', 'tf', 'expiry', 'pattern', 'direction'] as const) {
    const v = state[k];
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  history.replaceState(null, '', u);
}

// ── Data ───────────────────────────────────────────────────────────────────
let loadSeq = 0;
async function loadChart() {
  const seq = ++loadSeq;
  const range = { from: state.from, to: state.to, tf: state.tf };
  const filters = { ...range, expiry: state.expiry, pattern: state.pattern, direction: state.direction };
  $('chart').setAttribute('aria-busy', 'true');
  try {
    const [candles, evals, all, filtered] = await Promise.all([
      api.candles(range),
      api.evaluations(range),
      api.signals({ ...range, expiry: state.expiry }),
      api.signals(filters),
    ]);
    if (seq !== loadSeq) return;
    chart?.setData(candles, state.expiry ? evals.filter((e) => e.expiry === state.expiry) : evals, all);
    $('chart-empty').hidden = candles.length > 0;
    state.signals = filtered;
    $('count').textContent = filtered.length ? String(filtered.length) : '';
    renderTable($('rows'), filtered, panel.signal?.id ?? null, (s) => openSignal(s, true));
    ($('csv') as HTMLAnchorElement).href = api.csvUrl(filters);
  } catch (e) {
    showBanner(`Couldn't load data: ${e instanceof Error ? e.message : 'unknown error'}`);
  } finally {
    $('chart').removeAttribute('aria-busy');
  }
}

function openSignal(s: Signal, fromTable = false) {
  panel.show(s);
  if (fromTable) chart?.focus(s);
  document.querySelectorAll('#rows tr').forEach((tr) => tr.setAttribute('aria-selected', String((tr as HTMLElement).dataset.id === String(s.id))));
}

function step(dir: 1 | -1) {
  const list = [...state.signals].sort((a, b) => a.ts - b.ts);
  const cur = panel.signal;
  if (!cur || !list.length) return;
  const i = list.findIndex((s) => s.id === cur.id);
  const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
  if (next && next.id !== cur.id) {
    openSignal(next);
    chart?.focus(next);
  }
}

async function poll() {
  try {
    const status = await api.status();
    state.status = status;
    renderStatus();
    if (location.pathname === '/connect') renderConnect();
    const ts = status.lastEvaluation?.ts ?? null;
    if (ts !== state.lastEvalTs) {
      state.lastEvalTs = ts;
      state.meta = await api.meta();
      if (location.pathname !== '/connect' && state.to >= todayIst()) void loadChart();
    }
  } catch {
    /* transient; next poll will retry */
  }
}

// ── Status / banner ────────────────────────────────────────────────────────
function renderStatus() {
  const s = state.status;
  if (!s) return;
  const k = s.kite;
  const node = $('kite-status');
  const label = k.status === 'connected' ? (k.mode === 'mock' ? 'Mock data' : 'Kite live') : k.status === 'expired' ? 'Kite expired' : 'Kite offline';
  node.replaceChildren(el('i', { class: `led ${k.status}`, 'aria-hidden': 'true' }), el('span', {}, label));
  node.title = s.live.lastResult ?? '';

  if (k.status !== 'connected') {
    const isAdmin = state.me?.role === 'admin';
    showBanner(
      k.status === 'expired' ? 'Kite session expired. Live signals are paused.' : 'Kite is not connected. Live signals are paused.',
      isAdmin ? { href: '/kite/connect', text: 'Reconnect Kite' } : { text: 'Ask an admin to reconnect.' },
    );
  } else if (s.live.lastError) {
    showBanner(`Live update failed: ${s.live.lastError}`);
  } else {
    hideBanner();
  }
}

function showBanner(msg: string, action?: { href?: string; text: string }) {
  const b = $('banner');
  b.replaceChildren(el('span', {}, msg));
  if (action) b.append(action.href ? el('a', { href: action.href }, `${action.text} →`) : el('span', { class: 'muted' }, action.text));
  b.hidden = false;
}
const hideBanner = () => ($('banner').hidden = true);

// ── Connect view ───────────────────────────────────────────────────────────
let connectInit = false;
function renderConnect() {
  const s = state.status;
  if (!s) return;
  const isAdmin = state.me?.role === 'admin';
  const k = s.kite;

  const row = (a: string, b: Node | string) => [el('dt', {}, a), el('dd', {}, b)];
  $('kite-kv').replaceChildren(
    ...row('Status', el('span', { class: 'status' }, el('i', { class: `led ${k.status}`, 'aria-hidden': 'true' }), k.status)),
    ...row('Source', k.mode === 'mock' ? 'Mock market (KITE_MODE=mock)' : 'Kite Connect (read-only)'),
    ...row('Connected', k.connectedAt ? el('span', { class: 'num' }, fmtDateTime(k.connectedAt)) : '—'),
    ...row('Expires', k.expiresAt ? el('span', { class: 'num' }, fmtDateTime(k.expiresAt)) : '—'),
    ...row('Live', s.live.enabled ? `on · ${tfLabel(s.timeframe)} candles` : 'off'),
    ...row('Next check', s.live.nextRunAt ? el('span', { class: 'num' }, fmtDateTime(s.live.nextRunAt)) : '—'),
    ...row('Last run', s.live.lastResult ?? s.live.lastError ?? '—'),
  );
  $('kite-actions').replaceChildren(
    isAdmin
      ? el('a', { class: 'btn primary', href: '/kite/connect' }, k.status === 'connected' ? 'Reconnect Kite' : 'Connect Kite')
      : el('p', { class: 'muted' }, 'Only an admin can connect Kite.'),
  );

  const result = new URLSearchParams(location.search).get('kite');
  if (result && !connectInit) {
    const msg: Record<string, string> = {
      ok: 'Kite connected. Catching up on today’s candles.',
      state: 'That login link was stale or not started here. Try again.',
      denied: 'Kite login was cancelled.',
      error: 'Kite rejected the login. Check the API key and secret, then try again.',
    };
    showBanner(msg[result] ?? 'Done.');
    history.replaceState(null, '', '/connect');
  }

  // Rules
  const d = s.rules.directions;
  const group = (dir: string) => Object.entries(d).filter(([, v]) => v === dir).map(([p]) => p).join(', ');
  $('rules').replaceChildren(
    el('li', {}, `Strikes: ITM CE = highest ${s.rules.strikeStep}-pt strike ≤ spot; ITM PE = lowest strike ≥ spot; nearest weekly expiry.`),
    el('li', {}, 'For each candle, sort CE low, CE high, PE low, PE high ascending and label each C or P. Ties: C before P, then low before high.'),
    el('li', {}, `Signal value (CPCP / PCPC only): if the two middle values differ by ≤ ${s.rules.threshold}, the cross value (${s.rules.crossValueMode}); otherwise their average.`),
    el('li', {}, `Bullish: ${group('bullish')}. Bearish: ${group('bearish')}. Neutral (ignored for triggers): ${group('neutral')}.`),
    el('li', {}, 'A signal fires when the group flips between bullish and bearish, evaluated on each candle close.'),
  );

  // Backfill form
  const bfFrom = $<HTMLInputElement>('bf-from');
  const bfTo = $<HTMLInputElement>('bf-to');
  const bfTf = $<HTMLSelectElement>('bf-tf');
  const go = $<HTMLButtonElement>('bf-go');
  if (!connectInit) {
    connectInit = true;
    bfTo.value = todayIst();
    bfFrom.value = addDays(todayIst(), -14);
    bfTo.max = bfFrom.max = todayIst();
    bfTf.replaceChildren(
      ...['5minute', '15minute', '30minute', '60minute'].map((t) => el('option', { value: t, selected: t === s.timeframe }, tfLabel(t))),
    );
    $('backfill').addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        await api.backfill(bfFrom.value, bfTo.value, bfTf.value);
        await poll();
      } catch (err) {
        showBanner(`Backfill: ${err instanceof Error ? err.message : 'failed'}`);
      } finally {
        go.disabled = false;
      }
    });
  }
  go.disabled = !isAdmin || s.backfill.running || k.status !== 'connected';
  go.title = !isAdmin ? 'Admin only' : '';

  const b = s.backfill;
  const prog = $('bf-progress');
  if (b.total) {
    prog.hidden = false;
    const pct = Math.round((b.done / b.total) * 100);
    (prog.querySelector('.bar i') as HTMLElement).style.width = `${pct}%`;
    $('bf-text').textContent = b.running
      ? `${b.from} → ${b.to} · ${b.done}/${b.total} days · ${b.newSignals} new signal(s)`
      : b.lastError
        ? `Stopped: ${b.lastError}`
        : `Done: ${b.from} → ${b.to} · ${b.total} trading days · ${b.newSignals} new signal(s)`;
  }
}

void boot().catch((e) => {
  if (!(e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 401)) {
    showBanner('Something went wrong while loading. Refresh to try again.');
  }
});

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cssVar } from '../shared/theme.js';
import type { Candle, Evaluation, Signal } from './api.js';
import { fmtNum, fromChartTime, istParts, toChartTime } from './format.js';

const t = (ts: number) => toChartTime(ts) as UTCTimestamp;
const SEGMENT_BARS = 4;

/**
 * Two panes:
 *  1. Nifty 50 candles (monochrome), with a marker per stored signal.
 *  2. Premium: ITM CE high/low (accent, solid) and PE high/low (ink, dashed)
 *     with a short segment at each signal value, labelled with the value.
 * Premium (~100s) and spot (~24,000) can't share a scale, hence the panes.
 */
export class SignalChart {
  private chart: IChartApi;
  private candles: ISeriesApi<'Candlestick'>;
  private ceHigh: ISeriesApi<'Line'>;
  private ceLow: ISeriesApi<'Line'>;
  private peHigh: ISeriesApi<'Line'>;
  private peLow: ISeriesApi<'Line'>;
  /** Carries the value markers; never draws a line. */
  private segments: ISeriesApi<'Line'>;
  private segPool: ISeriesApi<'Line'>[] = [];
  private candleMarkers: ISeriesMarkersPluginApi<Time>;
  private segmentMarkers: ISeriesMarkersPluginApi<Time>;
  private signals: Signal[] = [];
  private evals: Evaluation[] = [];
  private bars: Candle[] = [];
  private onSelect: (s: Signal) => void = () => {};
  private ro: ResizeObserver;

  constructor(private readonly host: HTMLElement) {
    this.chart = createChart(host, {
      autoSize: true,
      layout: { attributionLogo: false, fontFamily: cssVar('--font-mono'), fontSize: 11, panes: { separatorColor: 'transparent', enableResize: false } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4, minBarSpacing: 2 },
      localization: {
        priceFormatter: (p: number) => fmtNum(p),
        timeFormatter: (time: Time) => {
          const p = istParts(fromChartTime(time as number));
          return `${p.date} ${p.time}`;
        },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    this.candles = this.chart.addSeries(CandlestickSeries, { priceLineVisible: false, lastValueVisible: true, title: 'NIFTY 50' }, 0);
    const lineOpts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    this.ceHigh = this.chart.addSeries(LineSeries, { ...lineOpts, title: 'CE H' }, 1);
    this.ceLow = this.chart.addSeries(LineSeries, { ...lineOpts, title: 'CE L' }, 1);
    this.peHigh = this.chart.addSeries(LineSeries, { ...lineOpts, lineStyle: LineStyle.Dashed, title: 'PE H' }, 1);
    this.peLow = this.chart.addSeries(LineSeries, { ...lineOpts, lineStyle: LineStyle.Dashed, title: 'PE L' }, 1);
    this.segments = this.chart.addSeries(LineSeries, { ...lineOpts, lineVisible: false }, 1);
    this.candleMarkers = createSeriesMarkers(this.candles, []);
    this.segmentMarkers = createSeriesMarkers(this.segments, []);

    const panes = this.chart.panes();
    panes[0]?.setStretchFactor(0.62);
    panes[1]?.setStretchFactor(0.38);

    this.applyTheme();
    window.addEventListener('themechange', () => this.applyTheme());

    this.chart.subscribeClick((param) => {
      const id = param.hoveredObjectId;
      let sig = typeof id === 'string' ? this.signals.find((s) => `s${s.id}` === id || `v${s.id}` === id) : undefined;
      if (!sig && param.time !== undefined) {
        const ts = fromChartTime(param.time as number);
        sig = this.signals.find((s) => s.ts === ts);
      }
      if (sig) this.onSelect(sig);
    });

    // Re-fit on container changes (panel open/close etc.).
    this.ro = new ResizeObserver(() => this.chart.timeScale().applyOptions({}));
    this.ro.observe(host);
  }

  onSignalClick(fn: (s: Signal) => void) {
    this.onSelect = fn;
  }

  setData(bars: Candle[], evals: Evaluation[], signals: Signal[]) {
    this.bars = bars;
    this.evals = evals;
    this.signals = [...signals].sort((a, b) => a.ts - b.ts);

    this.candles.setData(bars.map((b) => ({ time: t(b.ts), open: b.o, high: b.h, low: b.l, close: b.c })));
    this.ceHigh.setData(evals.map((e) => ({ time: t(e.ts), value: e.ceHigh })));
    this.ceLow.setData(evals.map((e) => ({ time: t(e.ts), value: e.ceLow })));
    this.peHigh.setData(evals.map((e) => ({ time: t(e.ts), value: e.peHigh })));
    this.peLow.setData(evals.map((e) => ({ time: t(e.ts), value: e.peLow })));
    this.renderSignals();
    this.chart.timeScale().fitContent();
  }

  /** Centre the view on a signal (used by table rows and keyboard nav). */
  focus(sig: Signal) {
    const idx = this.bars.findIndex((b) => b.ts === sig.ts);
    if (idx < 0) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const width = range ? range.to - range.from : 60;
    this.chart.timeScale().setVisibleLogicalRange({ from: idx - width / 2, to: idx + width / 2 });
  }

  isEmpty() {
    return this.bars.length === 0;
  }

  private renderSignals() {
    const bull = cssVar('--bull');
    const bear = cssVar('--bear');
    const evalTimes = this.evals.map((e) => e.ts);

    const markers: SeriesMarker<Time>[] = this.signals.map((s) => {
      const isBull = s.direction === 'bullish';
      return {
        id: `s${s.id}`,
        time: t(s.ts),
        position: isBull ? 'belowBar' : 'aboveBar',
        shape: isBull ? 'arrowUp' : 'arrowDown',
        color: isBull ? bull : bear,
        text: s.pattern,
        size: 0.9,
      };
    });
    this.candleMarkers.setMarkers(markers);

    // Signal-value segments: a pooled line series per segment (no joining).
    const segMarkers: SeriesMarker<Time>[] = [];
    const starts = this.signals.map((s) => evalTimes.indexOf(s.ts));
    let used = 0;
    this.signals.forEach((s, i) => {
      const start = starts[i]!;
      if (s.signalValue === null || start < 0) return;
      const color = s.direction === 'bullish' ? bull : bear;
      const nextStart = starts.slice(i + 1).find((x) => x >= 0) ?? Infinity;
      const end = Math.max(start, Math.min(start + SEGMENT_BARS - 1, nextStart - 1, evalTimes.length - 1));
      const pts: LineData<Time>[] = [];
      for (let k = start; k <= end; k++) pts.push({ time: t(evalTimes[k]!), value: s.signalValue });
      const series = this.segmentSeries(used++);
      series.applyOptions({ color });
      series.setData(pts);
      segMarkers.push({
        id: `v${s.id}`,
        time: t(s.ts),
        position: 'atPriceTop',
        price: s.signalValue,
        shape: 'circle',
        color,
        text: fmtNum(s.signalValue),
        size: 0.5,
      });
    });
    for (let k = used; k < this.segPool.length; k++) this.segPool[k]!.setData([]);
    // Invisible carrier for the value markers (markers need a data point).
    this.segments.setData(
      this.signals
        .filter((s) => s.signalValue !== null && evalTimes.includes(s.ts))
        .map((s) => ({ time: t(s.ts), value: s.signalValue! })),
    );
    this.segmentMarkers.setMarkers(segMarkers);
  }

  private segmentSeries(i: number): ISeriesApi<'Line'> {
    while (this.segPool.length <= i) {
      this.segPool.push(
        this.chart.addSeries(
          LineSeries,
          { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: false },
          1,
        ),
      );
    }
    return this.segPool[i]!;
  }

  private applyTheme() {
    const ink = cssVar('--ink');
    const ink2 = cssVar('--ink-2');
    const ink3 = cssVar('--ink-3');
    const line = cssVar('--line');
    const accent = cssVar('--accent');
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: ink3 },
      grid: { vertLines: { visible: false }, horzLines: { color: line, style: LineStyle.Solid } },
      crosshair: {
        vertLine: { color: ink3, labelBackgroundColor: ink, style: LineStyle.Dotted, width: 1 },
        horzLine: { color: ink3, labelBackgroundColor: ink, style: LineStyle.Dotted, width: 1 },
      },
    });
    // Monochrome candles: green/red are reserved for signal direction.
    this.candles.applyOptions({
      upColor: 'rgba(0,0,0,0)',
      downColor: ink2,
      borderUpColor: ink2,
      borderDownColor: ink2,
      wickUpColor: ink2,
      wickDownColor: ink2,
    });
    this.ceHigh.applyOptions({ color: accent });
    this.ceLow.applyOptions({ color: accent });
    this.peHigh.applyOptions({ color: ink2 });
    this.peLow.applyOptions({ color: ink2 });
    if (this.signals.length) this.renderSignals();
  }

  destroy() {
    this.ro.disconnect();
    this.chart.remove();
  }
}

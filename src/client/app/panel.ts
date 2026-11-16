import type { Signal } from './api.js';
import { constellation } from './constellation.js';
import { el, fmtDateTime, fmtDay, fmtInt, fmtNum } from './format.js';

/** Right-hand detail drawer for one signal row. */
export class SignalPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private returnFocus: HTMLElement | null = null;
  private current: Signal | null = null;
  onNavigate: (dir: 1 | -1) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    const close = el('button', { class: 'icon-btn panel-close', type: 'button', 'aria-label': 'Close details' }, closeIcon());
    close.addEventListener('click', () => this.close());
    this.body = el('div', { class: 'panel-body' });
    root.append(close, this.body);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        this.onNavigate(1);
      }
      if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        this.onNavigate(-1);
      }
    });
  }

  get open() {
    return this.root.dataset.open === 'true';
  }

  get signal() {
    return this.current;
  }

  show(s: Signal) {
    if (!this.open) this.returnFocus = document.activeElement as HTMLElement | null;
    this.current = s;
    this.render(s);
    this.root.dataset.open = 'true';
    this.root.removeAttribute('inert');
    document.body.dataset.panel = 'open';
    (this.root.querySelector('.panel-close') as HTMLButtonElement).focus({ preventScroll: true });
  }

  close() {
    if (!this.open) return;
    this.root.dataset.open = 'false';
    this.root.setAttribute('inert', '');
    document.body.dataset.panel = 'closed';
    this.current = null;
    this.returnFocus?.focus({ preventScroll: true });
  }

  private render(s: Signal) {
    const dirClass = s.direction === 'bullish' ? 'bull' : 'bear';
    const seq = el('ol', { class: 'seq' });
    for (const p of s.sorted) {
      seq.append(
        el(
          'li',
          {},
          el('span', { class: `dot ${p.source === 'C' ? 'c' : 'p'}`, 'aria-hidden': 'true' }),
          el('span', { class: 'num' }, fmtNum(p.value)),
          el('span', { class: 'seq-src' }, `${p.source === 'C' ? 'CE' : 'PE'} ${p.kind}`),
        ),
      );
    }

    const row = (k: string, v: Node | string) => [el('dt', {}, k), el('dd', {}, v)];
    const dl = el(
      'dl',
      { class: 'kv' },
      ...row('Nifty spot', el('span', { class: 'num' }, fmtNum(s.spot))),
      ...row('Strikes', el('span', { class: 'num' }, `${fmtInt(s.ceStrike)} CE · ${fmtInt(s.peStrike)} PE`)),
      ...row('Expiry', fmtDay(s.expiry)),
      ...row('CE low / high', el('span', { class: 'num' }, `${fmtNum(s.ceLow)} / ${fmtNum(s.ceHigh)}`)),
      ...row('PE low / high', el('span', { class: 'num' }, `${fmtNum(s.peLow)} / ${fmtNum(s.peHigh)}`)),
      ...row('Flip', el('span', { class: 'num' }, `${s.prevPattern} → ${s.pattern}`)),
      ...row('Timeframe', s.timeframe.replace('minute', ' min')),
    );

    this.body.replaceChildren(
      el('p', { class: 'eyebrow' }, el('time', { datetime: new Date(s.ts * 1000).toISOString() }, fmtDateTime(s.ts))),
      el(
        'div',
        { class: 'panel-head' },
        el('h2', { class: 'num pattern' }, s.pattern),
        el('span', { class: `pill ${dirClass}` }, s.direction),
      ),
      el('div', { class: 'panel-cst' }, constellation(s.sorted, { width: 280, height: 120, r: 5, labels: true })),
      el(
        'div',
        { class: 'value-block' },
        el('span', { class: 'label' }, 'Signal value'),
        el('span', { class: `num big ${s.signalValue === null ? '' : dirClass}` }, s.signalValue === null ? '—' : fmtNum(s.signalValue)),
      ),
      el('p', { class: 'formula num' }, s.formula),
      el('h3', {}, 'Sorted sequence'),
      seq,
      el('h3', {}, 'Details'),
      dl,
      el('p', { class: 'hint' }, 'Use ↑ ↓ to step through signals · Esc to close'),
    );
  }
}

function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  p.setAttribute('class', 'stroke');
  svg.append(p);
  return svg;
}

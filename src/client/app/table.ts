import type { Signal } from './api.js';
import { constellation } from './constellation.js';
import { el, fmtInt, fmtNum, fmtShort } from './format.js';

/** Plain, accessible history table. Each row is a button-like row. */
export function renderTable(tbody: HTMLTableSectionElement, rows: Signal[], selectedId: number | null, onPick: (s: Signal) => void) {
  if (!rows.length) {
    tbody.replaceChildren(el('tr', { class: 'empty' }, el('td', { colspan: 8 }, 'No signals match these filters.')));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of rows) {
    const dir = s.direction === 'bullish' ? 'bull' : 'bear';
    const tr = el(
      'tr',
      { tabindex: 0, 'data-id': s.id, 'aria-selected': selectedId === s.id ? 'true' : 'false' },
      el('td', { class: 'num' }, fmtShort(s.ts)),
      el('td', { class: 'pattern-cell' }, constellation(s.sorted), el('span', { class: 'num' }, s.pattern)),
      el('td', {}, el('span', { class: `dir ${dir}` }, el('span', { class: 'tick', 'aria-hidden': 'true' }), s.direction)),
      el('td', { class: 'num r strong' }, fmtNum(s.signalValue)),
      el('td', { class: 'num r hide-sm' }, fmtNum(s.spot)),
      el('td', { class: 'num r hide-sm' }, `${fmtInt(s.ceStrike)} / ${fmtInt(s.peStrike)}`),
      el('td', { class: 'num r hide-md' }, `${fmtNum(s.ceLow)}–${fmtNum(s.ceHigh)}`),
      el('td', { class: 'num r hide-md' }, `${fmtNum(s.peLow)}–${fmtNum(s.peHigh)}`),
    );
    const pick = () => onPick(s);
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    frag.append(tr);
  }
  tbody.replaceChildren(frag);
}

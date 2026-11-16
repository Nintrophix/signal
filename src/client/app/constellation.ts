import type { SortedPoint } from './api.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The signature mark: the four sorted values as a tiny constellation.
 * x = sort order, y = relative value. C is a filled accent dot, P a hollow
 * ring, so the pattern reads without relying on colour.
 */
export function constellation(sorted: SortedPoint[], opts: { width?: number; height?: number; r?: number; labels?: boolean } = {}): SVGSVGElement {
  const { width = 46, height = 18, r = 2.6, labels = false } = opts;
  const padX = labels ? 36 : r + 1.5;
  const padTop = labels ? 18 : r + 1.5;
  const padBottom = labels ? 18 : r + 1.5;
  const vals = sorted.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => padX + (i * (width - 2 * padX)) / 3;
  const y = (v: number) => height - padBottom - ((v - min) / span) * (height - padTop - padBottom);

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('class', 'constellation');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Sorted values: ${sorted.map((p) => `${p.value} ${p.source === 'C' ? 'call' : 'put'} ${p.kind}`).join(', ')}`,
  );

  const path = document.createElementNS(SVG, 'polyline');
  path.setAttribute('points', sorted.map((p, i) => `${x(i)},${y(p.value)}`).join(' '));
  path.setAttribute('class', 'cst-line');
  svg.append(path);

  sorted.forEach((p, i) => {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', String(x(i)));
    c.setAttribute('cy', String(y(p.value)));
    c.setAttribute('r', String(r));
    c.setAttribute('class', p.source === 'C' ? 'cst-c' : 'cst-p');
    svg.append(c);
    if (labels) {
      const t = document.createElementNS(SVG, 'text');
      t.setAttribute('x', String(x(i)));
      const above = i % 2 === 1;
      t.setAttribute('y', String(above ? y(p.value) - r - 6 : y(p.value) + r + 13));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'cst-label');
      t.textContent = `${p.value.toFixed(p.value % 1 ? 2 : 0)} ${p.source}`;
      svg.append(t);
    }
  });
  return svg;
}

/** Text-only pattern with C/P marks, for screen readers and copy. */
export function patternGlyphs(pattern: string): string {
  return pattern
    .split('')
    .map((ch) => (ch === 'C' ? '●' : '○'))
    .join('');
}

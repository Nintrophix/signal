export type Theme = 'light' | 'dark';
const KEY = 'signal.theme';

function read(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function applyStoredTheme(): void {
  const t = read();
  if (t) document.documentElement.dataset.theme = t;
}

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode: fine */
  }
  window.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  return next;
}

/** Fire on OS scheme changes too, so the chart can re-read CSS variables. */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!read()) window.dispatchEvent(new CustomEvent('themechange', { detail: currentTheme() }));
});

export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export const fmt = (n: number | string | null | undefined) => (n == null || n === '' ? '–' : Number(n).toLocaleString('en-US'));

export function pct(part: number, whole: number): string {
  if (!whole) return '–';
  const p = (100 * part) / whole;
  return `${p < 1 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

export function ago(d: Date | string | null | undefined): string {
  if (!d) return 'never';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const date = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '–');

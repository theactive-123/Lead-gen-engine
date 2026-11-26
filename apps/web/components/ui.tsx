import Link from 'next/link';
import type { ReactNode } from 'react';

/** Small set of UI pieces in the shadcn/ui style (plain Tailwind, no extra library). */
export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-neutral-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-neutral-200 bg-white', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-medium text-neutral-700">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

const TIER: Record<string, string> = {
  A: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  B: 'bg-sky-50 text-sky-700 ring-sky-200',
  C: 'bg-neutral-100 text-neutral-600 ring-neutral-200',
  X: 'bg-white text-neutral-400 ring-neutral-200',
};
export function Tier({ tier }: { tier: string }) {
  return <span className={cx('inline-flex h-6 w-6 items-center justify-center rounded text-xs font-semibold ring-1 ring-inset', TIER[tier] ?? TIER.C)}>{tier}</span>;
}

const BADGE: Record<string, string> = {
  neutral: 'bg-neutral-100 text-neutral-700',
  green: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-800',
  blue: 'bg-sky-50 text-sky-700',
};
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: keyof typeof BADGE }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs', BADGE[tone])}>{children}</span>;
}

export const SEVERITY_TONE: Record<string, keyof typeof BADGE> = { high: 'red', medium: 'amber', low: 'neutral', info: 'blue' };

export function Dot({ ok, label }: { ok: boolean; label: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-2 text-sm', ok ? 'text-emerald-700' : 'text-red-700')}>
      <span className={cx('h-2 w-2 rounded-full', ok ? 'bg-emerald-500' : 'bg-red-500')} />
      {label}
    </span>
  );
}

export const btn = {
  primary: 'inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50',
  secondary: 'inline-flex items-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50',
  danger: 'inline-flex items-center rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50',
  link: 'text-sm text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900',
};
export const input = 'w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none';
export const label = 'mb-1 block text-xs font-medium text-neutral-600';

export function Field({ name, children, hint }: { name: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className={label}>{name}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap py-2 pr-4 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-neutral-100 [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top">{children}</tbody>
      </table>
      {empty && <p className="py-6 text-center text-sm text-neutral-500">Nothing here yet.</p>}
    </div>
  );
}

export function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'amber' | 'red' | 'green'; children: ReactNode }) {
  const c = { neutral: 'border-neutral-200 bg-neutral-50 text-neutral-700', amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-800', green: 'border-emerald-200 bg-emerald-50 text-emerald-800' }[tone];
  return <div className={cx('rounded-md border px-4 py-3 text-sm', c)}>{children}</div>;
}

export function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((100 * value) / max)) : 0;
  return <div className="h-2 w-full rounded bg-neutral-100"><div className={cx('h-2 rounded bg-neutral-800', className)} style={{ width: `${w}%` }} /></div>;
}

export function Pager({ page, pages, href }: { page: number; pages: number; href: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      {page > 1 ? <Link className={btn.secondary} href={href(page - 1)}>Previous</Link> : <span className={cx(btn.secondary, 'opacity-40')}>Previous</span>}
      <span className="text-neutral-500">Page {page} of {pages.toLocaleString('en-US')}</span>
      {page < pages ? <Link className={btn.secondary} href={href(page + 1)}>Next</Link> : <span className={cx(btn.secondary, 'opacity-40')}>Next</span>}
    </div>
  );
}

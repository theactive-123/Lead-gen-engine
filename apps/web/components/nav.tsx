'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  ['/', 'Overview'], ['/explorer', 'Explorer'], ['/segments', 'Segments'], ['/brands', 'Brands'], ['/niches', 'Niches'],
  ['/sources', 'Sources'], ['/exports', 'Exports'], ['/settings', 'Settings'], ['/system', 'System'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 text-sm">
      {ITEMS.map(([href, name]) => {
        const active = href === '/' ? path === '/' : path.startsWith(href) || (href === '/explorer' && path.startsWith('/leads'));
        return (
          <Link key={href} href={href}
            className={`rounded-md px-2.5 py-1.5 ${active ? 'bg-neutral-100 font-medium text-neutral-900' : 'text-neutral-600 hover:text-neutral-900'}`}>
            {name}
          </Link>
        );
      })}
    </nav>
  );
}

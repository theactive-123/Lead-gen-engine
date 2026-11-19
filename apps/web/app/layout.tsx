import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'LeadEngine', description: 'Lead data engine dashboard' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <span className="font-semibold">LeadEngine</span>
            <nav className="flex gap-4 text-sm text-neutral-600">
              <a href="/" className="hover:text-neutral-900">System</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}

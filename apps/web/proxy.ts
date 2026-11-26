import { NextResponse, type NextRequest } from 'next/server';

/**
 * Password for the whole dashboard (HTTP Basic auth: the browser asks once).
 * The dashboard can change brands, scoring and the do-not-contact list, so it must never be open to the internet.
 * Production refuses to serve anything until DASHBOARD_PASSWORD is set; `next dev` on your own PC works without it.
 */
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  const user = process.env.DASHBOARD_USER || 'admin';
  if (!password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Set DASHBOARD_PASSWORD in .env and restart the web container.', { status: 503 });
    }
    return NextResponse.next();
  }
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = atob(header.slice(6));
    const i = decoded.indexOf(':');
    if (i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), password)) return NextResponse.next();
  }
  return new NextResponse('Login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="LeadEngine", charset="UTF-8"' } });
}

/** Compare without stopping at the first different character (no timing hint about the password). */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };

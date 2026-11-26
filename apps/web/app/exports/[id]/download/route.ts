import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { one } from '@/lib/db';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Download a finished export. Only files recorded in the exports table, only from the export folder. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 });
  const row = await one<{ file_name: string | null; format: string; status: string }>(`SELECT file_name, format, status FROM exports WHERE id = $1`, [id]);
  if (!row || row.status !== 'done' || !row.file_name) return new Response('This export is not ready (or failed).', { status: 404 });
  // turbopackIgnore: the folder is only known at run time; without it the build copies the whole project (incl. data/) into the bundle.
  const dir = path.resolve(/* turbopackIgnore: true */ process.env.EXPORT_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), '../../data/exports'));
  const file = path.resolve(/* turbopackIgnore: true */ dir, row.file_name);
  if (path.dirname(file) !== dir) return new Response('Not found', { status: 404 }); // never leave the export folder
  const s = await stat(file).catch(() => null);
  if (!s) return new Response('The file was removed (exports are kept for a limited number of days, see Settings → exports.keep_days). Create it again.', { status: 410 });
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, {
    headers: {
      'Content-Type': TYPES[row.format] ?? 'application/octet-stream',
      'Content-Length': String(s.size),
      'Content-Disposition': `attachment; filename="${row.file_name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

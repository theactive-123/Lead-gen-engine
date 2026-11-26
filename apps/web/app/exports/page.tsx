import Link from 'next/link';
import { q } from '@/lib/db';
import { fmt } from '@/lib/format';
import { Card, Notice, PageHeader, Table } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Exports() {
  const rows = await q<{ id: number; name: string; segments: number; a: number; b: number; with_email: number }>(`
    SELECT b.id, b.name, (SELECT count(*)::int FROM segments s WHERE s.brand_id = b.id) segments,
      count(*) FILTER (WHERE m.tier = 'A')::int a, count(*) FILTER (WHERE m.tier = 'B')::int b,
      count(*) FILTER (WHERE m.tier IN ('A','B') AND ct.email IS NOT NULL)::int with_email
    FROM brands b LEFT JOIN brand_matches m ON m.brand_id = b.id LEFT JOIN contacts ct ON ct.domain_id = m.domain_id
    WHERE b.enabled GROUP BY b.id ORDER BY b.id`);
  return (
    <div className="space-y-6">
      <PageHeader title="Exports" description="Download leads per brand → segment → tier as CSV or Excel." />
      <Notice>CSV and Excel downloads are built in the next phase (Phase 10): per brand / segment / tier, “new since last export”, exported rows marked,
        and the do-not-contact list applied right before every file is written.</Notice>
      <Card title="What is ready to export">
        <Table head={['Brand', 'Segments', 'Tier A', 'Tier B', 'A/B with email']}>
          {rows.map((r) => (
            <tr key={r.id}><td><Link href={`/explorer?brand=${r.id}&tiers=A,B`} className="font-medium hover:underline">{r.name}</Link></td>
              <td className="tabular-nums">{r.segments}</td><td className="tabular-nums">{fmt(r.a)}</td><td className="tabular-nums">{fmt(r.b)}</td><td className="tabular-nums">{fmt(r.with_email)}</td></tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

import { q } from './db';

/** Choices for filter forms (niches, platforms, countries, technologies, finding codes), read live from the data. */
export async function filterOptions() {
  const [brands, niches, subNiches, platforms, countries, techs, findings] = await Promise.all([
    q<{ id: number; key: string; name: string }>(`SELECT id, key, name FROM brands WHERE enabled ORDER BY id`),
    q<{ key: string; name: string }>(`SELECT key, name FROM niches WHERE enabled AND NOT excluded ORDER BY name`),
    q<{ key: string; name: string; niche: string }>(`SELECT s.key, s.name, n.name AS niche FROM sub_niches s JOIN niches n ON n.id = s.niche_id
      WHERE s.enabled AND n.enabled AND NOT n.excluded ORDER BY n.name, s.name`),
    q<{ platform: string; n: number }>(`SELECT c.platform, count(*)::int n FROM companies c JOIN classifications k USING (domain_id)
      WHERE c.platform IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    q<{ country: string; n: number }>(`SELECT c.country, count(*)::int n FROM companies c JOIN classifications k USING (domain_id)
      WHERE c.country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 80`),
    q<{ tech: string; n: number }>(`SELECT t.tech, count(*)::int n FROM technologies t JOIN classifications k USING (domain_id)
      GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 600`),
    q<{ code: string; n: number }>(`SELECT code, count(*)::int n FROM audit_findings GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  return { brands, niches, subNiches, platforms, countries, techs, findings };
}
export type FilterOptions = Awaited<ReturnType<typeof filterOptions>>;

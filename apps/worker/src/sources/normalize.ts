import { parse } from 'tldts';

export type DropReason = 'invalid' | 'ip' | 'no_registrable' | 'private_suffix' | 'not_icann';

/**
 * Hostname -> registrable domain using the Public Suffix List (via tldts, which bundles it).
 * "shop.Brand.co.uk." -> "brand.co.uk". Wildcards and "www." disappear naturally.
 * Hosts under *private* suffixes (myshopify.com, herokuapp.com, github.io, s3.amazonaws.com...)
 * are dropped: they are platform/cloud hostnames, not a business's own domain.
 */
export function registrableDomain(host: string): { domain: string } | { drop: DropReason } {
  const h = host.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!h || h.length > 253 || !h.includes('.') || /[^a-z0-9.\-_]/.test(h)) return { drop: 'invalid' };
  const r = parse(h, { allowPrivateDomains: true });
  if (r.isIp) return { drop: 'ip' };
  if (!r.domain) return { drop: 'no_registrable' };
  if (r.isPrivate) return { drop: 'private_suffix' };
  if (!r.isIcann) return { drop: 'not_icann' };
  return { domain: r.domain };
}

import { dnsNamesFromDer } from './der.js';

/**
 * Decoders for Certificate Transparency log entries, in the two formats in use today:
 *  - RFC 6962 `get-entries` JSON (leaf_input + extra_data, base64)
 *  - Static CT API data tiles (c2sp.org/static-ct-api): concatenated TileLeaf structures
 * Each returns the issuance timestamp and the DNS names in the certificate.
 */
export interface CtCert {
  timestamp: number; // ms since epoch, when the log accepted the entry
  names: string[];
  precert: boolean;
}

const u24 = (b: Buffer, p: number) => (b[p]! << 16) | (b[p + 1]! << 8) | b[p + 2]!;
const u16 = (b: Buffer, p: number) => (b[p]! << 8) | b[p + 1]!;

/** RFC 6962: MerkleTreeLeaf (leaf_input) + extra_data. */
export function decodeRfc6962Entry(leafInputB64: string, extraDataB64: string): CtCert | null {
  const leaf = Buffer.from(leafInputB64, 'base64');
  // version(1) leaf_type(1) | TimestampedEntry: timestamp(8) entry_type(2) ...
  if (leaf.length < 12) return null;
  const timestamp = Number(leaf.readBigUInt64BE(2));
  const entryType = u16(leaf, 10);
  if (entryType === 0) {
    const len = u24(leaf, 12);
    return { timestamp, names: dnsNamesFromDer(leaf.subarray(15, 15 + len)), precert: false };
  }
  if (entryType === 1) {
    // extra_data = PrecertChainEntry: pre_certificate (uint24-prefixed full precertificate) + chain
    const extra = Buffer.from(extraDataB64, 'base64');
    const len = u24(extra, 0);
    return { timestamp, names: dnsNamesFromDer(extra.subarray(3, 3 + len)), precert: true };
  }
  return null;
}

/** Static CT API: decode every TileLeaf in a (decompressed) data tile. */
export function decodeDataTile(tile: Buffer): CtCert[] {
  const out: CtCert[] = [];
  let p = 0;
  while (p + 10 <= tile.length) {
    const timestamp = Number(tile.readBigUInt64BE(p));
    const entryType = u16(tile, p + 8);
    p += 10;
    let der: Buffer;
    if (entryType === 0) {
      const len = u24(tile, p);
      der = tile.subarray(p + 3, p + 3 + len);
      p += 3 + len;
      p += 2 + u16(tile, p); // CtExtensions
    } else if (entryType === 1) {
      p += 32; // issuer_key_hash
      p += 3 + u24(tile, p); // TBSCertificate (we use the full pre_certificate below)
      p += 2 + u16(tile, p); // CtExtensions
      const len = u24(tile, p);
      der = tile.subarray(p + 3, p + 3 + len);
      p += 3 + len;
    } else {
      throw new Error(`unknown CT entry type ${entryType} at byte ${p - 2}`);
    }
    p += 2 + u16(tile, p); // certificate_chain fingerprints
    out.push({ timestamp, names: dnsNamesFromDer(der), precert: entryType === 1 });
  }
  if (p !== tile.length) throw new Error(`data tile parse ended at ${p} of ${tile.length} bytes`);
  return out;
}

/** Tile index -> path elements, e.g. 1234067 -> "x001/x234/067" (static-ct-api). */
export function tilePath(n: number): string {
  const parts: string[] = [];
  do {
    parts.unshift(String(n % 1000).padStart(3, '0'));
    n = Math.floor(n / 1000);
  } while (n > 0);
  return parts.map((p, i) => (i < parts.length - 1 ? `x${p}` : p)).join('/');
}

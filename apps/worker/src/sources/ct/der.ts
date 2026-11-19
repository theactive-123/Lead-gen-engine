/**
 * Minimal DER reader that pulls DNS names out of an X.509 certificate or TBSCertificate.
 * Much faster than full certificate parsing, which matters at millions of certs per day.
 * Reads: Subject Alternative Name (OID 2.5.29.17) dNSName entries, and the subject CN as fallback.
 */

const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);
const CN_OID = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

/** Read a DER length at `pos`. Returns [length, headerBytesConsumed]. */
function readLen(buf: Buffer, pos: number): [number, number] {
  const first = buf[pos]!;
  if (first < 0x80) return [first, 1];
  const n = first & 0x7f;
  if (n === 0 || n > 4) return [-1, 1];
  let len = 0;
  for (let i = 1; i <= n; i++) len = len * 256 + buf[pos + i]!;
  return [len, 1 + n];
}

function sanNames(buf: Buffer, at: number, out: string[]): void {
  // at -> right after the OID. Optional BOOLEAN (critical), then OCTET STRING.
  let p = at;
  if (buf[p] === 0x01) p += 3;
  if (buf[p] !== 0x04) return;
  const [, h] = readLen(buf, p + 1);
  p += 1 + h;
  if (buf[p] !== 0x30) return; // SEQUENCE OF GeneralName
  const [seqLen, sh] = readLen(buf, p + 1);
  if (seqLen < 0) return;
  p += 1 + sh;
  const end = Math.min(p + seqLen, buf.length);
  while (p < end) {
    const tag = buf[p]!;
    const [len, lh] = readLen(buf, p + 1);
    if (len < 0) return;
    const start = p + 1 + lh;
    if (tag === 0x82) out.push(buf.toString('latin1', start, start + len)); // [2] dNSName (IA5String)
    p = start + len;
  }
}

function commonName(buf: Buffer, at: number): string | undefined {
  // After CN OID comes a string type (UTF8String 0x0c, PrintableString 0x13, IA5String 0x16, T61 0x14).
  const tag = buf[at];
  if (tag !== 0x0c && tag !== 0x13 && tag !== 0x16 && tag !== 0x14) return undefined;
  const [len, h] = readLen(buf, at + 1);
  if (len < 0 || len > 255) return undefined;
  return buf.toString('utf8', at + 1 + h, at + 1 + h + len);
}

/** All DNS names in a certificate (DER), lowercased, de-duplicated. */
export function dnsNamesFromDer(der: Buffer): string[] {
  const names: string[] = [];
  const san = der.indexOf(SAN_OID);
  if (san >= 0) sanNames(der, san + SAN_OID.length, names);
  if (names.length === 0) {
    // Fallback: the last CN in the certificate is the subject CN (the issuer's comes first).
    let idx = der.indexOf(CN_OID);
    let last: string | undefined;
    while (idx >= 0) {
      last = commonName(der, idx + CN_OID.length) ?? last;
      idx = der.indexOf(CN_OID, idx + 1);
    }
    if (last && last.includes('.') && !last.includes(' ')) names.push(last);
  }
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

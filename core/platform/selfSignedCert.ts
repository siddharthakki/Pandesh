/**
 * A minimal self-signed X.509 certificate (ECDSA P-256 / SHA-256) built with node:crypto alone.
 *
 * Node can parse certificates but not issue them, and the companion listener needs exactly one certificate per PC whose
 * identity is established by pinning its fingerprint, not by a CA chain or a host name. So this encodes only what TLS
 * needs: version 3, a random positive serial, CN, validity, the public key and basicConstraints CA:FALSE.
 */
import * as crypto from 'node:crypto';

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);

function derInteger(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.subarray(1);
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}

function derOid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function derTime(d: Date): Buffer {
  const iso = d.toISOString();
  // UTCTime up to 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'));
}

const ECDSA_WITH_SHA256 = seq(derOid('1.2.840.10045.4.3.2'));

export interface SelfSignedIdentity {
  keyPem: string;
  certPem: string;
  /** SHA-256 of the DER certificate, lowercase hex: what the phone pins. */
  fingerprint: string;
}

export function createSelfSignedIdentity(commonName: string, options: { now?: Date; validDays?: number } = {}): SelfSignedIdentity {
  const now = options.now ?? new Date();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const name = seq(set(seq(derOid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName.slice(0, 64), 'utf8')))));
  const tbs = seq(
    tlv(0xa0, derInteger(Buffer.from([2]))),
    derInteger(serial),
    ECDSA_WITH_SHA256,
    name,
    seq(derTime(new Date(now.getTime() - 86_400_000)), derTime(new Date(now.getTime() + (options.validDays ?? 3650) * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(seq(derOid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())))),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), certPem, fingerprint: certificateFingerprint(certPem) };
}

export function certificateFingerprint(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** "ab12cd…" → "AB12 CD34 …" for a person comparing it with the phone. */
export function formatFingerprint(fp: string): string {
  return fp.toUpperCase().match(/.{1,4}/g)!.join(' ');
}

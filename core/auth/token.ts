import * as crypto from 'node:crypto';

/** Constant-time token comparison; normalizes length via a digest so unequal-length inputs don't short-circuit. */
export function verifyToken(provided: string | undefined | null, expected: string): boolean {
  if (!provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1] : undefined;
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

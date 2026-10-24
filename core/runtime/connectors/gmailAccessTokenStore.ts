/**
 * In-memory-only holder for Gmail's current short-lived OAuth access token.
 *
 * Desktop owns the refresh token (encrypted, `safeStorage`) and mints access
 * tokens outside Core entirely; this module exists so Desktop can push a
 * freshly minted access token into an already-running Core process WITHOUT
 * restarting it (Core's env is fixed at spawn time — see
 * `core/api/routes.ts` `PUT /v1/connectors/gmail/access-token`). The token is
 * never written to disk, never logged, and never included in any snapshot —
 * `get()` is the only read path and `gwsGmailAdapter.ts` is its only caller.
 */

interface StoredToken {
  accessToken: string;
  expiresAtMs: number;
  /** The connected Google account's email, exactly as Desktop learned it from
   * the OAuth identity scope — Core never independently discovers this, so a
   * push without it would leave draft-digest canonicalization unable to bind
   * "which account". Not a secret; safe to surface in status/UI. */
  accountEmail: string;
  /** OAuth scopes Google actually granted for this token (empty = unknown, treated as none). */
  scopes: string[];
}

let current: StoredToken | null = null;

/** Small skew so a token is treated as unusable a little before its real
 * expiry, rather than racing a `gws` call against the exact expiry instant. */
const EXPIRY_SKEW_MS = 5_000;

export function setGmailAccessToken(accessToken: string, expiresAtIso: string, accountEmail: string, scopes: readonly string[] = []): void {
  const trimmed = accessToken.trim();
  const trimmedEmail = accountEmail.trim();
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!trimmed || !Number.isFinite(expiresAtMs) || !trimmedEmail) {
    throw new Error('gmail access token, account email, and a valid expiry are all required');
  }
  current = { accessToken: trimmed, expiresAtMs, accountEmail: trimmedEmail, scopes: scopes.map((scope) => scope.trim()).filter(Boolean) };
}

export function clearGmailAccessToken(): void {
  current = null;
}

/** Returns the live token, or `null` if none is set or it has expired. Fails
 * closed on expiry rather than handing `gws` a token likely to be rejected —
 * Desktop is expected to refresh proactively before this ever happens. */
export function getGmailAccessToken(nowMs: number = Date.now()): string | null {
  if (!current) return null;
  if (nowMs >= current.expiresAtMs - EXPIRY_SKEW_MS) return null;
  return current.accessToken;
}

/** For status/diagnostics only — never exposes the token itself. */
export function gmailAccessTokenPresent(nowMs: number = Date.now()): boolean {
  return getGmailAccessToken(nowMs) !== null;
}

/** The connected account's email, independent of token expiry (still useful
 * for status display even a moment after the access token has lapsed and
 * before Desktop's next refresh lands). `null` when nothing is connected. */
export function getGmailAccountEmail(): string | null {
  return current?.accountEmail ?? null;
}

/** Whether Google granted this exact scope for the connected account. Fails closed when no token is held. */
export function googleScopeGranted(scope: string): boolean {
  return current?.scopes.includes(scope) ?? false;
}

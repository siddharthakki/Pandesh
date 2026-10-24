/**
 * Owns the whole Gmail connection lifecycle on Desktop: connect (OAuth),
 * encrypted refresh-token storage, proactive access-token refresh pushed into
 * Core without restarting it, and disconnect (revoke + clear). Core never
 * sees a refresh token — only ever the current short-lived access token, via
 * `CoreClient.pushGmailAccessToken` (`core/api/routes.ts`
 * `PATCH /v1/connectors/gmail/access-token`).
 *
 * Storage reuses the existing connector-credential seam
 * (`connectorCredentials.ts`, safeStorage-backed) with Gmail's opaque
 * "credential" string being a small JSON blob `{refreshToken, accountEmail}`
 * — no new storage primitive, no new file.
 */
import {
  fetchAccountEmail,
  refreshAccessToken,
  resolveGmailOAuthClientConfig,
  revokeGoogleToken,
  runGmailOAuthConnectFlow,
  GmailOAuthConfigError,
  GmailOAuthError,
  type FetchLike,
  type GmailOAuthClientConfig,
  type OpenExternal,
  GMAIL_MODIFY_SCOPE,
  inboxOrganizationScopes,
} from './gmailOAuth';
import {
  clearConnectorCredential,
  connectorCredentialPresent,
  loadConnectorCredential,
  storeConnectorCredential,
  tryElectronSecretBox,
  type SecretBox,
} from './connectorCredentials';
import type { ConnectorId, ConnectorStatus } from '../../../../core/shared/wireTypes';

export interface GmailConnectionStatus {
  connected: boolean;
  accountEmail: string | null;
  lastError: string | null;
  lastRefreshedAt: string | null;
  /** Core's own health for the Gmail capability, kept separate from OAuth
   * `connected`: the account can be validly OAuth-connected while Core's
   * live probe still fails (no access token pushed yet, `gws` binary
   * missing, a transient Gmail API error, …) — this is that exact blocker,
   * or `null` when Core reports the capability available. Never a token. */
  capabilityBlocker: string | null;
  /** Core's own health for the Calendar capability behind the same Google grant, or `null` when verified. */
  calendarBlocker: string | null;
  /** Scopes Google actually granted at the last sign-in/refresh ([] = unknown, treated as none). */
  scopes: string[];
}

interface StoredGmailCredential {
  refreshToken: string;
  accountEmail: string;
  scopes?: string[];
}

function parseStoredCredential(raw: string): StoredGmailCredential | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object'
      && typeof (parsed as Record<string, unknown>).refreshToken === 'string'
      && typeof (parsed as Record<string, unknown>).accountEmail === 'string'
    ) {
      return parsed as StoredGmailCredential;
    }
    return null;
  } catch {
    return null;
  }
}

export interface GmailCoreTokenSink {
  pushGmailAccessToken(input: { accessToken: string; expiresAt: string; accountEmail: string; scopes?: string[] }): Promise<{ connector: ConnectorStatus; connectors?: Partial<Record<ConnectorId, ConnectorStatus>> }>;
  clearGmailAccessToken(): Promise<{ connector: ConnectorStatus }>;
  retryConnectorProbe(connectorId: ConnectorId): Promise<{ connector: ConnectorStatus }>;
}

/** Core's `ConnectorStatus.state` collapsed to "is the capability itself
 * usable", separate from whether OAuth is connected — `available`/`connected`
 * both mean go, everything else is a blocker worth surfacing. */
function capabilityBlockerFrom(connector: ConnectorStatus): string | null {
  return connector.state === 'connected' ? null : (connector.reason ?? `Gmail capability is ${connector.state}`);
}

export interface GmailTokenManagerOptions {
  dataDir: string;
  getSecretBox?: () => SecretBox | null;
  /** `null` when Core is not currently connected — pushes are skipped, never
   * queued or retried indefinitely; the next scheduled refresh (or
   * `onCoreReady`) will push again once Core is back. */
  getClient: () => GmailCoreTokenSink | null;
  resolveClientConfig?: () => GmailOAuthClientConfig;
  openExternal?: OpenExternal;
  fetchFn?: FetchLike;
  onStatusChange?: (status: GmailConnectionStatus) => void;
  /** How long before real expiry to refresh proactively. */
  refreshMarginMs?: number;
  /** Never below this, so a nearly-expired token does not cause a refresh
   * storm on schedule computation edge cases. */
  minRefreshDelayMs?: number;
  now?: () => number;
}

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_MIN_REFRESH_DELAY_MS = 5_000;

/** Pure so it is directly testable without real timers. */
export function computeRefreshDelayMs(expiresAtIso: string, marginMs: number, minDelayMs: number, nowMs: number): number {
  const expiresAtMs = Date.parse(expiresAtIso);
  const target = expiresAtMs - marginMs;
  return Math.max(minDelayMs, target - nowMs);
}

export class GmailTokenManager {
  private readonly dataDir: string;
  private readonly getSecretBox: () => SecretBox | null;
  private readonly getClient: () => GmailCoreTokenSink | null;
  private readonly resolveClientConfig: () => GmailOAuthClientConfig;
  private readonly openExternal?: OpenExternal;
  private readonly fetchFn?: FetchLike;
  private readonly onStatusChange?: (status: GmailConnectionStatus) => void;
  private readonly refreshMarginMs: number;
  private readonly minRefreshDelayMs: number;
  private readonly now: () => number;

  private status: GmailConnectionStatus;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAbort: AbortController | null = null;

  constructor(options: GmailTokenManagerOptions) {
    this.dataDir = options.dataDir;
    this.getSecretBox = options.getSecretBox ?? tryElectronSecretBox;
    this.getClient = options.getClient;
    this.resolveClientConfig = options.resolveClientConfig ?? resolveGmailOAuthClientConfig;
    this.openExternal = options.openExternal;
    this.fetchFn = options.fetchFn;
    this.onStatusChange = options.onStatusChange;
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.minRefreshDelayMs = options.minRefreshDelayMs ?? DEFAULT_MIN_REFRESH_DELAY_MS;
    this.now = options.now ?? Date.now;
    const storedPresent = connectorCredentialPresent(this.dataDir, 'gmail');
    this.status = { connected: storedPresent, accountEmail: null, lastError: null, lastRefreshedAt: null, capabilityBlocker: null, calendarBlocker: null, scopes: [] };
  }

  getStatus(): GmailConnectionStatus {
    return { ...this.status };
  }

  private emit(): void {
    this.onStatusChange?.(this.getStatus());
  }

  private clearTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(expiresAtIso: string): void {
    this.clearTimer();
    const delay = computeRefreshDelayMs(expiresAtIso, this.refreshMarginMs, this.minRefreshDelayMs, this.now());
    this.refreshTimer = setTimeout(() => {
      void this.ensureFreshAccessToken();
    }, delay);
    this.refreshTimer.unref?.();
  }

  private readStoredCredential(): StoredGmailCredential | null {
    const box = this.getSecretBox();
    const raw = loadConnectorCredential(this.dataDir, 'gmail', box);
    return raw ? parseStoredCredential(raw) : null;
  }

  /** Google's OAuth setup is missing or misconfigured — the exact blocker to
   * show the user, never a generic "not connected". */
  configBlocker(): string | null {
    try {
      this.resolveClientConfig();
      return null;
    } catch (err) {
      return err instanceof GmailOAuthConfigError ? err.message : (err instanceof Error ? err.message : String(err));
    }
  }

  async connect(): Promise<GmailConnectionStatus> {
    const box = this.getSecretBox();
    if (!box?.isEncryptionAvailable()) {
      this.status = { ...this.status, connected: false, lastError: 'host encrypted storage is not available; refusing to connect Gmail' };
      this.emit();
      return this.getStatus();
    }
    const clientConfig = this.resolveClientConfig(); // throws GmailOAuthConfigError with the exact blocker
    const abort = new AbortController();
    this.connectAbort = abort;
    let result: Awaited<ReturnType<typeof runGmailOAuthConnectFlow>>;
    try {
      result = await runGmailOAuthConnectFlow({ client: clientConfig, openExternal: this.openExternal, fetchFn: this.fetchFn, signal: abort.signal });
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null;
    }
    storeConnectorCredential(this.dataDir, 'gmail', JSON.stringify({ refreshToken: result.refreshToken, accountEmail: result.accountEmail, scopes: result.scopes } satisfies StoredGmailCredential), box);
    const blockers = await this.pushToken(result.accessToken, result.expiresAt, result.accountEmail, result.scopes);
    this.status = { connected: true, accountEmail: result.accountEmail, lastError: null, lastRefreshedAt: new Date(this.now()).toISOString(), capabilityBlocker: blockers.gmail, calendarBlocker: blockers.calendar, scopes: result.scopes };
    this.emit();
    this.scheduleRefresh(result.expiresAt);
    return this.getStatus();
  }

  /**
   * Incremental consent for inbox organization (labels, categories, archive). Requests ONLY gmail.modify, keeps every
   * earlier grant, insists on the same Google account, and succeeds only if Google really granted the scope. A refusal
   * or a different account leaves the existing sign-in exactly as it was.
   */
  async grantInboxOrganization(): Promise<GmailConnectionStatus> {
    const box = this.getSecretBox();
    if (!box?.isEncryptionAvailable()) throw new Error('host encrypted storage is not available; refusing to change Gmail permissions');
    const stored = this.readStoredCredential();
    if (!stored || !this.status.connected || !this.status.accountEmail) throw new Error('Connect Google first, then allow inbox organization.');
    const clientConfig = this.resolveClientConfig();
    const abort = new AbortController();
    this.connectAbort = abort;
    let result: Awaited<ReturnType<typeof runGmailOAuthConnectFlow>>;
    try {
      result = await runGmailOAuthConnectFlow({
        client: clientConfig,
        openExternal: this.openExternal,
        fetchFn: this.fetchFn,
        signal: abort.signal,
        scopes: inboxOrganizationScopes(),
        includeGrantedScopes: true,
        loginHint: this.status.accountEmail,
        expectedAccountEmail: this.status.accountEmail,
      });
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null;
    }
    if (!result.scopes.includes(GMAIL_MODIFY_SCOPE)) {
      throw new Error('Google did not grant the inbox organization permission. Nothing was changed; press "Allow inbox organization" again and keep the permission ticked.');
    }
    const scopes = [...new Set([...(stored.scopes ?? []), ...result.scopes])];
    storeConnectorCredential(this.dataDir, 'gmail', JSON.stringify({ refreshToken: result.refreshToken, accountEmail: result.accountEmail, scopes } satisfies StoredGmailCredential), box);
    const blockers = await this.pushToken(result.accessToken, result.expiresAt, result.accountEmail, scopes);
    this.status = { connected: true, accountEmail: result.accountEmail, lastError: null, lastRefreshedAt: new Date(this.now()).toISOString(), capabilityBlocker: blockers.gmail, calendarBlocker: blockers.calendar, scopes };
    this.emit();
    this.scheduleRefresh(result.expiresAt);
    return this.getStatus();
  }

  /** Abandons a sign-in that is waiting on the browser. No-op when none is in flight. */
  cancelConnect(): boolean {
    if (!this.connectAbort) return false;
    this.connectAbort.abort();
    return true;
  }

  async disconnect(): Promise<GmailConnectionStatus> {
    this.clearTimer();
    const stored = this.readStoredCredential();
    if (stored) {
      await revokeGoogleToken({ token: stored.refreshToken, fetchFn: this.fetchFn }); // best-effort; never blocks local clear
    }
    clearConnectorCredential(this.dataDir, 'gmail');
    const client = this.getClient();
    if (client) {
      // Clearing the token also re-probes Core-side (see `routes.ts`), so a
      // previously cached "available" health can never outlive this call —
      // best-effort push aside, Core may already be gone; local state still
      // clears regardless.
      try { await client.clearGmailAccessToken(); } catch { /* ignore */ }
    }
    this.status = { connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, capabilityBlocker: null, calendarBlocker: null, scopes: [] };
    this.emit();
    return this.getStatus();
  }

  /** Pushes a token into Core and returns the resulting capability blocker
   * (`null` when Core reports Gmail available) — Core re-probes as part of
   * handling the push, so the caller never needs a second round trip. */
  private async pushToken(accessToken: string, expiresAt: string, accountEmail: string, scopes: string[]): Promise<{ gmail: string | null; calendar: string | null }> {
    const client = this.getClient();
    const down = 'Core is not reachable right now; this will be re-checked once it reconnects';
    if (!client) return { gmail: down, calendar: down };
    const { connector, connectors } = await client.pushGmailAccessToken({ accessToken, expiresAt, accountEmail, scopes });
    const calendar = connectors?.google_calendar;
    return {
      gmail: capabilityBlockerFrom(connector),
      calendar: calendar ? capabilityBlockerFrom(calendar) : 'Core did not report Calendar status; press Check to verify again',
    };
  }

  /** Explicit operator-triggered re-probe (Gmail diagnostics "Retry"). Never
   * touches the OAuth/refresh-token lifecycle — it only asks Core to
   * re-check the capability it already has a token for, so it is safe to
   * call whether or not the last probe failed. */
  async retryProbe(): Promise<GmailConnectionStatus> {
    const client = this.getClient();
    if (!client) {
      this.status = { ...this.status, capabilityBlocker: 'Core is not reachable right now' };
      this.emit();
      return this.getStatus();
    }
    try {
      const { connector } = await client.retryConnectorProbe('gmail');
      const calendar = await client.retryConnectorProbe('google_calendar').then((r) => capabilityBlockerFrom(r.connector)).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
      this.status = { ...this.status, capabilityBlocker: capabilityBlockerFrom(connector), calendarBlocker: calendar };
    } catch (err) {
      this.status = { ...this.status, capabilityBlocker: err instanceof Error ? err.message : String(err) };
    }
    this.emit();
    return this.getStatus();
  }

  /**
   * Refreshes the access token using the stored refresh token and pushes it
   * into Core — the mechanism that proves "continues working after a
   * simulated expired access token without restarting Desktop" (Core's own
   * process is never touched by this call). Called by the proactive timer,
   * and safe to call directly (e.g. on 401 from a live call, or right after
   * Core reconnects).
   */
  async ensureFreshAccessToken(): Promise<GmailConnectionStatus> {
    const stored = this.readStoredCredential();
    if (!stored) {
      this.status = { ...this.status, connected: false, accountEmail: null };
      this.emit();
      return this.getStatus();
    }
    try {
      const clientConfig = this.resolveClientConfig();
      const refreshed = await refreshAccessToken({ clientId: clientConfig.clientId, clientSecret: clientConfig.clientSecret, refreshToken: stored.refreshToken, fetchFn: this.fetchFn });
      const expiresAt = new Date(this.now() + refreshed.expiresInSeconds * 1000).toISOString();
      const scopes = refreshed.scopes ?? stored.scopes ?? [];
      const blockers = await this.pushToken(refreshed.accessToken, expiresAt, stored.accountEmail, scopes);
      this.status = { connected: true, accountEmail: stored.accountEmail, lastError: null, lastRefreshedAt: new Date(this.now()).toISOString(), capabilityBlocker: blockers.gmail, calendarBlocker: blockers.calendar, scopes };
      this.emit();
      this.scheduleRefresh(expiresAt);
      return this.getStatus();
    } catch (err) {
      const message = err instanceof GmailOAuthError || err instanceof Error ? err.message : String(err);
      // A revoked/expired refresh grant cannot recover itself — reflect
      // disconnection honestly rather than retrying forever against a dead
      // credential (item 7's "revoked consent" must show as disconnected).
      const revoked = /invalid_grant/i.test(message);
      // A failed refresh leaves the grant in place but Core without a usable
      // token, so both capabilities must say why. A null blocker with
      // `connected` set is what used to leave Calendar "Verifying" forever.
      this.status = {
        connected: !revoked,
        accountEmail: revoked ? null : stored.accountEmail,
        lastError: message,
        lastRefreshedAt: this.status.lastRefreshedAt,
        capabilityBlocker: revoked ? null : message,
        calendarBlocker: revoked ? null : message,
        scopes: revoked ? [] : this.status.scopes,
      };
      if (revoked) clearConnectorCredential(this.dataDir, 'gmail');
      this.emit();
      return this.getStatus();
    }
  }

  /** Call once Core (re)connects — pushes the current token immediately
   * rather than waiting for the next scheduled refresh, so a Core restart
   * for an unrelated reason does not leave Gmail dead in the meantime. */
  async onCoreReady(): Promise<void> {
    if (!this.status.connected) return;
    await this.ensureFreshAccessToken();
  }

  dispose(): void {
    this.clearTimer();
  }
}

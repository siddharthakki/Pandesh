import * as http from 'node:http';
import * as path from 'node:path';
import type { DesktopSession } from './desktopSession';
import type { DesktopActivityEvent, MobileAccessMode, MobilePairingView } from '../ipc';
import { PairingStore, formatPairingCode, type PairedDevice } from './mobilePairing';
import { DEFAULT_PAIR_LIMITS, PairAttemptLimiter, type PairLimits } from './mobileRateLimit';
import {
  BASE_SECURITY_HEADERS,
  PAGE_CSP,
  PAGE_PERMISSIONS_POLICY,
  clientAddress,
  hasContentType,
  isAllowedHost,
  isFunnelRequest,
  isLoopbackAddress,
  isSecureRequest,
  originAllowed,
} from './mobileHttpGuards';
import { MobileAssets, defaultMobileAssetsDir } from './mobileAssets';
import { detectSecureLink, pickLanAddress, type SecureLinkStatus } from './mobileTailscale';
import { phoneEvent, phoneState } from './mobileState';

export interface MobileServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  session: DesktopSession;
  /** Who may reach the server, as the owner set it (reported in the pairing view). */
  access?: MobileAccessMode;
  onClientsChanged?: (count: number) => void;
  log?: (message: string) => void;
  /** The phone app's files (default: renderer/mobile of this build). */
  assetsDir?: string;
  /** More host names to accept besides addresses and local names (KARKEDIKHA_MOBILE_ALLOWED_HOSTS). */
  extraAllowedHosts?: string[];
  pairLimits?: PairLimits;
  /** Added to every refused pairing, so guessing is slow even within the limits. */
  pairFailureDelayMs?: number;
  /** Finds the Tailscale HTTPS link (tests replace it). */
  secureLink?: (port: number) => Promise<SecureLinkStatus>;
  now?: () => number;
}

/** What the tray and the host log need: synchronous, no Tailscale lookup. */
export interface MobilePairingInfo {
  code: string;
  port: number;
  ip: string;
  url: string;
  pairedCount: number;
  connectedClients: number;
  /** True only while the HTTP server is actually bound; a pairing code exists either way. */
  listening: boolean;
}

/** The phone never sees Kandev's own identifiers or addresses. */
function stripKandevInternals(story: any): any {
  if (!story || typeof story !== 'object') return story;
  const { kandevTaskId: _omit, ...rest } = story;
  return rest;
}

/**
 * Which address the phone server listens on. The real install (its own profile under %LOCALAPPDATA%\KarkeDikha\desktop)
 * listens on the LAN so a phone can pair, unless the owner chose "Tailscale only": then it listens on loopback and only
 * the local `tailscale serve` proxy reaches it. Every other instance — smoke tests, the audit harness, a build run from a
 * scratch folder with its own profile — listens on loopback only. A LAN listener from a new program path makes Windows
 * Firewall ask "allow access?" again for every test build (2026-11-07: one prompt per remediation build), and a test
 * instance has no business being reachable from the network.
 */
export function defaultMobileHost(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  realDesktopDataDir: string,
  access: MobileAccessMode = 'lan',
): string {
  if (env.KARKEDIKHA_MOBILE_HOST?.trim()) return env.KARKEDIKHA_MOBILE_HOST.trim();
  if (env.KARKEDIKHA_DESKTOP_SMOKE_MODE === '1') return '127.0.0.1';
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  if (norm(dataDir) !== norm(realDesktopDataDir)) return '127.0.0.1';
  return access === 'tailscale' ? '127.0.0.1' : '0.0.0.0';
}

/** The saved access mode, or the default when the preference holds something else. */
export function parseMobileAccess(value: unknown): MobileAccessMode {
  return value === 'off' || value === 'tailscale' ? value : 'lan';
}

const COOKIE = 'kkd_session';
const SESSION_COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;
const MAX_JSON_BYTES = 64 * 1024;
/** 45 s of 16 kHz 16-bit mono is 1.4 MB; a 48 kHz float recording of the same length is under 9 MB. */
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const PING_MS = 15_000;
const TOKEN_FLUSH_MS = 120;
const STATE_DEBOUNCE_MS = 200;
const SECURE_LINK_CACHE_MS = 15_000;
const SUBMISSION_MEMORY_MS = 10 * 60_000;
const MAX_SUBMISSIONS = 200;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type SubmitOutcome = { ok: true; [k: string]: unknown } | { ok: false; status: number; error: string };

export class MobileServer {
  private server: http.Server | null = null;
  private readonly pairing: PairingStore;
  private readonly limiter: PairAttemptLimiter;
  private readonly assets: MobileAssets;
  private readonly streams = new Map<http.ServerResponse, { deviceId: string; ping: NodeJS.Timeout }>();
  private readonly activeSockets: Set<import('node:net').Socket> = new Set();
  private readonly options: MobileServerOptions;
  /** The configured port, or the one the system picked for port 0 once listening. */
  private port: number;
  private readonly host: string;
  private readonly session: DesktopSession;
  private readonly now: () => number;
  private unsubscribeSession: (() => void) | null = null;
  private readonly tokenBuffer = new Map<string, string>();
  private tokenTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private readonly submissions = new Map<string, { at: number; outcome: Promise<SubmitOutcome> }>();
  private secureCache: { at: number; value: SecureLinkStatus } | null = null;

  constructor(options: MobileServerOptions) {
    this.options = options;
    this.port = options.port ?? 3030;
    this.host = options.host ?? '0.0.0.0';
    this.session = options.session;
    this.now = options.now ?? Date.now;
    this.pairing = new PairingStore(PairingStore.fileIn(options.dataDir), this.now);
    this.limiter = new PairAttemptLimiter(options.pairLimits ?? DEFAULT_PAIR_LIMITS, this.now);
    this.assets = new MobileAssets(options.assetsDir ?? defaultMobileAssetsDir());
    // Only the count, so the drop can be confirmed after an upgrade; never a token or a code.
    const dropped = this.pairing.droppedOldLogins;
    if (dropped > 0) this.log(`[MOBILE] dropped ${dropped} phone login${dropped === 1 ? '' : 's'} from an older build`);
  }

  private log(message: string): void {
    if (typeof this.options.log === 'function') {
      this.options.log(message);
    }
  }

  /** The PC's address on the home network, or loopback when it has none. */
  public getPrimaryIp(): string {
    return pickLanAddress() ?? '127.0.0.1';
  }

  private listensOnNetwork(): boolean {
    return this.host === '0.0.0.0' || this.host === '::';
  }

  /**
   * The line the host log records for a started server: where it listens, never the pairing code. The code pairs a
   * phone from the LAN; written into desktop-host.log on every start it was readable by any local process and by
   * Pandesh's own file tools (Build 161 audit).
   */
  public static logLine(info: Pick<MobilePairingInfo, 'ip' | 'port'>): string {
    return `Pandesh Mobile server running at http://${info.ip}:${info.port}/ (pairing code shown in the app, not logged)`;
  }

  public getPairingInfo(): MobilePairingInfo {
    // A loopback-only instance is not reachable from a phone; do not advertise a LAN address it does not listen on.
    const ip = this.listensOnNetwork() ? this.getPrimaryIp() : this.host;
    const code = formatPairingCode(this.pairing.currentCode().code);
    return {
      code,
      port: this.port,
      ip,
      url: this.listensOnNetwork() ? `http://${ip}:${this.port}/?pair=${code}` : '',
      pairedCount: this.pairing.list().length,
      connectedClients: this.streams.size,
      listening: this.isRunning(),
    };
  }

  /** Everything the PC's Phone card shows. Looks up the Tailscale link (cached for a few seconds). */
  public async getPairingView(): Promise<MobilePairingView> {
    const info = this.getPairingInfo();
    const { expiresAt } = this.pairing.currentCode();
    const secure = await this.secureLinkStatus();
    const paused = this.limiter.pausedUntilMs();
    return {
      code: info.code,
      codeExpiresAt: new Date(expiresAt).toISOString(),
      port: info.port,
      ip: info.ip,
      url: info.url,
      secureUrl: secure.state === 'ready' && secure.url ? `${secure.url}?pair=${info.code}` : null,
      secure,
      localUrl: `http://127.0.0.1:${this.port}/`,
      access: this.options.access ?? (this.listensOnNetwork() ? 'lan' : 'tailscale'),
      pairedCount: info.pairedCount,
      connectedClients: info.connectedClients,
      listening: info.listening,
      devices: this.pairedDevices(),
      pairingPausedUntil: paused ? new Date(paused).toISOString() : null,
    };
  }

  public rotateCode(): void {
    this.pairing.rotateCode();
  }

  /** The paired phones, without a Tailscale lookup (also while phone access is off). */
  public pairedDevices(): MobilePairingView['devices'] {
    const connected = new Set([...this.streams.values()].map((s) => s.deviceId));
    return this.pairing.list().map((d) => ({ ...d, connected: connected.has(d.id) }));
  }

  /** Forgets one phone (or 'all') and closes its live connection at once. */
  public forgetDevice(id: string): number {
    const removed = this.pairing.forget(id);
    if (removed.length) {
      for (const [res, s] of this.streams) if (removed.includes(s.deviceId)) this.endStream(res);
      this.log(`[MOBILE] forgot ${removed.length} paired phone(s)`);
    }
    return removed.length;
  }

  /** Pairing was paused after too many wrong codes; the owner allows it again. */
  public resumePairing(): void {
    this.limiter.resume();
  }

  private async secureLinkStatus(): Promise<SecureLinkStatus> {
    const t = this.now();
    if (this.secureCache && t - this.secureCache.at < SECURE_LINK_CACHE_MS) return this.secureCache.value;
    const probe = this.options.secureLink ?? ((port: number) => detectSecureLink(port));
    let value: SecureLinkStatus;
    try {
      value = await probe(this.port);
    } catch {
      value = { state: 'error', url: null, detail: 'Could not read the Tailscale settings on this PC.' };
    }
    this.secureCache = { at: t, value };
    return value;
  }

  public async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => this.fail(req, res, err));
    });

    // Session events go to the phones as they happen (tokens batched, state coalesced).
    this.unsubscribeSession = this.session.onEvent((event: DesktopActivityEvent) => this.onSessionEvent(event));

    this.server.on('connection', (socket) => {
      this.activeSockets.add(socket);
      socket.on('close', () => {
        this.activeSockets.delete(socket);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(this.port, this.host, () => {
          this.server!.off('error', reject);
          const address = this.server!.address();
          if (address && typeof address === 'object') this.port = address.port;
          resolve();
        });
      });
    } catch (err) {
      // Port taken or address gone: leave nothing half-started, so a later start can try again.
      this.stop();
      throw err;
    }
  }

  public isRunning(): boolean {
    return this.server !== null && Boolean(this.server.listening);
  }

  public stop(): void {
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = null;
    }
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.tokenTimer = null;
    this.stateTimer = null;
    this.tokenBuffer.clear();
    for (const [res, s] of this.streams) {
      clearInterval(s.ping);
      try { res.destroy(); } catch { /* ignore */ }
    }
    this.streams.clear();

    for (const socket of this.activeSockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.activeSockets.clear();

    if (this.server) {
      try {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
      } catch { /* ignore */ }
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
    this.pairing.flush();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live updates (Server-Sent Events)

  private send(res: http.ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.endStream(res);
    }
  }

  private broadcast(event: string, data: unknown): void {
    for (const res of [...this.streams.keys()]) this.send(res, event, data);
  }

  private currentPhoneState(): unknown {
    try {
      return phoneState(this.session.snapshot());
    } catch {
      return null;
    }
  }

  private onSessionEvent(event: DesktopActivityEvent): void {
    if (this.streams.size === 0) return;
    if (event.kind === 'token') {
      if (!event.text) return;
      const key = event.attemptId ?? '';
      this.tokenBuffer.set(key, (this.tokenBuffer.get(key) ?? '') + event.text);
      if (!this.tokenTimer) this.tokenTimer = setTimeout(() => this.flushTokens(), TOKEN_FLUSH_MS);
      return;
    }
    // Tokens first, so a reply's last words arrive before its result.
    this.flushTokens();
    this.broadcast('activity', phoneEvent(event));
    this.scheduleState();
  }

  private flushTokens(): void {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    this.tokenTimer = null;
    for (const [attemptId, text] of this.tokenBuffer) this.broadcast('token', { attemptId, text });
    this.tokenBuffer.clear();
  }

  private scheduleState(): void {
    if (this.stateTimer || this.streams.size === 0) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      const state = this.currentPhoneState();
      if (state) this.broadcast('state', state);
    }, STATE_DEBOUNCE_MS);
  }

  private endStream(res: http.ServerResponse): void {
    const s = this.streams.get(res);
    if (!s) return;
    clearInterval(s.ping);
    this.streams.delete(res);
    try { res.end(); } catch { /* ignore */ }
    this.log('[MOBILE] SSE disconnected');
    this.options.onClientsChanged?.(this.streams.size);
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, device: PairedDevice): void {
    req.socket.setKeepAlive(true, 30_000);
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // Heartbeat as a real event, so the page can tell a silent dead connection from a quiet one.
    const ping = setInterval(() => this.send(res, 'ping', { t: this.now() }), PING_MS);
    this.streams.set(res, { deviceId: device.id, ping });
    this.send(res, 'hello', { serverTime: new Date(this.now()).toISOString(), device: { id: device.id, name: device.name }, secure: isSecureRequest(req) });
    const state = this.currentPhoneState();
    if (state) this.send(res, 'state', state);
    this.log('[MOBILE] SSE connected');
    this.options.onClientsChanged?.(this.streams.size);
    const close = () => this.endStream(res);
    req.on('close', close);
    res.on('close', close);
    res.on('error', close);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Request plumbing

  private fail(_req: http.IncomingMessage, res: http.ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Something went wrong on the PC.';
    if (!(err instanceof HttpError)) this.log(`[MOBILE] request failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      if (!res.headersSent) {
        this.json(res, status, { error: message }, status === 413 ? { Connection: 'close' } : undefined);
      } else {
        res.end();
      }
    } catch { /* ignore */ }
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra?: http.OutgoingHttpHeaders): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extra,
    });
    res.end(payload);
  }

  private readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        reject(new HttpError(413, 'That is too large to send.'));
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      req.on('data', (c: Buffer) => {
        if (failed) return;
        size += c.length;
        if (size > limit) {
          failed = true;
          reject(new HttpError(413, 'That is too large to send.'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
      req.on('error', (e) => { if (!failed) reject(e); });
    });
  }

  private async readJson(req: http.IncomingMessage): Promise<any> {
    if (!hasContentType(req, 'application/json')) throw new HttpError(415, 'Send JSON (Content-Type: application/json).');
    const raw = (await this.readBody(req, MAX_JSON_BYTES)).toString('utf8');
    if (!raw.trim()) return {};
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : {};
    } catch {
      throw new HttpError(400, 'That request is not valid JSON.');
    }
  }

  private sessionToken(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const match = cookieHeader.match(/(?:^|;\s*)kkd_session=([^;]+)/);
    if (!match || !match[1]) return null;
    try {
      return decodeURIComponent(match[1].trim());
    } catch {
      return null;
    }
  }

  private sessionCookie(req: http.IncomingMessage, token: string, maxAgeSeconds = SESSION_COOKIE_MAX_AGE_S): string {
    // Strict: only this app's own pages send it. Secure when the phone reached us over HTTPS (tailscale serve).
    return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isSecureRequest(req) ? '; Secure' : ''}`;
  }

  private serveAsset(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const asset = this.assets.get(pathname);
    if (!asset) {
      this.json(res, 404, { error: 'The phone app files are missing from this Pandesh build.' });
      return;
    }
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': asset.type,
      'Cache-Control': 'no-cache',
      ETag: asset.etag,
    };
    if (asset.isPage) {
      headers['Content-Security-Policy'] = PAGE_CSP;
      headers['Permissions-Policy'] = PAGE_PERMISSIONS_POLICY;
    }
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  }

  private sanitizeDownloadFilename(name: string): string {
    const stripped = String(name || '').replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').trim();
    return (stripped.length > 0 ? stripped : 'document').slice(0, 200);
  }

  /** RFC 6266 / RFC 8187: quoted ASCII fallback plus `filename*` carrying the real UTF-8 name when it is not plain ASCII. */
  private attachmentDisposition(title: string): string {
    // Drop DEL (missed by the control-character filter) and any lone surrogate the 200-unit cut may have left,
    // which would make encodeURIComponent throw.
    const name = this.sanitizeDownloadFilename(title)
      .replace(/\x7f/g, '_')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_');
    const fallback = name.replace(/[^\x20-\x7e]|%/g, '_');
    if (fallback === name) return `attachment; filename="${name}"`;
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }

  /** Single `bytes=` range per RFC 9110 §14. Returns null to ignore the header (serve the whole body). */
  private parseByteRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === '' && m[2] === '')) return null; // malformed or multi-range: ignored, not an error
    if (m[1] === '') {
      const suffix = Number(m[2]);
      if (suffix === 0 || size === 0) return 'unsatisfiable';
      return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(m[1]);
    const end = m[2] === '' ? size - 1 : Number(m[2]);
    if (m[2] !== '' && end < start) return null; // invalid range spec: ignored
    if (start >= size) return 'unsatisfiable';
    return { start, end: Math.min(end, size - 1) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sending a message: idempotent per client message id, and never left waiting behind running work.

  private submitOnce(id: string | null, run: () => Promise<SubmitOutcome>): Promise<SubmitOutcome> {
    const t = this.now();
    for (const [key, entry] of this.submissions) if (t - entry.at > SUBMISSION_MEMORY_MS) this.submissions.delete(key);
    if (id) {
      const seen = this.submissions.get(id);
      if (seen) return seen.outcome.then((o) => (o.ok ? { ...o, repeated: true } : o));
    }
    const outcome = run();
    if (id) {
      this.submissions.set(id, { at: t, outcome });
      while (this.submissions.size > MAX_SUBMISSIONS) {
        const oldest = this.submissions.keys().next().value;
        if (oldest === undefined) break;
        this.submissions.delete(oldest);
      }
    }
    return outcome;
  }

  private async runSubmit(text: string, voiceTurnId: string | undefined, workerId: string | undefined): Promise<SubmitOutcome> {
    try {
      const session = this.session as DesktopSession & { isBusy?: () => boolean };
      // Same as the desktop composer: while work runs, Stop wording stops it and anything else steers it, is answered
      // alongside it, or waits in Core's durable queue. The phone gets an answer at once instead of hanging.
      if (typeof session.isBusy === 'function' && session.isBusy() && typeof session.sendWhileRunning === 'function') {
        const routed = await session.sendWhileRunning(text);
        return { ok: true, ...routed };
      }
      // Never the desktop composer's staged files: those belong to the message being written on the PC.
      const result = await this.session.submitTask(text, workerId, voiceTurnId, 'mobile', []);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, status: 422, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(name, value);

    // Funnel would put this server on the public internet. Pandesh is only for the owner's own devices.
    if (isFunnelRequest(req)) {
      this.json(res, 403, { error: 'Pandesh is not served on the public internet. Turn off Tailscale Funnel.' });
      return;
    }
    const extraHosts = this.options.extraAllowedHosts
      ?? String(process.env.KARKEDIKHA_MOBILE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
    if (!isAllowedHost(req.headers.host, { viaLocalProxy: isLoopbackAddress(req.socket.remoteAddress), extraHosts })) {
      this.json(res, 421, { error: 'Unknown host name for Pandesh Mobile.' });
      return;
    }
    // No CORS: the app is served from this same origin, so no other site needs (or gets) access.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && MobileAssets.isAssetPath(pathname)) {
      this.serveAsset(req, res, pathname);
      return;
    }
    // Outside /api/ only the app's own files exist.
    if (!pathname.startsWith('/api/')) {
      this.json(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method === 'POST' && !originAllowed(req)) {
      this.json(res, 403, { error: 'Requests from other sites are refused.' });
      return;
    }

    // Public Status Endpoint: enough to tell "the PC answers" on a phone, nothing about what is on it.
    if (pathname === '/api/status' && req.method === 'GET') {
      let coreState = 'connecting';
      try { coreState = this.session.snapshot().coreState === 'connected' ? 'connected' : 'connecting'; } catch { /* starting */ }
      this.json(res, 200, { brand: 'Pandesh', assistant: 'Pandesh', ready: true, coreState, secure: isSecureRequest(req) });
      return;
    }

    // Pairing Endpoint
    if (pathname === '/api/pair' && req.method === 'POST') {
      const client = clientAddress(req);
      const gate = this.limiter.check(client);
      if (!gate.allowed) {
        const seconds = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
        const minutes = Math.ceil(seconds / 60);
        this.log(`[MOBILE] pair refused (${gate.reason === 'paused' ? 'pairing paused' : 'too many attempts'})`);
        this.json(res, 429, {
          ok: false,
          error: gate.reason === 'paused' ? 'pairing_paused' : 'too_many_attempts',
          message: gate.reason === 'paused'
            ? `Pairing is paused after too many wrong codes. Try again in ${minutes} min, or allow it again on your PC.`
            : `Too many wrong codes. Try again in ${minutes} min.`,
          retryAfterSeconds: seconds,
        }, { 'Retry-After': String(seconds) });
        return;
      }
      this.log('[MOBILE] pair requested');
      const body = await this.readJson(req);
      const result = this.pairing.tryPair(body.code, req.headers['user-agent']);
      if (!result.ok) {
        this.limiter.recordFailure(client);
        const delay = this.options.pairFailureDelayMs ?? 400;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        this.log(`[MOBILE] pair refused (${result.reason === 'expired' ? 'expired code' : 'wrong code'})`);
        this.json(res, 401, {
          ok: false,
          error: result.reason === 'expired' ? 'code_expired' : 'wrong_code',
          message: result.reason === 'expired'
            ? 'This code has expired. Show a new code on your PC and try again.'
            : 'That code is not right. Check the code on your PC.',
        });
        return;
      }
      this.limiter.recordSuccess(client);
      this.log('[MOBILE] pair success');
      res.setHeader('Set-Cookie', this.sessionCookie(req, result.token));
      this.json(res, 200, { ok: true, assistant: 'Pandesh', device: { id: result.device.id, name: result.device.name } });
      return;
    }

    // Session Verification Endpoint
    if (pathname === '/api/session' && req.method === 'GET') {
      const token = this.sessionToken(req);
      const device = this.pairing.verify(token);
      if (!device || !token) {
        this.json(res, 401, { ok: false, error: 'not_paired', message: 'This phone is not paired with your PC.' });
        return;
      }
      this.log('[MOBILE] session recognized');
      // Sliding: a phone in regular use never has to pair again.
      res.setHeader('Set-Cookie', this.sessionCookie(req, token));
      this.json(res, 200, { ok: true, brand: 'Pandesh', assistant: 'Pandesh', device: { id: device.id, name: device.name }, secure: isSecureRequest(req) });
      return;
    }

    // Logout Endpoint
    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = this.sessionToken(req);
      const device = this.pairing.verify(token);
      if (device) this.forgetDevice(device.id);
      else this.pairing.revokeToken(token);
      res.setHeader('Set-Cookie', this.sessionCookie(req, '', 0));
      this.json(res, 200, { ok: true });
      return;
    }

    // All endpoints below require a paired phone:
    const device = this.pairing.verify(this.sessionToken(req));
    if (!device) {
      this.json(res, 401, { ok: false, error: 'not_paired', message: 'Unauthorized: Mobile pairing required' });
      return;
    }

    // SSE Events Stream
    if (pathname === '/api/events' && req.method === 'GET') {
      this.log('[MOBILE] SSE authenticated');
      this.openStream(req, res, device);
      return;
    }

    // What the phone shows: connection to Core, model, running work, the decision waiting, the workspace name.
    if (pathname === '/api/state' && req.method === 'GET') {
      this.json(res, 200, phoneState(this.session.snapshot()));
      return;
    }

    // Snapshot (kept for older phone pages)
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      this.json(res, 200, this.session.snapshot());
      return;
    }

    // Live host telemetry (fresh sample; the phone polls this while its PC tab is open)
    if (pathname === '/api/telemetry' && req.method === 'GET') {
      try {
        const telemetry = await this.session.refreshHostTelemetry();
        this.json(res, 200, telemetry);
      } catch (err) {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Conversation Messages Endpoint
    if (pathname === '/api/messages' && req.method === 'GET') {
      this.log('[MOBILE] messages 200');
      const messages = await this.session.getActiveConversationMessages();
      let conversationId: string | null = null;
      try {
        const snap = this.session.snapshot();
        conversationId = snap.selectedConversationId ?? snap.activeConversationId ?? null;
      } catch { /* starting */ }
      this.json(res, 200, { conversationId, messages });
      return;
    }

    // Artifact Content (raster images inline; PDFs inline; everything else, including SVG, as a download)
    const artifactContentMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/content$/);
    if (artifactContentMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const artifactId = decodeURIComponent(artifactContentMatch[1]);
      const artifactCsp: http.OutgoingHttpHeaders = {
        'Content-Security-Policy': "sandbox; default-src 'none'",
      };
      try {
        const { kind, mimeType, bytes, title } = await this.session.getArtifactContent(artifactId);
        const isImage = kind === 'image' && mimeType.startsWith('image/');
        // Only these raster formats cannot execute script, so only they are safe to render inline.
        const isInlineRasterImage = isImage && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType);
        const isDocumentLike = kind === 'document' || kind === 'file';
        const isPdf = isDocumentLike && mimeType === 'application/pdf';
        const isDownloadableDocument = isDocumentLike && !isPdf;
        if (!isImage && !isPdf && !isDownloadableDocument) {
          res.writeHead(415, { 'Content-Type': 'application/json', ...artifactCsp });
          res.end(JSON.stringify({ error: 'Artifact kind cannot be served' }));
          return;
        }
        const headers: http.OutgoingHttpHeaders = {
          'Content-Type': mimeType,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Accept-Ranges': 'bytes',
          'Content-Length': bytes.length,
          ...artifactCsp,
        };
        // ?download=1 is the mobile page's Download control: always an attachment, never inline.
        if ((isPdf || isInlineRasterImage) && parsedUrl.searchParams.get('download') !== '1') {
          headers['Content-Disposition'] = 'inline';
        } else {
          headers['Content-Disposition'] = this.attachmentDisposition(title);
        }
        let status = 200;
        let body = bytes;
        // A validator-less resource cannot satisfy If-Range, so that request gets the full body (RFC 9110 §13.1.5).
        const rangeHeader = req.headers.range;
        if (typeof rangeHeader === 'string' && !req.headers['if-range']) {
          const range = this.parseByteRange(rangeHeader, bytes.length);
          if (range === 'unsatisfiable') {
            res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 });
            res.end();
            return;
          }
          if (range) {
            status = 206;
            body = bytes.subarray(range.start, range.end + 1);
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${bytes.length}`;
            headers['Content-Length'] = body.length;
          }
        }
        res.writeHead(status, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json', ...artifactCsp });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    // Submit Task / Message
    if ((pathname === '/api/submit' || pathname === '/api/messages') && req.method === 'POST') {
      const body = await this.readJson(req);
      const text = String(body.message || body.text || '').trim();
      if (!text) {
        this.json(res, 400, { ok: false, error: 'Message text is required' });
        return;
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        this.json(res, 413, { ok: false, error: 'That message is too long to send from the phone.' });
        return;
      }
      this.log('[MOBILE] submit accepted');
      const clientMessageId = typeof body.clientMessageId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.clientMessageId)
        ? body.clientMessageId
        : null;
      const voiceTurnId = typeof body.voiceTurnId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.voiceTurnId) ? body.voiceTurnId : undefined;
      const workerId = body.worker ? String(body.worker).trim() : undefined;
      const outcome = await this.submitOnce(clientMessageId, () => this.runSubmit(text, voiceTurnId, workerId));
      this.log('[MOBILE] result delivered');
      this.scheduleState();
      if (outcome.ok) this.json(res, 200, outcome);
      else this.json(res, outcome.status, { ok: false, error: outcome.error });
      return;
    }

    // Resolve the decision waiting in the conversation: a tool, an image or a weather lookup (as the PC shows it).
    if (pathname === '/api/approval' && req.method === 'POST') {
      const body = await this.readJson(req);
      const kind = body.kind === 'image' || body.kind === 'weather' ? body.kind : 'tool';
      const snap = this.session.snapshot();
      const waiting = kind === 'image' ? snap.pendingImageApproval?.approvalId
        : kind === 'weather' ? snap.pendingWeatherApproval?.approvalId
          : snap.pendingApproval?.approvalId || (snap.pendingApproval as any)?.id;
      const approvalId = String(body.approvalId || waiting || '').trim();
      if (!approvalId) {
        this.json(res, 400, { ok: false, error: 'No active approval' });
        return;
      }
      const resolution = body.resolution === 'approved' ? 'approved' : 'rejected';
      try {
        if (kind === 'image') await this.session.resolveImageApproval(approvalId, resolution);
        else if (kind === 'weather') await this.session.resolveWeatherApproval(approvalId, resolution);
        else await this.session.resolvePending(approvalId, resolution);
      } catch (err) {
        this.json(res, 409, {
          ok: false,
          error: 'This is no longer waiting for an answer. It may have been answered on the PC.',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      this.log(`[MOBILE] approval ${resolution} (${kind})`);
      const state = phoneState(this.session.snapshot());
      this.broadcast('state', state);
      this.json(res, 200, { ok: true, state });
      return;
    }

    // Stop the running work (the composer's Stop button).
    if (pathname === '/api/cancel' && req.method === 'POST') {
      await this.readJson(req);
      try {
        await this.session.cancel();
      } catch (err) {
        this.json(res, 409, { ok: false, error: err instanceof Error ? err.message : 'Nothing is running.' });
        return;
      }
      this.log('[MOBILE] stop requested');
      this.scheduleState();
      this.json(res, 200, { ok: true });
      return;
    }

    // Development stories (Kandev-run tasks): list + the decisions only a person can make.
    if (pathname === '/api/dev-stories' && req.method === 'GET') {
      const devStories = await this.session.getDevStories();
      const body = devStories && Array.isArray((devStories as any).stories)
        ? { ...(devStories as any), stories: (devStories as any).stories.map(stripKandevInternals) }
        : devStories;
      this.json(res, 200, body);
      return;
    }

    if (pathname === '/api/dev-stories/stop-all' && req.method === 'POST') {
      await this.readJson(req);
      const result = await this.session.stopAllDevStories();
      this.log('[MOBILE] dev-stories stop-all');
      this.json(res, 200, result);
      return;
    }

    const devStoryDetailMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)$/);
    if (devStoryDetailMatch && req.method === 'GET') {
      let detail: any;
      try {
        detail = await this.session.getDevStory(decodeURIComponent(devStoryDetailMatch[1]));
      } catch {
        this.json(res, 404, { error: 'Task not found' });
        return;
      }
      this.json(res, 200, detail && detail.story ? { ...detail, story: stripKandevInternals(detail.story) } : detail);
      return;
    }

    const devStoryPermissionMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)\/permissions\/([^/]+)$/);
    if (devStoryPermissionMatch && req.method === 'POST') {
      const storyId = decodeURIComponent(devStoryPermissionMatch[1]);
      const pendingId = decodeURIComponent(devStoryPermissionMatch[2]);
      let body: any;
      try { body = await this.readJson(req); } catch (err) { if (err instanceof HttpError && err.status !== 400) throw err; body = null; }
      if (!body || typeof body !== 'object' || typeof body.allow !== 'boolean') {
        this.json(res, 400, { error: 'allow must be true or false' });
        return;
      }
      const result = await this.session.decideDevStoryPermission(storyId, pendingId, body.allow, 'phone');
      this.json(res, 200, result);
      return;
    }

    const devStoryActionMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)\/(approve-review|retry|device-verified)$/);
    if (devStoryActionMatch && req.method === 'POST') {
      const storyId = decodeURIComponent(devStoryActionMatch[1]);
      const action = devStoryActionMatch[2];
      const body = await this.readJson(req);
      let result: { ok: boolean };
      if (action === 'approve-review') {
        result = await this.session.approveDevStoryReview(storyId);
      } else if (action === 'retry') {
        result = await this.session.retryDevStory(storyId);
      } else {
        result = await this.session.confirmDeviceVerification(storyId, body.ok !== false, typeof body.note === 'string' ? body.note : undefined);
      }
      this.log(`[MOBILE] dev-story ${action} ${storyId}`);
      this.json(res, 200, result);
      return;
    }

    // Voice Transcribe: a 16-bit PCM WAV the phone recorded (the page encodes it; Whisper reads nothing else).
    if (pathname === '/api/voice/transcribe' && req.method === 'POST') {
      if (!hasContentType(req, 'audio/wav', 'audio/x-wav', 'audio/wave')) {
        this.json(res, 415, { error: 'Send the recording as WAV audio.' });
        return;
      }
      const audio = await this.readBody(req, MAX_AUDIO_BYTES);
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        this.json(res, 400, { error: 'That recording is not WAV audio.' });
        return;
      }
      const turnHeader = req.headers['x-voice-turn-id'];
      const voiceTurnId = typeof turnHeader === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(turnHeader) ? turnHeader : undefined;
      try {
        const result = await this.session.transcribeUtteranceWavBase64(audio.toString('base64'), voiceTurnId);
        const transcript = String(result.transcript ?? '');
        // `text` repeats the transcript for pages written against the old field name.
        this.json(res, 200, { transcript, text: transcript, engine: result.engine, review: result.review ?? null });
      } catch (err) {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Voice Speak (TTS)
    if (pathname === '/api/voice/speak' && req.method === 'POST') {
      const body = await this.readJson(req);
      const text = String(body.text || '').trim();
      if (!text) {
        this.json(res, 400, { error: 'Text required' });
        return;
      }
      try {
        const speakResult = await this.session.speakText(text);
        if (speakResult.wavBase64) {
          const buffer = Buffer.from(speakResult.wavBase64, 'base64');
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
          res.end(buffer);
        } else {
          this.json(res, 200, speakResult);
        }
      } catch (err) {
        this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Unmatched
    this.json(res, 404, { error: 'Not found' });
  }
}

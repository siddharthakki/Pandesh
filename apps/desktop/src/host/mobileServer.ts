import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { DesktopSession } from './desktopSession';
import type { RuntimeEventRecord } from '../../../../core/shared/wireTypes';

export interface MobileServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  session: DesktopSession;
  onClientsChanged?: (count: number) => void;
  log?: (message: string) => void;
}

export interface MobilePairingInfo {
  code: string;
  token?: string;
  port: number;
  ip: string;
  url: string;
  pairedCount: number;
  connectedClients: number;
}

/** The phone never sees Kandev's own identifiers or addresses. */
function stripKandevInternals(story: any): any {
  if (!story || typeof story !== 'object') return story;
  const { kandevTaskId: _omit, ...rest } = story;
  return rest;
}

export class MobileServer {
  private server: http.Server | null = null;
  private pairingCode: string;
  private pairingToken: string;
  private sessions: Set<string> = new Set();
  private sseClients: Set<http.ServerResponse> = new Set();
  private activeSockets: Set<import('node:net').Socket> = new Set();
  private readonly options: MobileServerOptions;
  private readonly port: number;
  private readonly host: string;
  private readonly dataDir: string;
  private readonly session: DesktopSession;
  private unsubscribeSession: (() => void) | null = null;

  constructor(options: MobileServerOptions) {
    this.options = options;
    this.port = options.port ?? 3030;
    this.host = options.host ?? '0.0.0.0';
    this.dataDir = options.dataDir;
    this.session = options.session;

    // Load or generate pairing code (6 alphanumeric characters uppercase, unambiguous)
    const pairFile = path.join(this.dataDir, 'mobile-pair.json');
    let loaded: { code?: string; token?: string; sessions?: string[]; pairedTokens?: string[] } = {};
    try {
      if (fs.existsSync(pairFile)) {
        loaded = JSON.parse(fs.readFileSync(pairFile, 'utf8'));
      }
    } catch {
      // ignore
    }

    this.pairingCode = loaded.code && /^[A-Z0-9]{4,6}$/.test(loaded.code)
      ? loaded.code
      : this.generateCode();
    this.pairingToken = loaded.token || crypto.randomBytes(24).toString('base64url');
    if (Array.isArray(loaded.sessions)) {
      for (const s of loaded.sessions) this.sessions.add(s);
    }
    if (Array.isArray(loaded.pairedTokens)) {
      for (const t of loaded.pairedTokens) this.sessions.add(t);
    }
    this.sessions.add(this.pairingToken);
    this.savePairFile();
  }

  private generateCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // exclude 0, 1, I, O for clarity
    let code = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  private savePairFile(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const pairFile = path.join(this.dataDir, 'mobile-pair.json');
      fs.writeFileSync(pairFile, JSON.stringify({
        code: this.pairingCode,
        token: this.pairingToken,
        sessions: Array.from(this.sessions),
        updatedAt: new Date().toISOString(),
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // ignore
    }
  }

  private log(message: string): void {
    if (typeof this.options.log === 'function') {
      this.options.log(message);
    }
  }

  public getPrimaryIp(): string {
    const interfaces = os.networkInterfaces();
    // 1. First pass: look for non-virtual physical adapter (e.g. Ethernet, Wi-Fi) on standard LAN
    for (const name of Object.keys(interfaces)) {
      if (/vEthernet|WSL|Hyper-V|virtual|docker|vpn|loopback/i.test(name)) continue;
      for (const iface of interfaces[name] ?? []) {
        if (!iface.internal && iface.family === 'IPv4') {
          return iface.address;
        }
      }
    }
    // 2. Second pass: any non-internal IPv4
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (!iface.internal && iface.family === 'IPv4') {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  public getPairingInfo(): MobilePairingInfo {
    const ip = this.getPrimaryIp();
    const liveSockets = this.sseClients.size;
    return {
      code: this.pairingCode,
      token: this.pairingToken,
      port: this.port,
      ip,
      url: `http://${ip}:${this.port}/?pair=${this.pairingCode}`,
      pairedCount: liveSockets,
      connectedClients: liveSockets,
    };
  }

  public async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        } catch {
          // ignore
        }
      });
    });

    // Subscribe to session events to push to mobile SSE clients
    this.unsubscribeSession = this.session.onEvent((event: RuntimeEventRecord) => {
      this.broadcastSse('session_event', event);
    });

    this.server.on('connection', (socket) => {
      this.activeSockets.add(socket);
      socket.on('close', () => {
        this.activeSockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  public isRunning(): boolean {
    return this.server !== null && Boolean(this.server.listening);
  }

  public stop(): void {
    if (this.unsubscribeSession) {
      this.unsubscribeSession();
      this.unsubscribeSession = null;
    }
    for (const client of this.sseClients) {
      try {
        client.destroy();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();

    if (this.server) {
      try {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
      } catch {}
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }

  private broadcastSse(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private extractSessionId(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)kkd_session=([^;]+)/);
      if (match && match[1]) {
        return decodeURIComponent(match[1].trim());
      }
    }
    return null;
  }

  private checkSession(req: http.IncomingMessage): boolean {
    const sessionId = this.extractSessionId(req);
    if (sessionId && this.sessions.has(sessionId)) {
      return true;
    }
    return false;
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

  private async parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  private async parseBinaryBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers for local network development / PWA
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // Static Assets & App (no-cache so updates apply immediately on phone and PC browsers)
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(this.renderMobileHtml(parsedUrl.searchParams.get('pair') || ''));
      return;
    }

    if (pathname === '/assets/pan-da-hero.png' || pathname === '/assets/pan-da-face.png') {
      // Bundled host is apps/desktop/out/main.js; the renderer assets sit beside it.
      const name = path.basename(pathname);
      const assetPath = [path.resolve(__dirname, '..', 'renderer', 'assets', name), path.resolve(process.cwd(), 'apps', 'desktop', 'renderer', 'assets', name)]
        .find((candidate) => fs.existsSync(candidate));
      if (assetPath) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(assetPath).pipe(res);
        return;
      }
    }

    // Public Status Endpoint
    if (pathname === '/api/status' && req.method === 'GET') {
      const snap = this.session.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        brand: 'KarkeDikha',
        assistant: 'Pandesh',
        ready: true,
        model: snap.selectedModel,
        workspace: snap.workspaceRoot || 'No workspace selected',
        coreState: snap.coreConnected ? 'connected' : 'connecting',
      }));
      return;
    }

    // Pairing Endpoint
    if (pathname === '/api/pair' && req.method === 'POST') {
      this.log('[MOBILE] pair requested');
      const body = await this.parseJsonBody(req);
      const inputCode = String(body.code || '').trim().toUpperCase();
      if (inputCode === this.pairingCode) {
        const sessionId = crypto.randomBytes(32).toString('hex');
        this.sessions.add(sessionId);
        this.savePairFile();
        this.log('[MOBILE] pair success');
        res.setHeader('Set-Cookie', `kkd_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          session: sessionId,
          brand: 'KarkeDikha',
          assistant: 'Pandesh',
        }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid pairing PIN' }));
      }
      return;
    }

    // Session Verification Endpoint
    if (pathname === '/api/session' && req.method === 'GET') {
      if (!this.checkSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Mobile pairing required' }));
        return;
      }
      this.log('[MOBILE] session recognized');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, brand: 'KarkeDikha', assistant: 'Pandesh' }));
      return;
    }

    // Logout Endpoint
    if (pathname === '/api/logout' && req.method === 'POST') {
      const sessionId = this.extractSessionId(req);
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.savePairFile();
      }
      res.setHeader('Set-Cookie', 'kkd_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // All endpoints below require a valid session:
    if (!this.checkSession(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Mobile pairing required' }));
      return;
    }

    // SSE Events Stream
    if (pathname === '/api/events' && req.method === 'GET') {
      this.log('[MOBILE] SSE authenticated');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
      this.sseClients.add(res);
      this.log('[MOBILE] SSE connected');
      this.options.onClientsChanged?.(this.sseClients.size);

      // Heartbeat every 15 seconds keeps socket alive over mobile Wi-Fi / NAT gateways
      const heartbeatTimer = setInterval(() => {
        try {
          res.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeatTimer);
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeatTimer);
        this.sseClients.delete(res);
        this.log('[MOBILE] SSE disconnected');
        this.options.onClientsChanged?.(this.sseClients.size);
      });
      return;
    }

    // Snapshot
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      const snap = this.session.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap));
      return;
    }

    // Live host telemetry (fresh sample; the phone polls this while the PC Health tab is open)
    if (pathname === '/api/telemetry' && req.method === 'GET') {
      try {
        const telemetry = await this.session.refreshHostTelemetry();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(telemetry));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Conversation Messages Endpoint
    if (pathname === '/api/messages' && req.method === 'GET') {
      this.log('[MOBILE] messages 200');
      const messages = await this.session.getActiveConversationMessages();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
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
      this.log('[MOBILE] submit accepted');
      const body = await this.parseJsonBody(req);
      const text = String(body.message || body.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message text is required' }));
        return;
      }
      const voiceTurnId = body.voiceTurnId ? String(body.voiceTurnId) : undefined;
      const workerId = body.worker ? String(body.worker).trim() : undefined;
      const result = await this.session.submitTask(text, workerId, voiceTurnId, 'mobile');
      this.log('[MOBILE] result delivered');
      // Also broadcast snapshot update to all SSE clients
      this.broadcastSse('snapshot_update', this.session.snapshot());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Resolve Approval
    if (pathname === '/api/approval' && req.method === 'POST') {
      const body = await this.parseJsonBody(req);
      const snap = this.session.snapshot();
      const approvalId = String(body.approvalId || snap.pendingApproval?.approvalId || (snap.pendingApproval as any)?.id || '').trim();
      if (!approvalId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No active approval' }));
        return;
      }
      const resolution = body.resolution === 'rejected' ? 'rejected' : 'approved';
      await this.session.resolvePending(approvalId, resolution);
      const updatedSnap = this.session.snapshot();
      this.broadcastSse('snapshot_update', updatedSnap);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updatedSnap));
      return;
    }

    // Development stories (Kandev-run tasks): list + the decisions only a person can make.
    if (pathname === '/api/dev-stories' && req.method === 'GET') {
      const devStories = await this.session.getDevStories();
      const body = devStories && Array.isArray((devStories as any).stories)
        ? { ...(devStories as any), stories: (devStories as any).stories.map(stripKandevInternals) }
        : devStories;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    if (pathname === '/api/dev-stories/stop-all' && req.method === 'POST') {
      const result = await this.session.stopAllDevStories();
      this.log('[MOBILE] dev-stories stop-all');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    const devStoryDetailMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)$/);
    if (devStoryDetailMatch && req.method === 'GET') {
      let detail: any;
      try {
        detail = await this.session.getDevStory(decodeURIComponent(devStoryDetailMatch[1]));
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail && detail.story ? { ...detail, story: stripKandevInternals(detail.story) } : detail));
      return;
    }

    const devStoryPermissionMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)\/permissions\/([^/]+)$/);
    if (devStoryPermissionMatch && req.method === 'POST') {
      const storyId = decodeURIComponent(devStoryPermissionMatch[1]);
      const pendingId = decodeURIComponent(devStoryPermissionMatch[2]);
      let body: any;
      try { body = await this.parseJsonBody(req); } catch { body = null; }
      if (!body || typeof body !== 'object' || typeof body.allow !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'allow must be true or false' }));
        return;
      }
      const result = await this.session.decideDevStoryPermission(storyId, pendingId, body.allow, 'phone');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    const devStoryActionMatch = pathname.match(/^\/api\/dev-stories\/([^/]+)\/(approve-review|retry|device-verified)$/);
    if (devStoryActionMatch && req.method === 'POST') {
      const storyId = decodeURIComponent(devStoryActionMatch[1]);
      const action = devStoryActionMatch[2];
      const body = await this.parseJsonBody(req);
      let result: { ok: boolean };
      if (action === 'approve-review') {
        result = await this.session.approveDevStoryReview(storyId);
      } else if (action === 'retry') {
        result = await this.session.retryDevStory(storyId);
      } else {
        result = await this.session.confirmDeviceVerification(storyId, body.ok !== false, typeof body.note === 'string' ? body.note : undefined);
      }
      this.log(`[MOBILE] dev-story ${action} ${storyId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Voice Transcribe
    if (pathname === '/api/voice/transcribe' && req.method === 'POST') {
      const audioBuffer = await this.parseBinaryBody(req);
      if (!audioBuffer || audioBuffer.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audio data required' }));
        return;
      }
      try {
        const transResult = await this.session.transcribeUtteranceWavBase64(audioBuffer.toString('base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(transResult));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Voice Speak (TTS)
    if (pathname === '/api/voice/speak' && req.method === 'POST') {
      const body = await this.parseJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Text required' }));
        return;
      }
      try {
        const speakResult = await this.session.speakText(text);
        if (speakResult.wavBase64) {
          const buffer = Buffer.from(speakResult.wavBase64, 'base64');
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buffer.length });
          res.end(buffer);
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(speakResult));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Unmatched
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private renderMobileHtml(initialPairCode: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#030b14">
  <title>KarkeDikha — Pandesh</title>
  <style>
    :root {
      --bg: #030b14;
      --card-bg: rgba(10, 25, 45, 0.85);
      --card-border: rgba(0, 229, 255, 0.2);
      --accent: #00e5ff;
      --accent-glow: rgba(0, 229, 255, 0.4);
      --text: #e6f1ff;
      --muted: #8892b0;
      --success: #00e676;
      --error: #ff5252;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }
    header {
      background: rgba(3, 11, 20, 0.95);
      border-bottom: 1px solid var(--card-border);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      backdrop-filter: blur(12px);
      z-index: 10;
    }
    .brand-wrap { display: flex; align-items: center; gap: 10px; }
    .brand-avatar {
      width: 34px; height: 34px; border-radius: 50%;
      border: 1.5px solid var(--accent);
      box-shadow: 0 0 10px var(--accent-glow);
      overflow: hidden; background: #000;
    }
    .brand-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .brand-title { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; color: #fff; }
    .brand-sub { font-size: 11px; color: var(--accent); font-family: monospace; }
    .status-badge {
      font-size: 11px; padding: 4px 10px; border-radius: 12px;
      background: rgba(0, 230, 118, 0.15); color: var(--success);
      border: 1px solid rgba(0, 230, 118, 0.3); font-weight: 600;
      white-space: nowrap;
    }
    .status-badge.offline {
      background: rgba(255, 82, 82, 0.15); color: var(--error);
      border-color: rgba(255, 82, 82, 0.3);
    }
    .status-badge.connecting {
      background: rgba(255, 171, 0, 0.15); color: #ffab00;
      border-color: rgba(255, 171, 0, 0.3);
    }
    nav.tabs-bar {
      display: flex; background: rgba(5, 18, 32, 0.9);
      border-bottom: 1px solid var(--card-border);
    }
    .tab-btn {
      flex: 1; padding: 10px; border: none; background: transparent;
      color: var(--muted); font-size: 13px; font-weight: 600;
      border-bottom: 2px solid transparent; transition: all 0.2s;
    }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); background: rgba(0, 229, 255, 0.05); }
    main { flex: 1; overflow-y: auto; padding: 16px; position: relative; }
    .view-surface { display: none; height: 100%; flex-direction: column; }
    .view-surface.active { display: flex; }
    
    /* Pairing screen */
    .pair-card {
      margin: auto; max-width: 340px; padding: 24px;
      background: var(--card-bg); border: 1px solid var(--card-border);
      border-radius: 16px; text-align: center;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .pair-mascot {
      width: 72px; height: 72px; margin: 0 auto 16px;
      border-radius: 50%; border: 2px solid var(--accent);
      box-shadow: 0 0 16px var(--accent-glow); overflow: hidden;
    }
    .pair-mascot img { width: 100%; height: 100%; object-fit: cover; }
    .pair-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
    .pair-desc { font-size: 13px; color: var(--muted); margin-bottom: 20px; line-height: 1.4; }
    .pair-input {
      width: 100%; padding: 12px; font-size: 20px; text-align: center;
      letter-spacing: 4px; font-family: monospace; font-weight: 700;
      background: rgba(0, 0, 0, 0.4); border: 1.5px solid var(--card-border);
      border-radius: 8px; color: var(--accent); text-transform: uppercase;
      margin-bottom: 16px; outline: none;
    }
    .pair-input:focus { border-color: var(--accent); box-shadow: 0 0 8px var(--accent-glow); }
    .btn-pair {
      width: 100%; padding: 12px; font-size: 15px; font-weight: 600;
      background: var(--accent); color: #000; border: none; border-radius: 8px;
      cursor: pointer; transition: transform 0.1s, opacity 0.2s;
    }
    .btn-pair:active { transform: scale(0.98); }

    /* Conversation feed */
    .chat-feed { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-bottom: 80px; }
    .msg-bubble {
      max-width: 85%; padding: 12px 14px; border-radius: 14px; font-size: 14px;
      line-height: 1.45; word-wrap: break-word; white-space: pre-wrap;
    }
    .msg-user {
      align-self: flex-end; background: #0052cc; color: #fff;
      border-bottom-right-radius: 2px;
    }
    .msg-assistant {
      align-self: flex-start; background: rgba(16, 36, 60, 0.9);
      border: 1px solid var(--card-border); color: var(--text);
      border-bottom-left-radius: 2px;
    }
    .msg-meta { font-size: 10px; color: var(--muted); margin-top: 4px; font-family: monospace; }

    /* Approvals Card */
    .approval-card {
      background: rgba(255, 171, 0, 0.12); border: 1.5px solid rgba(255, 171, 0, 0.5);
      border-radius: 12px; padding: 14px; margin-bottom: 12px;
    }
    .approval-tag { color: #ffab00; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .approval-tool { font-family: monospace; font-size: 14px; font-weight: 600; margin: 4px 0; }
    .approval-scope { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
    .approval-actions { display: flex; gap: 8px; }
    .btn-approve {
      flex: 1; padding: 10px; background: var(--success); color: #000;
      border: none; border-radius: 8px; font-weight: 700; font-size: 13px;
    }
    .btn-deny {
      flex: 1; padding: 10px; background: rgba(255, 82, 82, 0.2); color: var(--error);
      border: 1px solid rgba(255, 82, 82, 0.4); border-radius: 8px; font-weight: 700; font-size: 13px;
    }

    /* Tasks list */
    .task-card {
      background: rgba(16, 36, 60, 0.6); border: 1px solid var(--card-border);
      border-radius: 10px; padding: 10px 12px;
    }
    .task-title { font-size: 13px; font-weight: 700; }
    .task-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .task-detail { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .task-action-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .task-btn {
      padding: 7px 12px; font-size: 12px; font-weight: 700; border-radius: 8px; cursor: pointer;
    }
    .task-btn.approve { background: var(--success); color: #000; border: none; }
    .task-btn.deny { background: rgba(255, 82, 82, 0.2); color: var(--error); border: 1px solid rgba(255, 82, 82, 0.4); }
    .task-btn.neutral { background: rgba(0, 229, 255, 0.15); color: var(--accent); border: 1px solid var(--accent); }
    .task-card, .task-panel { overflow-wrap: anywhere; word-break: break-word; min-width: 0; }
    .task-card { cursor: pointer; }
    .task-panel { background: rgba(16, 36, 60, 0.9); border: 1px solid var(--accent); border-radius: 10px; padding: 12px; margin-top: 10px; font-size: 12px; }
    .task-panel h4 { font-size: 13px; margin-bottom: 4px; }
    .task-panel ul { list-style: none; display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
    .task-timeline-item { border-left: 2px solid var(--accent); padding-left: 8px; }
    .task-pending { font-family: monospace; font-size: 11px; color: var(--text); align-self: center; }

    /* Composer */
    .composer-wrap {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: rgba(3, 11, 20, 0.96); border-top: 1px solid var(--card-border);
      padding: 10px 14px; display: flex; align-items: center; gap: 8px;
      backdrop-filter: blur(12px);
    }
    .composer-input {
      flex: 1; padding: 12px 14px; background: rgba(10, 25, 45, 0.9);
      border: 1px solid var(--card-border); border-radius: 24px;
      color: #fff; font-size: 14px; outline: none;
    }
    .composer-input:focus { border-color: var(--accent); }
    .composer-btn {
      width: 42px; height: 42px; border-radius: 50%; border: none;
      background: var(--accent); color: #000; display: flex;
      align-items: center; justify-content: center; cursor: pointer;
    }
    .composer-btn.mic-btn {
      background: rgba(0, 229, 255, 0.15); color: var(--accent);
      border: 1px solid var(--accent);
    }
    .composer-btn.mic-btn.recording {
      background: var(--error); color: #fff; border-color: var(--error);
      animation: pulse 1s infinite alternate;
    }
    @keyframes pulse { from { opacity: 0.6; } to { opacity: 1; } }

    /* Health & Missions cards */
    .info-card {
      background: var(--card-bg); border: 1px solid var(--card-border);
      border-radius: 12px; padding: 16px; margin-bottom: 12px;
    }
    .card-title { font-size: 14px; font-weight: 700; color: var(--accent); margin-bottom: 10px; }
    .metric-row { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .metric-row:last-child { border-bottom: none; }
    .metric-val { font-family: monospace; font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div class="brand-wrap">
      <div class="brand-avatar">
        <img src="/assets/pan-da-hero.png" alt="PAN-DA" />
      </div>
      <div>
        <div class="brand-title">KarkeDikha</div>
        <div class="brand-sub">Pandesh · Local Core</div>
      </div>
    </div>
    <div style="display:flex; align-items:center; gap:6px;">
      <button type="button" id="m-audio-toggle" class="status-badge" style="cursor:pointer; background:rgba(0,229,255,0.15); color:var(--accent); border:1px solid rgba(0,229,255,0.3);" title="Toggle phone voice">🔊 Voice</button>
      <div id="conn-status" class="status-badge connecting">Connecting…</div>
    </div>
  </header>

  <div style="padding: 4px 16px; background: rgba(3, 11, 20, 0.95); border-bottom: 1px solid var(--card-border);">
    <details id="diag-panel" style="font-size: 11px; color: var(--muted); background: rgba(5, 18, 32, 0.85); border: 1px solid var(--card-border); border-radius: 8px; padding: 4px 8px;">
      <summary style="cursor: pointer; user-select: none; font-weight: 600; color: var(--accent);">Diagnostics</summary>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin-top: 5px; font-family: monospace;">
        <span>Session:</span><span id="d-session" style="color:#fff;">checking</span>
        <span>Messages:</span><span id="d-messages" style="color:#fff;">—</span>
        <span>SSE:</span><span id="d-sse" style="color:#fff;">idle</span>
        <span>Last Event:</span><span id="d-event" style="color:#fff;">—</span>
      </div>
    </details>
  </div>

  <!-- Pairing screen -->
  <div id="pair-screen" class="view-surface" style="padding: 24px 0;">
    <div class="pair-card">
      <div class="pair-mascot">
        <img src="/assets/pan-da-face.png" alt="PAN-DA" />
      </div>
      <div class="pair-title">Pair with KarkeDikha</div>
      <div class="pair-desc">Enter the 4-digit PIN displayed on your PC screen to securely connect this phone to Pandesh.</div>
      <input type="text" id="pair-code-input" class="pair-input" maxlength="6" placeholder="PIN" value="${initialPairCode}" />
      <button type="button" id="pair-submit-btn" class="btn-pair">Connect to PC</button>
      <p id="pair-error" style="color:var(--error); font-size:12px; margin-top:12px;" hidden></p>
    </div>
  </div>

  <!-- Main app when paired -->
  <div id="app-container" style="display:none; height:100%; flex-direction:column; overflow:hidden;">
    <nav class="tabs-bar">
      <button type="button" class="tab-btn active" data-tab="chat">Conversation</button>
      <button type="button" class="tab-btn" data-tab="missions">Missions</button>
      <button type="button" class="tab-btn" data-tab="tasks">Tasks</button>
      <button type="button" class="tab-btn" data-tab="health">PC Health</button>
    </nav>

    <main>
      <!-- Chat Surface -->
      <div id="tab-chat" class="view-surface active">
        <!-- Live approval alert if pending -->
        <div id="mobile-approval-panel" class="approval-card" style="display:none;">
          <div class="approval-tag">Action Approval Required</div>
          <div id="appr-tool" class="approval-tool">—</div>
          <div id="appr-scope" class="approval-scope">—</div>
          <div class="approval-actions">
            <button type="button" id="appr-btn-approve" class="btn-approve">Approve</button>
            <button type="button" id="appr-btn-deny" class="btn-deny">Deny</button>
          </div>
        </div>

        <div id="chat-feed" class="chat-feed">
          <div class="msg-bubble msg-assistant">
            <div>Hello! I'm <strong>Pandesh</strong>, your personal AI assistant. I'm connected directly to your PC workspace. How can I help you today?</div>
            <div class="msg-meta">Pandesh · Local Core</div>
          </div>
        </div>

        <div class="composer-wrap">
          <button type="button" id="mic-btn" class="composer-btn mic-btn" title="Push to talk">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
            </svg>
          </button>
          <input type="text" id="mobile-msg-input" class="composer-input" placeholder="Ask Pandesh anything…" autocomplete="off" />
          <button type="button" id="mobile-send-btn" class="composer-btn" title="Send">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Missions Surface -->
      <div id="tab-missions" class="view-surface">
        <div class="info-card">
          <div class="card-title">ACTIVE WORKSPACE & MISSIONS</div>
          <div class="metric-row"><span>Repository</span><span id="m-workspace" class="metric-val">—</span></div>
          <div class="metric-row"><span>Local Model</span><span id="m-model" class="metric-val">—</span></div>
          <div class="metric-row"><span>Active Phase</span><span id="m-phase" class="metric-val">Idle</span></div>
        </div>

        <div class="info-card">
          <div class="card-title">RECENT ACTIVITY</div>
          <div id="m-activity-list" style="font-size:12px; font-family:monospace; color:var(--muted); line-height:1.6;">
            <div>Standing by…</div>
          </div>
        </div>
      </div>

      <!-- Tasks Surface (Kandev-run development stories: status + the decisions only a person can make) -->
      <div id="tab-tasks" class="view-surface">
        <div class="info-card">
          <div class="card-title" id="tasks-title">DEVELOPMENT TASKS</div>
          <div class="task-action-row" style="margin:0 0 10px 0;"><button type="button" class="task-btn deny" data-action="stop-all">Stop all</button></div>
          <div id="tasks-counts" style="font-size:12px; color:var(--muted); margin-bottom:10px;">—</div>
          <ul id="tasks-list" style="list-style:none; display:flex; flex-direction:column; gap:10px;"></ul>
          <div id="tasks-empty" style="font-size:12px; color:var(--muted);">No development tasks yet.</div>
        </div>
        <div id="task-detail" class="task-panel" style="display:none;"></div>
      </div>

      <!-- Health Surface -->
      <div id="tab-health" class="view-surface">
        <div class="info-card">
          <div class="card-title">WINDOWS PC TELEMETRY</div>
          <div class="metric-row"><span>CPU Load</span><span id="h-cpu" class="metric-val">—</span></div>
          <div class="metric-row"><span>System RAM</span><span id="h-ram" class="metric-val">—</span></div>
          <div class="metric-row"><span>GPU</span><span id="h-gpu" class="metric-val">—</span></div>
          <div class="metric-row"><span>GPU Load / Temp</span><span id="h-gpu-load" class="metric-val">—</span></div>
          <div class="metric-row"><span>GPU VRAM</span><span id="h-vram" class="metric-val">—</span></div>
          <div class="metric-row"><span>Storage</span><span id="h-disk" class="metric-val">—</span></div>
          <div id="h-status" class="metric-row" style="color:var(--muted);font-size:0.75rem;"><span>Loading…</span></div>
        </div>
        <div class="info-card">
          <div class="card-title">LOCAL AI SERVICES</div>
          <div class="metric-row"><span>Ollama Engine</span><span id="h-ollama" class="metric-val">—</span></div>
        </div>
      </div>
    </main>
  </div>

  <script>
    (function() {
      var pairScreen = document.getElementById('pair-screen');
      var appContainer = document.getElementById('app-container');
      var connStatus = document.getElementById('conn-status');
      var pairInput = document.getElementById('pair-code-input');
      var pairBtn = document.getElementById('pair-submit-btn');
      var pairError = document.getElementById('pair-error');
      var chatFeed = document.getElementById('chat-feed');
      var msgInput = document.getElementById('mobile-msg-input');
      var sendBtn = document.getElementById('mobile-send-btn');
      var micBtn = document.getElementById('mic-btn');
      var approvalPanel = document.getElementById('mobile-approval-panel');
      var currentApproval = null;
      var sseSource = null;
      var renderedMessageIds = new Set();
      var audioEnabled = true;

      // Diagnostics elements
      var dSession = document.getElementById('d-session');
      var dMessages = document.getElementById('d-messages');
      var dSse = document.getElementById('d-sse');
      var dEvent = document.getElementById('d-event');

      function updateDiag(field, value) {
        if (field === 'session' && dSession) dSession.textContent = value;
        if (field === 'messages' && dMessages) dMessages.textContent = value;
        if (field === 'sse' && dSse) dSse.textContent = value;
        if (field === 'event' && dEvent) dEvent.textContent = value;
      }

      function setStatus(text, statusClass) {
        if (!connStatus) return;
        connStatus.textContent = text;
        connStatus.className = 'status-badge ' + (statusClass || '');
      }

      function showPairingScreen(reason) {
        if (sseSource) {
          try { sseSource.close(); } catch (e) {}
          sseSource = null;
        }
        if (pairScreen) pairScreen.style.display = 'flex';
        if (appContainer) appContainer.style.display = 'none';
        if (reason) {
          setStatus(reason, 'offline');
        }
      }

      function showConnectedScreen() {
        if (pairScreen) pairScreen.style.display = 'none';
        if (appContainer) appContainer.style.display = 'flex';
        setStatus('Connected', 'connected');
      }

      // Tab navigation
      var tabs = document.querySelectorAll('.tab-btn');
      tabs.forEach(function(btn) {
        btn.addEventListener('click', function() {
          tabs.forEach(function(t) { t.classList.remove('active'); });
          btn.classList.add('active');
          var targetTab = btn.getAttribute('data-tab');
          document.querySelectorAll('.view-surface').forEach(function(s) { s.classList.remove('active'); });
          var activeSurface = document.getElementById('tab-' + targetTab);
          if (activeSurface) activeSurface.classList.add('active');
          if (targetTab === 'tasks') { startTasksPolling(); } else { stopTasksPolling(); }
          if (targetTab === 'health') { startHealthPolling(); } else { stopHealthPolling(); }
        });
      });

      // PC Health: live host readings, polled only while the tab is visible.
      var healthPollTimer = null;
      var healthFailures = 0;

      function startHealthPolling() {
        loadHealth();
        if (healthPollTimer) return;
        healthPollTimer = setInterval(loadHealth, 3000);
      }

      function stopHealthPolling() {
        if (healthPollTimer) {
          clearInterval(healthPollTimer);
          healthPollTimer = null;
        }
      }

      function healthBytes(b) {
        if (b == null || !isFinite(b)) return null;
        return (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + ' GB';
      }

      function setHealth(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      }

      function renderHealth(t) {
        var cpu = t.cpu || {};
        setHealth('h-cpu', cpu.available && cpu.value != null ? cpu.value + '%' : (cpu.detail || 'Unavailable'));
        var mem = t.memory || {};
        setHealth('h-ram', mem.available ? mem.usedPercent + '% · ' + healthBytes(mem.usedBytes) + ' / ' + healthBytes(mem.totalBytes) : 'Unavailable');
        var gpu = t.gpu || {};
        setHealth('h-gpu', gpu.available ? (gpu.name || 'GPU') : 'Unavailable');
        var load = [];
        if (gpu.usagePercent != null) load.push(gpu.usagePercent + '%');
        if (gpu.temperatureC != null) load.push(gpu.temperatureC + '°C');
        setHealth('h-gpu-load', load.length ? load.join(' · ') : 'Unavailable');
        setHealth('h-vram', gpu.vramUsedBytes != null && gpu.vramTotalBytes != null ? healthBytes(gpu.vramUsedBytes) + ' / ' + healthBytes(gpu.vramTotalBytes) : 'Unavailable');
        var disk = t.disk || {};
        setHealth('h-disk', disk.available ? disk.usedPercent + '% used · ' + healthBytes(disk.freeBytes) + ' free (' + String(disk.mount || '').replace(/\\\\$/, '') + ')' : (disk.blocker || 'Unavailable'));
        setHealth('h-ollama', t.ollama && t.ollama.reachable ? 'Connected' : 'Disconnected');
        var st = document.getElementById('h-status');
        if (st) st.firstChild.textContent = 'Live · updated ' + new Date(t.collectedAt).toLocaleTimeString();
      }

      async function loadHealth() {
        var st = document.getElementById('h-status');
        try {
          var res = await fetch('/api/telemetry', { cache: 'no-store' });
          if (res.status === 401) { showPairingScreen('Authentication failed'); return; }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          healthFailures = 0;
          renderHealth(await res.json());
        } catch (err) {
          healthFailures += 1;
          if (st) st.firstChild.textContent = 'Telemetry error: ' + (err && err.message ? err.message : err) + ' (retrying)';
        }
      }

      // Development tasks (Kandev-run stories): list + the decisions only a person can make,
      // including device verification steps that need this phone specifically.
      var tasksPollTimer = null;

      function startTasksPolling() {
        loadDevStories();
        if (tasksPollTimer) return;
        tasksPollTimer = setInterval(loadDevStories, 4000);
      }

      function stopTasksPolling() {
        if (tasksPollTimer) {
          clearInterval(tasksPollTimer);
          tasksPollTimer = null;
        }
      }

      async function postDevStoryAction(url, body) {
        var res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        return res;
      }

      function renderDevStories(data) {
        var list = document.getElementById('tasks-list');
        var empty = document.getElementById('tasks-empty');
        var counts = document.getElementById('tasks-counts');
        if (!list || !counts) return;
        var stories = (data && data.stories) || [];
        if (empty) empty.style.display = stories.length ? 'none' : 'block';
        var c = (data && data.counts) || {};
        var parts = [];
        ['running', 'completed', 'ready', 'waiting', 'verifying', 'blocked', 'review', 'approval'].forEach(function(key) {
          if (c[key]) parts.push(c[key] + ' ' + key);
        });
        counts.textContent = (data && data.available === false ? 'Kandev is not running · ' : '') + (parts.join(' · ') || (stories.length ? '' : 'Nothing running'));

        var rows = stories.map(function(s) {
          var li = document.createElement('li');
          li.className = 'task-card';
          li.setAttribute('data-story-id', s.id);
          li.addEventListener('click', function(ev) {
            if (ev.target && ev.target.closest && ev.target.closest('button')) return;
            openTaskDetail(s.id);
          });

          var title = document.createElement('div');
          title.className = 'task-title';
          title.textContent = s.title;
          li.appendChild(title);

          var proofLabel = { independent: 'independently verified', 'human-reviewed': 'reviewed by you', 'worker-only': 'worker tests only' }[s.verification] || '';
          var meta = document.createElement('div');
          meta.className = 'task-meta';
          meta.textContent = s.agent + ' · ' + (s.status === 'done' ? 'completed' : s.phase) + (proofLabel ? ' · ' + proofLabel : '') + (s.commit ? ' · ' + s.commit : '') + (s.deviceVerification && s.deviceVerification.state === 'awaiting' ? ' · awaiting device verification' : '');
          li.appendChild(meta);

          if (s.waitingReason) {
            var detail = document.createElement('div');
            detail.className = 'task-detail';
            detail.textContent = s.waitingReason;
            li.appendChild(detail);
          }

          if (s.status === 'delivery_approval') {
            var approveRow = document.createElement('div');
            approveRow.className = 'task-action-row';
            var approveBtn = document.createElement('button');
            approveBtn.type = 'button';
            approveBtn.className = 'task-btn approve';
            approveBtn.textContent = 'Approve after review';
            approveBtn.addEventListener('click', async function() {
              approveBtn.disabled = true;
              try { await postDevStoryAction('/api/dev-stories/' + encodeURIComponent(s.id) + '/approve-review'); } finally { loadDevStories(); }
            });
            approveRow.appendChild(approveBtn);
            li.appendChild(approveRow);
          }

          if (s.status === 'blocked' || s.status === 'delivery_approval') {
            var retryRow = document.createElement('div');
            retryRow.className = 'task-action-row';
            var retryBtn = document.createElement('button');
            retryBtn.type = 'button';
            retryBtn.className = 'task-btn neutral';
            retryBtn.setAttribute('data-action', 'retry');
            retryBtn.textContent = s.phase === 'stopped' ? 'Resume' : 'Retry';
            retryBtn.addEventListener('click', async function() {
              retryBtn.disabled = true;
              try { await postDevStoryAction('/api/dev-stories/' + encodeURIComponent(s.id) + '/retry'); } finally { loadDevStories(); }
            });
            retryRow.appendChild(retryBtn);
            li.appendChild(retryRow);
          }

          (s.pendingApprovals || []).forEach(function(p) {
            var row = document.createElement('div');
            row.className = 'task-action-row';
            var what = document.createElement('span');
            what.className = 'task-pending';
            what.textContent = p.what;
            var allowBtn = document.createElement('button');
            allowBtn.type = 'button';
            allowBtn.className = 'task-btn approve';
            allowBtn.textContent = 'Allow once';
            var denyBtn = document.createElement('button');
            denyBtn.type = 'button';
            denyBtn.className = 'task-btn deny';
            denyBtn.textContent = 'Deny';
            var decide = async function(allow) {
              allowBtn.disabled = denyBtn.disabled = true;
              try {
                await postDevStoryAction('/api/dev-stories/' + encodeURIComponent(s.id) + '/permissions/' + encodeURIComponent(p.pendingId), { allow: allow });
              } finally { loadDevStories(); }
            };
            allowBtn.addEventListener('click', function() { decide(true); });
            denyBtn.addEventListener('click', function() { decide(false); });
            row.appendChild(what);
            row.appendChild(allowBtn);
            row.appendChild(denyBtn);
            li.appendChild(row);
          });

          if (s.deviceVerification && s.deviceVerification.state === 'awaiting') {
            var deviceDetail = document.createElement('div');
            deviceDetail.className = 'task-detail';
            deviceDetail.textContent = 'Needs verification on this phone: ' + (s.deviceVerification.instructions || []).join('; ');
            li.appendChild(deviceDetail);

            var deviceRow = document.createElement('div');
            deviceRow.className = 'task-action-row';
            var passBtn = document.createElement('button');
            passBtn.type = 'button';
            passBtn.className = 'task-btn approve';
            passBtn.textContent = 'Verified on this phone';
            var failBtn = document.createElement('button');
            failBtn.type = 'button';
            failBtn.className = 'task-btn deny';
            failBtn.textContent = 'Failed on this phone';
            var decideDevice = async function(ok) {
              passBtn.disabled = failBtn.disabled = true;
              try { await postDevStoryAction('/api/dev-stories/' + encodeURIComponent(s.id) + '/device-verified', { ok: ok }); } finally { loadDevStories(); }
            };
            passBtn.addEventListener('click', function() { decideDevice(true); });
            failBtn.addEventListener('click', function() { decideDevice(false); });
            deviceRow.appendChild(passBtn);
            deviceRow.appendChild(failBtn);
            li.appendChild(deviceRow);
          }

          return li;
        });
        list.replaceChildren(...rows);
      }

      var openTaskId = null;

      function closeTaskDetail() {
        openTaskId = null;
        var panel = document.getElementById('task-detail');
        if (panel) { panel.style.display = 'none'; panel.removeAttribute('data-story-id'); panel.replaceChildren(); }
      }

      function textNode(tag, cls, text) {
        var el = document.createElement(tag);
        if (cls) el.className = cls;
        el.textContent = text;
        return el;
      }

      function renderTaskDetail(d) {
        var panel = document.getElementById('task-detail');
        if (!panel || !d || !d.story) return;
        var s = d.story;
        panel.setAttribute('data-story-id', s.id);
        panel.style.display = 'block';
        var kids = [];
        var head = document.createElement('div');
        head.className = 'task-action-row';
        head.style.marginTop = '0';
        head.appendChild(textNode('h4', '', s.title));
        var closeBtn = textNode('button', 'task-btn neutral', 'Close');
        closeBtn.type = 'button';
        closeBtn.id = 'task-detail-close';
        closeBtn.setAttribute('data-action', 'close-detail');
        closeBtn.addEventListener('click', closeTaskDetail);
        head.appendChild(closeBtn);
        kids.push(head);
        kids.push(textNode('div', 'task-meta', s.agent + ' · ' + (s.status === 'done' ? 'completed' : s.phase) + (s.commit ? ' · commit ' + s.commit : '')));
        if (s.waitingReason) kids.push(textNode('div', 'task-detail', s.waitingReason));
        if (s.attempts && s.attempts.failedVerifications) kids.push(textNode('div', 'task-detail', 'Failed verifications: ' + s.attempts.failedVerifications + ' of ' + s.attempts.maxCorrections + ' corrections used'));
        (s.pendingApprovals || []).forEach(function(p) {
          var row = document.createElement('div');
          row.className = 'task-action-row';
          row.appendChild(textNode('span', 'task-pending', 'Approval needed: ' + p.what));
          var allowBtn = textNode('button', 'task-btn approve', 'Allow once');
          allowBtn.type = 'button';
          allowBtn.setAttribute('data-action', 'allow');
          allowBtn.setAttribute('data-pending-id', p.pendingId);
          var denyBtn = textNode('button', 'task-btn deny', 'Deny');
          denyBtn.type = 'button';
          denyBtn.setAttribute('data-action', 'deny');
          denyBtn.setAttribute('data-pending-id', p.pendingId);
          var decide = async function(allow) {
            allowBtn.disabled = denyBtn.disabled = true;
            try {
              await postDevStoryAction('/api/dev-stories/' + encodeURIComponent(s.id) + '/permissions/' + encodeURIComponent(p.pendingId), { allow: allow });
            } finally { loadDevStories(); }
          };
          allowBtn.addEventListener('click', function() { decide(true); });
          denyBtn.addEventListener('click', function() { decide(false); });
          row.appendChild(allowBtn);
          row.appendChild(denyBtn);
          kids.push(row);
        });
        if (d.changedFiles && d.changedFiles.length) {
          kids.push(textNode('h4', '', 'Changed files'));
          kids.push(textNode('div', 'task-detail', d.changedFiles.join(', ')));
        }
        kids.push(textNode('h4', '', 'Timeline'));
        var tl = document.createElement('ul');
        (d.timeline || []).forEach(function(t) {
          var li = document.createElement('li');
          li.className = 'task-timeline-item';
          li.textContent = t.event + ' · ' + new Date(t.at).toLocaleString() + (t.text ? ' · ' + t.text : '');
          tl.appendChild(li);
        });
        kids.push(tl);
        panel.replaceChildren.apply(panel, kids);
      }

      async function openTaskDetail(id) {
        openTaskId = id;
        try {
          var res = await fetch('/api/dev-stories/' + encodeURIComponent(id));
          if (res.status === 401) { showPairingScreen('Authentication failed'); return; }
          if (!res.ok) { closeTaskDetail(); return; }
          var d = await res.json();
          if (openTaskId === id) renderTaskDetail(d);
        } catch (err) {}
      }

      document.addEventListener('click', async function(ev) {
        var t = ev.target;
        var btn = t && t.closest ? t.closest('[data-action="stop-all"]') : null;
        if (!btn) return;
        if (!window.confirm('Stop all development tasks? Nothing restarts until you resume it.')) return;
        btn.disabled = true;
        try { await postDevStoryAction('/api/dev-stories/stop-all'); } finally { btn.disabled = false; loadDevStories(); }
      });

      function refreshTasksNow() {
        var surface = document.getElementById('tab-tasks');
        if (!surface || !surface.classList.contains('active')) return;
        loadDevStories();
        if (openTaskId) openTaskDetail(openTaskId);
      }
      document.addEventListener('visibilitychange', refreshTasksNow);
      window.addEventListener('online', refreshTasksNow);
      window.addEventListener('focus', refreshTasksNow);

      async function loadDevStories() {
        try {
          var res = await fetch('/api/dev-stories');
          if (res.status === 401) {
            showPairingScreen('Authentication failed');
            return;
          }
          if (res.ok) {
            renderDevStories(await res.json());
          }
        } catch (err) {}
      }

      // Markdown renderer without unescaped template regex hazards
      function renderMobileMarkdown(text) {
        var wrap = document.createElement('div');
        var nl = String.fromCharCode(10);
        var cr = String.fromCharCode(13);
        var bt = String.fromCharCode(96);
        var lines = String(text || '').split(nl);
        for (var i = 0; i < lines.length; i++) {
          var rawLine = lines[i].split(cr).join('');
          var trimmed = rawLine.trim();
          var artifactMatch = trimmed.match(/^!\\[([^\\]]*)\\]\\(artifact:([\\w-]+)\\)\\s*$/);
          var docArtifactMatch = !artifactMatch ? trimmed.match(/^\\[([^\\]]*)\\]\\(artifact:([\\w-]+)\\)\\s*$/) : null;
          if (artifactMatch) {
            var img = document.createElement('img');
            img.src = '/api/artifacts/' + artifactMatch[2] + '/content';
            img.alt = artifactMatch[1] || 'image';
            img.style.maxWidth = '100%';
            img.style.borderRadius = '10px';
            img.style.display = 'block';
            img.style.marginTop = '6px';
            wrap.appendChild(img);
          } else if (docArtifactMatch) {
            // Two separate controls: Open (inline view in a new tab) and Download (?download=1 forces an attachment).
            var docHref = '/api/artifacts/' + docArtifactMatch[2] + '/content';
            var docRow = document.createElement('div');
            docRow.style.display = 'flex';
            docRow.style.flexWrap = 'wrap';
            docRow.style.alignItems = 'center';
            docRow.style.gap = '8px';
            docRow.style.marginTop = '6px';
            docRow.style.padding = '10px 12px';
            docRow.style.borderRadius = '10px';
            docRow.style.background = 'rgba(0, 229, 255, 0.08)';
            docRow.style.border = '1px solid rgba(0, 229, 255, 0.25)';
            docRow.style.fontSize = '13px';
            var docName = document.createElement('span');
            docName.style.flex = '1 1 140px';
            docName.style.minWidth = '0';
            docName.style.wordBreak = 'break-word';
            docName.textContent = '📄 ' + (docArtifactMatch[1] || 'Document');
            var makeDocAction = function (label) {
              var l = document.createElement('a');
              l.textContent = label;
              l.style.flexShrink = '0';
              l.style.padding = '8px 14px';
              l.style.borderRadius = '8px';
              l.style.background = 'rgba(0, 229, 255, 0.18)';
              l.style.color = '#e6f1ff';
              l.style.textDecoration = 'none';
              return l;
            };
            var docOpen = makeDocAction('Open');
            docOpen.href = docHref;
            docOpen.target = '_blank';
            docOpen.rel = 'noopener';
            var docDownload = makeDocAction('Download');
            docDownload.href = docHref + '?download=1';
            docDownload.download = docArtifactMatch[1] || 'document';
            docRow.appendChild(docName);
            docRow.appendChild(docOpen);
            docRow.appendChild(docDownload);
            wrap.appendChild(docRow);
          } else if (trimmed.startsWith('* ') || trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
            var li = document.createElement('div');
            li.style.paddingLeft = '8px';
            li.textContent = '• ' + trimmed.slice(2);
            wrap.appendChild(li);
          } else if (trimmed === '') {
            wrap.appendChild(document.createElement('br'));
          } else {
            var p = document.createElement('div');
            var tokens = rawLine.split('**');
            for (var j = 0; j < tokens.length; j++) {
              var part = tokens[j];
              if (j % 2 === 1 && part) {
                var bold = document.createElement('strong');
                bold.textContent = part;
                p.appendChild(bold);
              } else if (part) {
                var codeTokens = part.split(bt);
                for (var k = 0; k < codeTokens.length; k++) {
                  var sub = codeTokens[k];
                  if (k % 2 === 1 && sub) {
                    var codeEl = document.createElement('code');
                    codeEl.style.background = 'rgba(0,229,255,0.1)';
                    codeEl.style.padding = '1px 4px';
                    codeEl.style.borderRadius = '3px';
                    codeEl.style.fontFamily = 'monospace';
                    codeEl.textContent = sub;
                    p.appendChild(codeEl);
                  } else if (sub) {
                    p.appendChild(document.createTextNode(sub));
                  }
                }
              }
            }
            wrap.appendChild(p);
          }
        }
        return wrap;
      }

      function appendMessage(sender, text, meta) {
        if (!chatFeed) return;
        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble msg-' + sender;
        var textDiv = renderMobileMarkdown(text);
        bubble.appendChild(textDiv);
        if (meta) {
          var metaDiv = document.createElement('div');
          metaDiv.className = 'msg-meta';
          metaDiv.textContent = meta;
          bubble.appendChild(metaDiv);
        }
        chatFeed.appendChild(bubble);
        chatFeed.scrollTop = chatFeed.scrollHeight;
      }

      async function loadMessages() {
        try {
          var res = await fetch('/api/messages');
          if (res.status === 401) {
            updateDiag('messages', '401');
            showPairingScreen('Authentication failed');
            return;
          }
          if (res.ok) {
            updateDiag('messages', '200');
            var data = await res.json();
            if (data.messages && data.messages.length > 0) {
              if (renderedMessageIds.size === 0 && chatFeed) chatFeed.innerHTML = '';
              for (var i = 0; i < data.messages.length; i++) {
                var m = data.messages[i];
                var mKey = m.id || (m.role + ':' + String(m.content).slice(0, 40));
                if (!renderedMessageIds.has(mKey)) {
                  renderedMessageIds.add(mKey);
                  appendMessage(m.role, m.content, m.role === 'assistant' ? 'Pandesh' : 'You');
                }
              }
            }
          } else {
            updateDiag('messages', 'error (' + res.status + ')');
          }
        } catch (err) {
          updateDiag('messages', 'error');
        }
      }

      async function loadSnapshot() {
        try {
          var res = await fetch('/api/snapshot');
          if (res.status === 401) {
            showPairingScreen('Authentication failed');
            return;
          }
          if (res.ok) {
            var snap = await res.json();
            renderSnapshot(snap);
          }
        } catch (err) {}
      }

      function renderSnapshot(snap) {
        if (!snap) return;
        var wEl = document.getElementById('m-workspace');
        if (wEl) wEl.textContent = snap.workspaceRoot || 'None';
        var mEl = document.getElementById('m-model');
        if (mEl) mEl.textContent = snap.selectedModel || 'Auto';

        if (snap.pendingApproval) {
          currentApproval = snap.pendingApproval;
          if (approvalPanel) approvalPanel.style.display = 'block';
          var toolEl = document.getElementById('appr-tool');
          if (toolEl) toolEl.textContent = snap.pendingApproval.toolName || 'Mutation';
          var scopeEl = document.getElementById('appr-scope');
          if (scopeEl) scopeEl.textContent = snap.pendingApproval.scope || 'Requires explicit confirmation';
        } else {
          currentApproval = null;
          if (approvalPanel) approvalPanel.style.display = 'none';
        }

      }

      var isSubmitting = false;

      // STATE MACHINE: CONNECT_SSE
      function connectSse() {
        if (sseSource) {
          try { sseSource.close(); } catch (e) {}
          sseSource = null;
        }

        updateDiag('sse', 'connecting');
        setStatus('Connecting…', 'connecting');
        showConnectedScreen();

        sseSource = new EventSource('/api/events');

        sseSource.onopen = function() {
          updateDiag('sse', 'open');
          setStatus('Connected', 'connected');
          loadSnapshot();
          loadMessages();
        };

        sseSource.addEventListener('session_event', function(e) {
          try {
            updateDiag('event', new Date().toLocaleTimeString());
            var evt = JSON.parse(e.data);
            if (evt.kind === 'status') {
              if (evt.summary && evt.summary !== 'snapshot') {
                var actList = document.getElementById('m-activity-list');
                if (actList) {
                  var row = document.createElement('div');
                  row.textContent = '• ' + evt.summary;
                  actList.insertBefore(row, actList.firstChild);
                }
              }
            } else if (evt.kind === 'result' || evt.kind === 'turn_completed' || evt.kind === 'assistant_turn') {
              // Clear thinking indicator if present
              var tb = document.getElementById('thinking-indicator');
              if (tb && tb.parentNode) tb.parentNode.removeChild(tb);

              if (evt.text) {
                var mKey = 'result:' + (evt.attemptId || '') + ':' + String(evt.text).slice(0, 40);
                if (!renderedMessageIds.has(mKey)) {
                  renderedMessageIds.add(mKey);
                  appendMessage('assistant', evt.text, 'Pandesh');
                }
                if (audioEnabled && window.speechSynthesis) {
                  try {
                    window.speechSynthesis.cancel();
                    var utter = new SpeechSynthesisUtterance(evt.text);
                    window.speechSynthesis.speak(utter);
                  } catch (speechErr) {}
                }
              }
            }
          } catch (err) {}
        });

        sseSource.addEventListener('snapshot_update', function(e) {
          try {
            updateDiag('event', new Date().toLocaleTimeString());
            renderSnapshot(JSON.parse(e.data));
          } catch (err) {}
        });

        sseSource.onerror = function() {
          updateDiag('sse', 'error');
          if (sseSource) {
            try { sseSource.close(); } catch (e) {}
            sseSource = null;
          }
          fetch('/api/session').then(function(r) {
            if (r.status === 401) {
              updateDiag('session', 'no');
              showPairingScreen('Pairing expired');
            } else if (r.ok) {
              setStatus('Reconnecting…', 'connecting');
              setTimeout(connectSse, 2500);
            } else {
              setStatus('Connection failed', 'offline');
              setTimeout(connectSse, 3500);
            }
          }).catch(function() {
            setStatus('Server unreachable', 'offline');
            setTimeout(connectSse, 4000);
          });
        };
      }

      // STATE MACHINE: PAIRING
      async function doPair(code) {
        var cleanCode = String(code || '').trim().toUpperCase();
        if (!cleanCode) return;
        setStatus('Pairing…', 'connecting');
        if (pairBtn) {
          pairBtn.disabled = true;
          pairBtn.textContent = 'Pairing…';
        }
        if (pairError) pairError.hidden = true;

        try {
          var res = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: cleanCode })
          });
          var data = await res.json();
          if (res.ok && data.ok) {
            updateDiag('session', 'yes');
            if (pairError) pairError.hidden = true;
            connectSse();
          } else {
            updateDiag('session', 'no');
            showPairingScreen('Pairing failed');
            if (pairError) {
              pairError.textContent = data.error || 'Invalid pairing PIN';
              pairError.hidden = false;
            }
          }
        } catch (err) {
          updateDiag('session', 'error');
          showPairingScreen('Server unreachable');
          if (pairError) {
            pairError.textContent = 'Connection error: PC unreachable';
            pairError.hidden = false;
          }
        } finally {
          if (pairBtn) {
            pairBtn.disabled = false;
            pairBtn.textContent = 'Connect to PC';
          }
        }
      }

      // STATE MACHINE: BOOT -> CHECK SESSION
      async function bootStateMachine() {
        // Clean legacy deprecated storage
        try {
          localStorage.removeItem('kkd_mobile_token');
          localStorage.removeItem('kkd_mobile_pin');
        } catch (e) {}

        updateDiag('session', 'checking');
        var urlParams = new URLSearchParams(window.location.search);
        var autoCode = (urlParams.get('pair') || '').trim().toUpperCase();
        if (autoCode && pairInput) {
          pairInput.value = autoCode;
        }

        try {
          var res = await fetch('/api/session');
          if (res.ok) {
            updateDiag('session', 'yes');
            connectSse();
            return;
          }
        } catch (e) {
          // Network failure on initial check
        }

        // Session not active or invalid -> NEED_PAIRING
        updateDiag('session', 'no');
        if (autoCode) {
          // If URL has ?pair=CODE, pair immediately
          doPair(autoCode);
        } else {
          showPairingScreen('Pairing required');
        }
      }

      // Event listeners
      if (pairBtn) {
        pairBtn.addEventListener('click', function() {
          var val = pairInput ? pairInput.value : '';
          doPair(val);
        });
      }

      async function sendMessage() {
        if (isSubmitting) return;
        var text = (msgInput ? msgInput.value || '' : '').trim();
        if (!text) return;
        if (msgInput) msgInput.value = '';

        appendMessage('user', text, 'You');

        // Thinking indicator bubble
        var thinkingBubble = document.createElement('div');
        thinkingBubble.id = 'thinking-indicator';
        thinkingBubble.className = 'msg-bubble msg-assistant';
        thinkingBubble.innerHTML = '<span style=\"color:var(--accent);\">Pandesh is thinking…</span>';
        if (chatFeed) {
          chatFeed.appendChild(thinkingBubble);
          chatFeed.scrollTop = chatFeed.scrollHeight;
        }

        isSubmitting = true;
        if (sendBtn) sendBtn.disabled = true;

        try {
          var res = await fetch('/api/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
          });
          if (res.status === 401) {
            if (thinkingBubble.parentNode) thinkingBubble.parentNode.removeChild(thinkingBubble);
            showPairingScreen('Authentication failed');
            return;
          }
          var data = await res.json();
          if (!res.ok) {
            if (thinkingBubble.parentNode) thinkingBubble.parentNode.removeChild(thinkingBubble);
            appendMessage('assistant', 'Error: ' + (data.error || 'Failed to submit'), 'Pandesh');
          }
        } catch (err) {
          if (thinkingBubble.parentNode) thinkingBubble.parentNode.removeChild(thinkingBubble);
          appendMessage('assistant', 'Network failure: ' + (err && err.message ? err.message : String(err)), 'Pandesh');
        } finally {
          isSubmitting = false;
          if (sendBtn) sendBtn.disabled = false;
        }
      }

      if (sendBtn) sendBtn.addEventListener('click', sendMessage);
      if (msgInput) {
        msgInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
        });
      }

      var audioToggle = document.getElementById('m-audio-toggle');
      if (audioToggle) {
        audioToggle.addEventListener('click', function() {
          audioEnabled = !audioEnabled;
          audioToggle.textContent = audioEnabled ? '🔊 Voice: On' : '🔇 Voice: Off';
          audioToggle.style.color = audioEnabled ? 'var(--accent)' : 'var(--text-muted)';
        });
      }

      // Approvals
      var apprApprove = document.getElementById('appr-btn-approve');
      var apprDeny = document.getElementById('appr-btn-deny');
      if (apprApprove) {
        apprApprove.addEventListener('click', async function() {
          if (!currentApproval) return;
          await resolveAppr('approved');
        });
      }
      if (apprDeny) {
        apprDeny.addEventListener('click', async function() {
          if (!currentApproval) return;
          await resolveAppr('rejected');
        });
      }

      async function resolveAppr(resState) {
        try {
          await fetch('/api/approval', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              approvalId: currentApproval.approvalId,
              resolution: resState
            })
          });
          if (approvalPanel) approvalPanel.style.display = 'none';
        } catch (e) {
          alert('Approval error: ' + (e && e.message ? e.message : String(e)));
        }
      }

      // Mic / Audio recording
      var mediaRecorder = null;
      var audioChunks = [];
      if (micBtn) {
        micBtn.addEventListener('click', async function() {
          if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
            micBtn.classList.remove('recording');
            return;
          }
          try {
            var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = function(e) {
              if (e.data.size > 0) audioChunks.push(e.data);
            };
            mediaRecorder.onstop = async function() {
              var blob = new Blob(audioChunks, { type: 'audio/wav' });
              setStatus('Transcribing…', 'connecting');
              try {
                var transRes = await fetch('/api/voice/transcribe', {
                  method: 'POST',
                  body: blob
                });
                var transData = await transRes.json();
                if (transData.text && msgInput) {
                  msgInput.value = transData.text;
                  sendMessage();
                }
              } catch (err) {
                console.error(err);
              } finally {
                setStatus('Connected', 'connected');
              }
            };
            mediaRecorder.start();
            micBtn.classList.add('recording');
          } catch (err) {
            alert('Microphone access unavailable or denied: ' + (err && err.message ? err.message : String(err)));
          }
        });
      }

      // Reconnect when tab returns to foreground
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') {
          if (!sseSource || sseSource.readyState === EventSource.CLOSED) {
            bootStateMachine();
          } else {
            loadMessages();
            loadSnapshot();
          }
        }
      });

      // Start the state machine
      bootStateMachine();
    })();
  </script>
</body>
</html>`;
  }
}

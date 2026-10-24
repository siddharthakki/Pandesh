/**
 * A bounded, local-only static file server used to preview a browser-viewable artifact (an `index.html` the agent
 * just created) inside VS Code's own browser surface.
 *
 * Why a server at all: VS Code's browser surfaces take http(s) URLs. A `file://` page cannot load its sibling
 * scripts and styles the way it will once served, so the preview would not reflect the real artifact.
 *
 * Bounds, deliberately tight because this is a listening socket:
 *  - binds 127.0.0.1 only, on an ephemeral port; never reachable from another machine;
 *  - GET/HEAD only, nothing writable, no directory listings;
 *  - serves only files that resolve (after symlink resolution) inside the root it was started for;
 *  - never serves VCS/agent state or secrets (`.git`, `.ollama-agent`, `.env*`);
 *  - closes itself after an idle period and on `dispose()`, so it never outlives its usefulness.
 *
 * It is a preview surface, not a dev server: no build step, no proxying, no live-reload injection. Responses carry
 * `Cache-Control: no-store`, so a reload in the browser always shows the current bytes on disk.
 */
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** Path segments that are never served, whatever the request asks for. */
const BLOCKED_SEGMENT = /^(\.git|\.ollama-agent|\.env(\..*)?)$/i;

export const DEFAULT_PREVIEW_IDLE_MS = 15 * 60 * 1000;

export interface StaticPreviewServerOptions {
  idleMs?: number;
}

export class StaticPreviewServer {
  readonly root: string;
  readonly origin: string;
  private readonly server: http.Server;
  private idleTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly idleMs: number;
  /** Fired once when the server closes, whether by idle timeout or dispose. */
  onClose: (() => void) | undefined;

  private constructor(root: string, server: http.Server, port: number, idleMs: number) {
    this.root = root;
    this.server = server;
    this.origin = `http://127.0.0.1:${port}`;
    this.idleMs = idleMs;
    this.touch();
  }

  static async start(root: string, options: StaticPreviewServerOptions = {}): Promise<StaticPreviewServer> {
    const realRoot = fs.realpathSync(root);
    let instance: StaticPreviewServer | undefined;
    const server = http.createServer((request, response) => {
      instance?.touch();
      handle(realRoot, request, response);
    });
    // A preview must never be able to take the extension host down.
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    instance = new StaticPreviewServer(realRoot, server, port, options.idleMs ?? DEFAULT_PREVIEW_IDLE_MS);
    return instance;
  }

  /** The URL of a root-relative path (`index.html`, `docs\\a.html`). Each segment is encoded. */
  urlFor(relativePath: string): string {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
    return `${this.origin}/${segments.join('/')}`;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.server.closeAllConnections?.();
    this.server.close();
    const callback = this.onClose;
    this.onClose = undefined;
    callback?.();
  }

  private touch(): void {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), this.idleMs);
    this.idleTimer.unref?.();
  }
}

function deny(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(message);
}

/** Resolves a request path to a real file inside `root`, or undefined. Pure of any response handling. */
export function resolveServedFile(root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0].split('#')[0]);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  if (segments.some(segment => segment === '..' || BLOCKED_SEGMENT.test(segment))) return undefined;
  let candidate = path.join(root, ...segments);
  try {
    if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    const real = fs.realpathSync(candidate);
    const relative = path.relative(root, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    // A symlink inside the root must not smuggle a blocked name past the segment check above.
    if (relative.split(path.sep).some(segment => BLOCKED_SEGMENT.test(segment))) return undefined;
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function handle(root: string, request: http.IncomingMessage, response: http.ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    deny(response, 405, 'Method not allowed');
    return;
  }
  const file = resolveServedFile(root, request.url ?? '/');
  if (!file) {
    deny(response, 404, 'Not found');
    return;
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

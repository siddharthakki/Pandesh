/**
 * The phone app's files (renderer/mobile, shipped with the rest of the renderer folder). Only the names listed here
 * are served, nothing is generated from the request, and the page is the same for everyone: a pairing code in the
 * link is read by the page's own script, never written into the HTML.
 *
 * sw.js gets one substitution: a hash of the shell files, so a new build installs a new service worker and drops
 * the old cache.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json; charset=utf-8' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', type: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', type: 'image/png' },
  '/icons/icon-maskable-512.png': { file: 'icons/icon-maskable-512.png', type: 'image/png' },
  '/icons/apple-touch-icon.png': { file: 'icons/apple-touch-icon.png', type: 'image/png' },
  '/favicon.ico': { file: 'icons/icon-192.png', type: 'image/png' },
};

/** Files whose content makes up the cached shell (sw.js itself is versioned by them). */
const SHELL_FILES = ['index.html', 'lib.js', 'app.js', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

export const SHELL_VERSION_MARKER = '__PANDESH_SHELL_VERSION__';

export interface MobileAsset {
  body: Buffer;
  type: string;
  etag: string;
  isPage: boolean;
}

/** renderer/mobile next to the bundled main.js (out/), or next to the sources when running from the repository. */
export function defaultMobileAssetsDir(): string {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'mobile'),
    path.join(__dirname, '..', '..', 'renderer', 'mobile'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
}

export class MobileAssets {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; body: Buffer }>();

  constructor(private readonly dir: string) {}

  static isAssetPath(pathname: string): boolean {
    return Object.prototype.hasOwnProperty.call(FILES, pathname);
  }

  get(pathname: string): MobileAsset | null {
    const entry = FILES[pathname];
    if (!entry) return null;
    let body = this.read(entry.file);
    if (!body) return null;
    if (entry.file === 'sw.js') body = Buffer.from(body.toString('utf8').split(SHELL_VERSION_MARKER).join(this.shellVersion()), 'utf8');
    const etag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    return { body, type: entry.type, etag, isPage: entry.file === 'index.html' };
  }

  /** Changes whenever any shell file changes. Hex only. */
  shellVersion(): string {
    const hash = crypto.createHash('sha256');
    for (const f of SHELL_FILES) {
      hash.update(f);
      hash.update(this.read(f) ?? Buffer.alloc(0));
    }
    return hash.digest('hex').slice(0, 16);
  }

  private read(file: string): Buffer | null {
    const full = path.join(this.dir, file);
    try {
      const stat = fs.statSync(full);
      const hit = this.cache.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.body;
      const body = fs.readFileSync(full);
      this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, body });
      return body;
    } catch {
      return null;
    }
  }
}

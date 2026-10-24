import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { StaticPreviewServer, resolveServedFile } from '../../preview/StaticPreviewServer';
import { PreviewHost, PreviewService, isPreviewablePath, previewableArtifacts } from '../../preview/PreviewService';

/**
 * Preview is not validation: these tests cover opening and serving only. Nothing here asserts or implies that a
 * page works, and no validation result is produced or consumed.
 */
function get(url: string, method = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      let body = '';
      response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('previewable artifacts', () => {
  it('picks out HTML only, in order, without duplicates', () => {
    expect(isPreviewablePath('index.html')).toBe(true);
    expect(isPreviewablePath('a/b.HTM')).toBe(true);
    expect(isPreviewablePath('app.ts')).toBe(false);
    expect(previewableArtifacts(['src/a.ts', 'index.html', 'docs\\guide.html', 'index.html'])).toEqual(['index.html', 'docs/guide.html']);
    expect(previewableArtifacts(['src/a.ts', 'README.md'])).toEqual([]);
  });
});

describe('StaticPreviewServer (real HTTP, loopback only)', () => {
  let root: string;
  let outside: string;
  let server: StaticPreviewServer;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-preview-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-preview-outside-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>hello</body></html>');
    fs.writeFileSync(path.join(root, 'style.css'), 'body{color:red}');
    fs.mkdirSync(path.join(root, 'sub dir'));
    fs.writeFileSync(path.join(root, 'sub dir', 'page.html'), '<html>sub</html>');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
    fs.mkdirSync(path.join(root, '.ollama-agent'));
    fs.writeFileSync(path.join(root, '.ollama-agent', 'state.json'), '{}');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    server = await StaticPreviewServer.start(root);
  });
  afterEach(() => {
    server.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('binds loopback only and serves the artifact and its siblings with correct types, uncached', async () => {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await get(server.urlFor('index.html'));
    expect(page.status).toBe(200);
    expect(page.body).toContain('hello');
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await get(server.urlFor('style.css'))).headers['content-type']).toContain('text/css');
    expect((await get(server.urlFor('sub dir/page.html'))).body).toContain('sub');
    expect((await get(`${server.origin}/`)).body).toContain('hello'); // directory -> index.html
  });

  it('shows the current bytes on every request, so a reload reflects the latest edit', async () => {
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>version two</body></html>');
    expect((await get(server.urlFor('index.html'))).body).toContain('version two');
  });

  it('serves nothing outside the root, nothing from VCS/agent state, and no secrets', async () => {
    for (const bad of ['/../secret.txt', '/%2e%2e/secret.txt', '/.git/config', '/.ollama-agent/state.json', '/.env', '/sub%20dir/../../secret.txt']) {
      expect((await get(`${server.origin}${bad}`)).status, bad).toBe(404);
    }
    expect(resolveServedFile(root, '/a%00b')).toBeUndefined();
    expect(resolveServedFile(root, '/%E0%A4%A')).toBeUndefined();
  });

  it('refuses a symlink that escapes the root', () => {
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    } catch {
      return; // symlink creation not permitted on this machine: nothing to assert
    }
    expect(resolveServedFile(root, '/link.txt')).toBeUndefined();
  });

  it('is read-only: only GET and HEAD are accepted', async () => {
    expect((await get(server.urlFor('index.html'), 'POST')).status).toBe(405);
    expect((await get(server.urlFor('index.html'), 'PUT')).status).toBe(405);
    const head = await get(server.urlFor('index.html'), 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('closes on dispose and reports it, and an idle server closes itself', async () => {
    let closed = 0;
    server.onClose = () => { closed += 1; };
    server.dispose();
    server.dispose();
    expect(closed).toBe(1);
    expect(server.isOpen).toBe(false);
    await expect(get(server.urlFor('index.html'))).rejects.toBeDefined();

    const idle = await StaticPreviewServer.start(root, { idleMs: 50 });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(idle.isOpen).toBe(false);
  });
});

describe('PreviewService', () => {
  let root: string;
  let calls: Array<{ command: string; args: unknown[] }>;
  let external: string[];
  let service: PreviewService;
  let failing: Set<string>;

  const host = (): PreviewHost => ({
    placement: { viewColumn: -2, preserveFocus: true },
    executeCommand: async (command, ...args) => {
      calls.push({ command, args });
      if (failing.has(command)) throw new Error(`command '${command}' not found`);
      return undefined;
    },
    openExternal: async url => { external.push(url); return true; },
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-preview-svc-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>x</body></html>');
    fs.writeFileSync(path.join(root, 'notes.md'), 'x');
    calls = [];
    external = [];
    failing = new Set();
    service = new PreviewService(host());
  });
  afterEach(() => {
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens an HTML file in the editor browser beside the source, via a documented command, with no external browser', async () => {
    const result = await service.open(root, path.join(root, 'index.html'));
    expect(result).toMatchObject({ outcome: 'opened', where: 'editor-browser' });
    expect(calls[0].command).toBe('simpleBrowser.api.open');
    expect(calls[0].args[1]).toEqual({ viewColumn: -2, preserveFocus: true });
    expect(String(calls[0].args[0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    expect(external).toEqual([]);
  });

  it('falls back to the other documented command, then to the external browser, and says which and why', async () => {
    failing.add('simpleBrowser.api.open');
    expect((await service.open(root, path.join(root, 'index.html'))).outcome).toBe('opened');
    expect(calls.map(call => call.command)).toEqual(['simpleBrowser.api.open', 'simpleBrowser.show']);
    expect(external).toEqual([]);

    calls = [];
    failing.add('simpleBrowser.show');
    const result = await service.open(root, path.join(root, 'index.html'));
    expect(result).toMatchObject({ outcome: 'opened', where: 'external-browser', reason: 'editor_browser_unavailable' });
    expect(external).toHaveLength(1);
  });

  it('uses the external browser directly only when the user asks for it', async () => {
    const result = await service.open(root, path.join(root, 'index.html'), { external: true });
    expect(result).toMatchObject({ where: 'external-browser', reason: 'requested' });
    expect(calls).toEqual([]);
  });

  it('refreshing the same artifact reuses one server and shows the new bytes', async () => {
    const first = await service.open(root, path.join(root, 'index.html'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>dark mode</body></html>');
    const second = await service.open(root, path.join(root, 'index.html'));
    expect((first as { url: string }).url).toBe((second as { url: string }).url);
    expect((await get((second as { url: string }).url)).body).toContain('dark mode');
  });

  it('refuses anything that is not a previewable file inside the workspace, and never opens a browser for it', async () => {
    expect(await service.open(root, path.join(root, 'notes.md'))).toEqual({ outcome: 'refused', reason: 'not_previewable' });
    expect(await service.open(root, path.join(os.tmpdir(), 'elsewhere.html'))).toEqual({ outcome: 'refused', reason: 'outside_workspace' });
    expect(await service.open(root, path.join(root, 'missing.html'))).toEqual({ outcome: 'refused', reason: 'not_found' });
    expect(calls).toEqual([]);
    expect(external).toEqual([]);
  });
});

/**
 * Host-managed browser inspection for a workspace page.
 *
 * Serves only files under the governed workspace, launches a host browser
 * already on disk (never npm-installs), and writes screenshots under
 * `<workspace>/.tmp/karkedikha-browser`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { createSanitizedChildEnvironment } from '../security/childEnvironment';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { recoverRepositoryPath } from './repositoryPathRecovery';
import { resolveHostBrowserBin } from './hostBrowserBin';
import { resolveBrowserTargetUrl } from './browserHostPolicy';
import {
  PAGE_LOCATOR_RUNTIME,
  describeLocator,
  resolveInspectLocator,
  type PageLocator,
} from './pageLocator';

export type { PageLocator } from './pageLocator';

export const BROWSER_OUTPUT_DIR = '.tmp/karkedikha-browser';
const MAX_SNAPSHOT_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 45_000;

export interface BrowserInspectStep {
  action: 'click' | 'fill' | 'wait' | 'focus' | 'key';
  selector?: string;
  locator?: PageLocator;
  value?: string;
  key?: string;
  ms?: number;
}

export interface PageElementProbe {
  found: boolean;
  value: string;
  text: string;
  hiddenAttr: boolean;
  display: string;
  visibility: string;
  opacity: string;
  focused: boolean;
  pressed?: boolean;
}

export interface PageProbe {
  url: string;
  startedUrl?: string;
  title: string;
  focusId: string | null;
  navigationType: string | null;
  loadMarker: number | null;
  loadMarkerAtStart?: number | null;
  elements: Record<string, PageElementProbe>;
}

export interface BrowserInspectionRequest {
  workspaceRoot: string;
  relativePath: string;
  viewportWidth: number;
  viewportHeight: number;
  steps: BrowserInspectStep[];
  outputDir: string;
  screenshotName: string;
  browserBin: string;
  /**
   * A live page to open instead of a workspace file. Only a loopback (or
   * explicitly allowed) host may be opened — see `resolveLivePageUrl`.
   */
  absoluteUrl?: string;
}

export interface BrowserInspectionResult {
  title: string;
  url: string;
  viewport: { width: number; height: number };
  snapshot: string;
  screenshotPath: string;
}

export type BrowserInspectionRunner = (
  request: BrowserInspectionRequest,
  signal?: AbortSignal,
) => Promise<BrowserInspectionResult>;

/** Core-owned temporary storage for browser profiles, outside any workspace. */
export function browserProfileRoot(): string {
  return path.join(os.tmpdir(), 'karkedikha-browser-profiles');
}

/**
 * Creates a throwaway profile directory outside the target repository and
 * worktree, so caches, cookies, and login journals can never be staged.
 */
export function createBrowserProfileDir(): string {
  fs.mkdirSync(browserProfileRoot(), { recursive: true });
  return fs.mkdtempSync(path.join(browserProfileRoot(), 'profile-'));
}

/** Removes a profile after success, failure, or cancellation. Never reads it. */
export function removeBrowserProfileDir(profileDir: string): void {
  if (!profileDir) return;
  if (!isInsideWorkspace(browserProfileRoot(), profileDir)) return;
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A locked profile is left for the OS temp sweeper; it is outside the repository.
  }
}

export function browserOutputDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ...BROWSER_OUTPUT_DIR.split('/'));
}

export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const ALLOWED_PAGE_REASONS = new Set([
  'exact_in_root',
  'case_insensitive_relative_match',
  'unique_suffix_match',
]);

export function resolveWorkspacePage(workspaceRoot: string, requestedPath: string) {
  const recovery = recoverRepositoryPath({
    workspaceRoot,
    requestedPath,
    target: 'read',
  });
  if (
    (recovery.status !== 'resolved' && recovery.status !== 'corrected')
    || !recovery.resolvedPath
    || !recovery.exists
    || !ALLOWED_PAGE_REASONS.has(recovery.reason)
  ) {
    return { ok: false as const, recovery };
  }
  return { ok: true as const, recovery, resolvedPath: recovery.resolvedPath };
}

/**
 * Resolves a live page URL for the host-managed browser.
 *
 * The rule itself lives in `browserHostPolicy.ts` so the Core policy layer
 * and the browser capability can never disagree about which host is allowed.
 */
export function resolveLivePageUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; url: string; host: string } | { ok: false; reason: string } {
  return resolveBrowserTargetUrl(rawUrl, env);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'text/plain; charset=utf-8';
  }
}

export function startWorkspaceFileServer(workspaceRoot: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(workspaceRoot);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.normalize(path.join(root, relative));
    if (!isInsideWorkspace(root, file)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeType(file) });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('workspace file server did not bind a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
        }),
      });
    });
    server.on('error', reject);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on('error', reject);
  });
}

interface CdpPending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, CdpPending>();

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as {
        id?: number;
        error?: { message?: string };
        result?: Record<string, unknown>;
      };
      if (!msg.id || !this.pending.has(msg.id)) return;
      const waiter = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? 'cdp error'));
      else waiter.resolve(msg.result ?? {});
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function waitForDebugEndpoint(port: number, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 15_000;
  let lastError = 'browser debug port did not become ready';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('browser inspection cancelled');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = await res.json() as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(150);
  }
  throw new Error(`browser debug port did not become ready: ${lastError}`);
}

async function connectCdp(url: string): Promise<CdpSession> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new CdpSession(ws);
}

async function evaluate(cdp: CdpSession, sessionId: string, expression: string): Promise<unknown> {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const exception = result.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
  if (exception) {
    throw new Error(exception.exception?.description ?? exception.text ?? 'page evaluation failed');
  }
  const inner = result.result as { value?: unknown } | undefined;
  return inner?.value;
}

function keyEventParams(key: string): { key: string; code: string; text: string; windowsVirtualKeyCode: number } {
  if (key === 'Enter') return { key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 };
  if (key === ' ' || key === 'Space') return { key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 };
  if (key === 'Tab') return { key: 'Tab', code: 'Tab', text: '', windowsVirtualKeyCode: 9 };
  if (key === 'Escape') return { key: 'Escape', code: 'Escape', text: '', windowsVirtualKeyCode: 27 };
  const ch = key.slice(0, 1);
  return { key: ch, code: /^[a-zA-Z]$/.test(ch) ? `Key${ch.toUpperCase()}` : ch, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
}

async function applyStep(cdp: CdpSession, sessionId: string, step: BrowserInspectStep): Promise<void> {
  if (step.action === 'wait') {
    await sleep(Math.min(Math.max(Number(step.ms) || 250, 0), 5_000));
    return;
  }
  if (step.action === 'key') {
    const key = String(step.key ?? step.value ?? '').trim() || ' ';
    const params = keyEventParams(key === 'Space' ? ' ' : key);
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: params.key,
      code: params.code,
      windowsVirtualKeyCode: params.windowsVirtualKeyCode,
      nativeVirtualKeyCode: params.windowsVirtualKeyCode,
    }, sessionId);
    if (params.text) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: params.text }, sessionId);
    }
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: params.key,
      code: params.code,
      windowsVirtualKeyCode: params.windowsVirtualKeyCode,
      nativeVirtualKeyCode: params.windowsVirtualKeyCode,
    }, sessionId);
    return;
  }
  const locator = resolveInspectLocator(step);
  if (!locator) {
    throw new Error(`inspect_page ${step.action} requires a locator`);
  }
  const missing = `locator not found: ${describeLocator(locator)}`;
  if (step.action === 'fill') {
    await evaluate(cdp, sessionId, `(function () {
      ${PAGE_LOCATOR_RUNTIME}
      const el = kdkFindByLocator(${JSON.stringify(locator)});
      if (!el) throw new Error(${JSON.stringify(missing)});
      el.focus();
      el.value = ${JSON.stringify(step.value ?? '')};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    return;
  }
  if (step.action === 'focus') {
    await evaluate(cdp, sessionId, `(function () {
      ${PAGE_LOCATOR_RUNTIME}
      const el = kdkFindByLocator(${JSON.stringify(locator)});
      if (!el) throw new Error(${JSON.stringify(missing)});
      el.focus();
      return true;
    })()`);
    return;
  }
  await evaluate(cdp, sessionId, `(function () {
    ${PAGE_LOCATOR_RUNTIME}
    const el = kdkFindByLocator(${JSON.stringify(locator)});
    if (!el) throw new Error(${JSON.stringify(missing)});
    el.click();
    return true;
  })()`);
}

export function emptyElementProbe(): PageElementProbe {
  return {
    found: false,
    value: '',
    text: '',
    hiddenAttr: false,
    display: '',
    visibility: '',
    opacity: '',
    focused: false,
    pressed: false,
  };
}

async function collectPageProbe(
  cdp: CdpSession,
  sessionId: string,
  selectors: string[],
): Promise<PageProbe> {
  const raw = await evaluate(cdp, sessionId, `(function () {
    ${PAGE_LOCATOR_RUNTIME}
    const selectors = ${JSON.stringify(selectors)};
    const elements = {};
    for (const selector of selectors) {
      elements[selector] = kdkProbeElement(kdkFindByLocator(kdkParseLocatorRef(selector)));
    }
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      url: location.href,
      title: document.title,
      focusId: document.activeElement && document.activeElement.id ? document.activeElement.id : null,
      navigationType: nav && nav.type ? nav.type : null,
      loadMarker: window.__kdkVerificationLoadedAt || null,
      elements,
    };
  })()`);
  const probe = raw && typeof raw === 'object' ? raw as PageProbe : {
    url: '', title: '', focusId: null, navigationType: null, loadMarker: null, elements: {},
  };
  return {
    ...probe,
    elements: probe.elements ?? {},
  };
}

function bound(text: string): string {
  return text.length > MAX_SNAPSHOT_CHARS ? `${text.slice(0, MAX_SNAPSHOT_CHARS)}\n…[truncated]` : text;
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid && process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  child.kill('SIGTERM');
}

async function withInspectedPage<T>(
  request: BrowserInspectionRequest,
  signal: AbortSignal | undefined,
  fn: (cdp: CdpSession, sessionId: string, pageUrl: string) => Promise<T>,
): Promise<T> {
  fs.mkdirSync(request.outputDir, { recursive: true });
  if (!isInsideWorkspace(request.workspaceRoot, request.outputDir)) {
    throw new Error('browser output directory must stay inside the workspace');
  }

  // A live page needs no workspace file server; a workspace file does.
  const server = request.absoluteUrl ? null : await startWorkspaceFileServer(request.workspaceRoot);
  const debugPort = await freePort();
  const profileDir = createBrowserProfileDir();
  const pageUrl = request.absoluteUrl
    ?? new URL(request.relativePath.replace(/^\/+/, ''), server!.url).toString();
  const child = spawn(request.browserBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    ...(process.platform !== 'win32' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], {
    windowsHide: true,
    stdio: 'ignore',
  });

  let cdp: CdpSession | undefined;
  try {
    if (signal?.aborted) throw new Error('browser inspection cancelled');
    const wsUrl = await waitForDebugEndpoint(debugPort, signal);
    cdp = await connectCdp(wsUrl);
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = String(created.targetId ?? '');
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = String(attached.sessionId ?? '');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: request.viewportWidth,
      height: request.viewportHeight,
      deviceScaleFactor: 1,
      mobile: request.viewportWidth <= 500,
    }, sessionId);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await evaluate(cdp, sessionId, 'document.readyState');
      if (ready === 'complete' || ready === 'interactive') break;
      await sleep(100);
    }
    await evaluate(cdp, sessionId, 'window.__kdkVerificationLoadedAt = Date.now()');
    return await fn(cdp, sessionId, pageUrl);
  } finally {
    cdp?.close();
    await killProcessTree(child);
    if (server) await server.close().catch(() => undefined);
    removeBrowserProfileDir(profileDir);
  }
}

export const defaultBrowserInspectionRunner: BrowserInspectionRunner = async (request, signal) => {
  const screenshotPath = path.join(request.outputDir, request.screenshotName);
  if (!isInsideWorkspace(request.workspaceRoot, screenshotPath)) {
    throw new Error('screenshot path must stay inside the workspace');
  }
  return withInspectedPage(request, signal, async (cdp, sessionId, pageUrl) => {
    for (const step of request.steps) {
      await applyStep(cdp, sessionId, step);
    }
    const snapshotValue = await evaluate(cdp, sessionId, `({
      title: document.title,
      url: location.href,
      text: (document.body && document.body.innerText || '').slice(0, 4000),
    })`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(screenshotPath, Buffer.from(String(shot.data ?? ''), 'base64'));
    const snapshot = snapshotValue && typeof snapshotValue === 'object'
      ? snapshotValue as { title?: string; url?: string; text?: string }
      : {};
    return {
      title: String(snapshot.title ?? ''),
      url: String(snapshot.url ?? pageUrl),
      viewport: { width: request.viewportWidth, height: request.viewportHeight },
      snapshot: bound(String(snapshot.text ?? '')),
      screenshotPath,
    };
  });
};

export async function runWorkspacePageScenario(input: {
  workspaceRoot: string;
  relativePath: string;
  steps: BrowserInspectStep[];
  selectors: string[];
  viewportWidth?: number;
  viewportHeight?: number;
  browserBin?: string | null;
  signal?: AbortSignal;
}): Promise<PageProbe> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const page = resolveWorkspacePage(workspaceRoot, input.relativePath);
  if (!page.ok) {
    throw new Error(`verification page is not a readable workspace file (${page.recovery.reason})`);
  }
  const browserBin = input.browserBin ?? resolveHostBrowserBin();
  if (!browserBin) {
    throw new Error('no host browser is available; set KARKEDIKHA_BROWSER_BIN');
  }
  const outputDir = browserOutputDir(workspaceRoot);
  return withInspectedPage({
    workspaceRoot,
    relativePath: page.recovery.selected ?? input.relativePath.replace(/^\/+/, ''),
    viewportWidth: Math.min(Math.max(Number(input.viewportWidth) || 1280, 320), 1920),
    viewportHeight: Math.min(Math.max(Number(input.viewportHeight) || 800, 480), 1200),
    steps: [],
    outputDir,
    screenshotName: 'scenario.png',
    browserBin,
  }, input.signal, async (cdp, sessionId) => {
    const before = await collectPageProbe(cdp, sessionId, input.selectors);
    for (const step of input.steps) {
      await applyStep(cdp, sessionId, step);
    }
    const probe = await collectPageProbe(cdp, sessionId, input.selectors);
    return {
      ...probe,
      startedUrl: before.url,
      loadMarkerAtStart: before.loadMarker,
    };
  });
}

export async function runWorkspacePageInspection(input: {
  workspaceRoot: string;
  relativePath: string;
  /** A live page on this machine (loopback, or an explicitly allowed host). */
  url?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  steps?: BrowserInspectStep[];
  screenshotName?: string;
  runner?: BrowserInspectionRunner;
  browserBin?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BrowserInspectionResult> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const browserBin = input.browserBin ?? resolveHostBrowserBin();
  if (!browserBin) {
    throw new Error('no host browser is available; set KARKEDIKHA_BROWSER_BIN');
  }
  const outputDir = browserOutputDir(workspaceRoot);
  const width = Math.min(Math.max(Number(input.viewportWidth) || 1280, 320), 1920);
  const height = Math.min(Math.max(Number(input.viewportHeight) || 800, 480), 1200);
  const screenshotName = (input.screenshotName ?? `inspect-${width}x${height}-${Date.now()}.png`).replace(/[^\w.-]/g, '_');
  const runner = input.runner ?? defaultBrowserInspectionRunner;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let absoluteUrl: string | undefined;
  let relativePath = input.relativePath.replace(/^\/+/, '');
  if (input.url) {
    const live = resolveLivePageUrl(input.url);
    if (!live.ok) throw new Error(live.reason);
    absoluteUrl = live.url;
  } else {
    const page = resolveWorkspacePage(workspaceRoot, input.relativePath);
    if (!page.ok) {
      throw new Error(`inspect_page path is not a readable workspace file (${page.recovery.reason})`);
    }
    relativePath = page.recovery.selected ?? relativePath;
  }

  try {
    return await runner({
      workspaceRoot,
      relativePath,
      ...(absoluteUrl ? { absoluteUrl } : {}),
      viewportWidth: width,
      viewportHeight: height,
      steps: input.steps ?? [],
      outputDir,
      screenshotName,
      browserBin,
    }, controller.signal);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

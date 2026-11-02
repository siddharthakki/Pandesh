/**
 * Persistent, bounded open-web browser sessions for the chat agent.
 *
 * One host browser per conversation, kept alive between tool calls so the
 * agent can navigate across pages. Every request the page makes passes a
 * Core-owned network guard (CDP Fetch interception):
 *   - only public http(s) hosts; DNS answers are checked per request so a
 *     name that resolves (or rebinds) to a private address is refused;
 *   - a top-level navigation may only reach a site the user approved;
 *   - non-GET requests (form submissions, posts) are refused — this stage
 *     is read-and-navigate only.
 * Page content is returned as untrusted data, never as instructions.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as dns } from 'node:dns';
import {
  CdpSession,
  applyStep,
  connectCdp,
  createBrowserProfileDir,
  evaluate,
  freePort,
  killProcessTree,
  removeBrowserProfileDir,
  sleep,
  waitForDebugEndpoint,
} from './browserInspection';
import { isNonPublicAddress, resolvePublicWebUrl, siteKey } from './browserHostPolicy';
import type { PageLocator } from './pageLocator';

export const DEFAULT_MAX_BROWSER_ACTIONS = 15;
const IDLE_CLOSE_MS = 10 * 60_000;
const NAV_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 3_000;
const MAX_LINKS = 60;
const MAX_CONTROLS = 25;
const DNS_CACHE_MS = 30_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface PageLink { index: number; text: string; href: string }
export interface PageControl { kind: string; label: string }

export interface BrowserPageState {
  url: string;
  title: string;
  text: string;
  links: PageLink[];
  controls: PageControl[];
  actionsUsed: number;
  actionsRemaining: number;
  /** Requests the guard refused since the previous action, in plain words. */
  blocked: string[];
}

export class BrowserSessionError extends Error {
  constructor(message: string, readonly category: string) {
    super(message);
  }
}

function hostAllowed(host: string, sites: Set<string>): boolean {
  const h = host.toLowerCase();
  for (const site of sites) {
    if (h === site || h.endsWith(`.${site}`)) return true;
  }
  return false;
}

class BrowserSession {
  readonly approvedSites = new Set<string>();
  actionsUsed = 0;
  private blocked: string[] = [];
  private readonly dnsCache = new Map<string, { ok: boolean; at: number }>();
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private mainFrameId = '';
  private lastGoodUrl = '';

  private constructor(
    private readonly child: ChildProcess,
    private readonly cdp: CdpSession,
    private readonly sessionId: string,
    private readonly profileDir: string,
    readonly maxActions: number,
    private readonly onClosed: () => void,
  ) {}

  static async launch(browserBin: string, maxActions: number, onClosed: () => void, signal?: AbortSignal): Promise<BrowserSession> {
    const debugPort = await freePort();
    const profileDir = createBrowserProfileDir();
    const child = spawn(browserBin, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      ...(process.platform !== 'win32' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    try {
      const cdp = await connectCdp(await waitForDebugEndpoint(debugPort, signal));
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attached = await cdp.send('Target.attachToTarget', { targetId: String(created.targetId ?? ''), flatten: true });
      const sessionId = String(attached.sessionId ?? '');
      const session = new BrowserSession(child, cdp, sessionId, profileDir, maxActions, onClosed);
      await session.install();
      return session;
    } catch (err) {
      await killProcessTree(child);
      removeBrowserProfileDir(profileDir);
      throw err;
    }
  }

  private async install(): Promise<void> {
    const { cdp, sessionId } = this;
    cdp.on('Fetch.requestPaused', (params) => { void this.guard(params); });
    cdp.onClose(() => { void this.close(); });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
    this.mainFrameId = String((tree.frameTree as { frame?: { id?: string } } | undefined)?.frame?.id ?? '');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  }

  private async hostIsPublic(host: string): Promise<boolean> {
    const cached = this.dnsCache.get(host);
    if (cached && Date.now() - cached.at < DNS_CACHE_MS) return cached.ok;
    let ok = false;
    try {
      const answers = await dns.lookup(host, { all: true, verbatim: true });
      ok = answers.length > 0 && answers.every((a) => !isNonPublicAddress(a.address));
    } catch {
      ok = false;
    }
    this.dnsCache.set(host, { ok, at: Date.now() });
    return ok;
  }

  private async guard(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '');
    const request = (params.request ?? {}) as { url?: string; method?: string };
    const resourceType = String(params.resourceType ?? '');
    const isTopNavigation = resourceType === 'Document' && (!this.mainFrameId || params.frameId === this.mainFrameId);
    const fail = (reason: string) => {
      this.blocked.push(reason);
      return this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, this.sessionId).catch(() => undefined);
    };
    let reason: string | undefined;
    const target = resolvePublicWebUrl(String(request.url ?? ''));
    const method = String(request.method ?? 'GET').toUpperCase();
    if (!target.ok) {
      reason = `${String(request.url ?? '').slice(0, 120)}: ${target.reason}`;
    } else if (!SAFE_METHODS.has(method)) {
      reason = isTopNavigation
        ? `form submission (${method}) to ${target.host} was not sent: submitting is not permitted in this browsing mode`
        : '';
    } else if (isTopNavigation && !hostAllowed(target.host, this.approvedSites)) {
      reason = `navigation to ${target.host} was stopped: that site is not approved yet (use browser_open_site)`;
    } else if (!(await this.hostIsPublic(target.host))) {
      reason = `${target.host} resolves to a private or local network address`;
    }
    if (reason === undefined) {
      await this.cdp.send('Fetch.continueRequest', { requestId }, this.sessionId).catch(() => undefined);
      return;
    }
    if (reason === '') {
      // A background POST (analytics, beacons) is refused silently.
      await this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, this.sessionId).catch(() => undefined);
      return;
    }
    await fail(reason);
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  consumeAction(): void {
    if (this.actionsUsed >= this.maxActions) {
      throw new BrowserSessionError(
        `this browsing session has used all ${this.maxActions} actions; report what was found so far or start a new session with browser_stop`,
        'browser_action_budget_exhausted',
      );
    }
    this.actionsUsed += 1;
  }

  private async waitForLoad(): Promise<void> {
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    await sleep(150);
    while (Date.now() < deadline) {
      const ready = await evaluate(this.cdp, this.sessionId, 'document.readyState').catch(() => 'loading');
      if (ready === 'complete' || ready === 'interactive') return;
      await sleep(150);
    }
  }

  async navigate(url: string): Promise<void> {
    const result = await this.cdp.send('Page.navigate', { url }, this.sessionId);
    if (result.errorText && !this.blocked.length) {
      throw new BrowserSessionError(`could not open ${url}: ${String(result.errorText)}`, 'browser_navigation_failed');
    }
    await this.waitForLoad();
  }

  async click(target: { linkIndex?: number; locator?: PageLocator }): Promise<void> {
    if (typeof target.linkIndex === 'number') {
      const href = await evaluate(this.cdp, this.sessionId, `(function () {
        const a = document.querySelector('[data-kdk-link="${Math.floor(target.linkIndex)}"]');
        return a ? a.href.split('#')[0] : null;
      })()`);
      if (typeof href !== 'string') {
        throw new BrowserSessionError(`link ${target.linkIndex} does not exist on this page; read the page again`, 'browser_target_missing');
      }
      await this.navigate(href);
      return;
    }
    if (!target.locator) throw new BrowserSessionError('click needs linkIndex or locator', 'browser_invalid_arguments');
    await applyStep(this.cdp, this.sessionId, { action: 'click', locator: target.locator });
    await this.waitForLoad();
  }

  async scroll(direction: 'down' | 'up'): Promise<void> {
    await evaluate(this.cdp, this.sessionId, `window.scrollBy(0, ${direction === 'up' ? -1 : 1} * window.innerHeight * 0.9)`);
    await sleep(200);
  }

  async back(): Promise<void> {
    await evaluate(this.cdp, this.sessionId, 'history.back()');
    await this.waitForLoad();
  }

  async state(): Promise<BrowserPageState> {
    let raw = await this.readPage();
    let url = String((raw as { url?: unknown } | undefined)?.url ?? '');
    // A guard-blocked navigation lands on Chrome's error page: return to the
    // last good page and report the block instead of failing the session.
    if (url.startsWith('chrome-error:') && this.lastGoodUrl) {
      if (!this.blocked.length) this.blocked.push('the page could not be loaded');
      await this.navigate(this.lastGoodUrl);
      raw = await this.readPage();
      url = String((raw as { url?: unknown } | undefined)?.url ?? '');
    }
    const page = (raw && typeof raw === 'object' ? raw : {}) as Partial<BrowserPageState>;
    // A page that escaped http(s) (file:, chrome:) is never left open.
    if (url && !/^(https?:|about:blank)/.test(url)) {
      await this.navigate('about:blank');
      throw new BrowserSessionError(`the page could not be shown (${url.slice(0, 60)}); ${this.blocked[0] ?? 'it left the public web'}`, 'browser_navigation_blocked');
    }
    if (/^https?:/.test(url)) this.lastGoodUrl = url;
    const blocked = this.blocked;
    this.blocked = [];
    return {
      url,
      title: String(page.title ?? ''),
      text: String(page.text ?? ''),
      links: page.links ?? [],
      controls: page.controls ?? [],
      actionsUsed: this.actionsUsed,
      actionsRemaining: Math.max(this.maxActions - this.actionsUsed, 0),
      blocked: [...new Set(blocked)].slice(0, 5),
    };
  }

  /** Reads the main content (not banners/navigation) and numbers its links. */
  private readPage(): Promise<unknown> {
    return evaluate(this.cdp, this.sessionId, `(function () {
      const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const root = document.querySelector('main, [role=main], article, #content') || document.body || document.documentElement;
      document.querySelectorAll('[data-kdk-link]').forEach((el) => el.removeAttribute('data-kdk-link'));
      const seen = new Set();
      const links = [];
      for (const a of Array.from(root.querySelectorAll('a[href]'))) {
        if (links.length >= ${MAX_LINKS}) break;
        const href = a.href.split('#')[0];
        const text = clean(a.innerText || a.getAttribute('aria-label') || a.title).slice(0, 80);
        if (!href.startsWith('http') || !text || href === location.href.split('#')[0] || seen.has(href)) continue;
        seen.add(href);
        a.setAttribute('data-kdk-link', String(links.length + 1));
        links.push({ index: links.length + 1, text, href });
      }
      const controls = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select, button'))
        .map((el) => ({ kind: el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''),
          label: clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.innerText || el.name).slice(0, 60) }))
        .filter((c) => c.label)
        .slice(0, ${MAX_CONTROLS});
      return { url: location.href, title: document.title,
        text: clean(root.innerText).slice(0, ${MAX_TEXT_CHARS}), links, controls };
    })()`);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.onClosed();
    this.cdp.close();
    await killProcessTree(this.child);
    removeBrowserProfileDir(this.profileDir);
  }
}

export interface BrowserSessionManagerOptions {
  browserBin: () => string | null;
  maxActions?: number;
}

/** Owns every live session, keyed by conversation. */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly launching = new Map<string, Promise<BrowserSession>>();

  constructor(private readonly options: BrowserSessionManagerOptions) {}

  has(key: string): boolean {
    return this.sessions.has(key);
  }

  private async session(key: string, create: boolean, signal?: AbortSignal): Promise<BrowserSession> {
    const live = this.sessions.get(key);
    if (live && !live.isClosed) return live;
    if (!create) {
      throw new BrowserSessionError('no browsing session is open; start one with browser_open_site', 'browser_no_session');
    }
    const pending = this.launching.get(key);
    if (pending) return pending;
    const browserBin = this.options.browserBin();
    if (!browserBin) throw new BrowserSessionError('no host browser is available; set KARKEDIKHA_BROWSER_BIN', 'browser_unavailable');
    const launch = BrowserSession.launch(
      browserBin,
      this.options.maxActions ?? DEFAULT_MAX_BROWSER_ACTIONS,
      () => { this.sessions.delete(key); },
      signal,
    );
    this.launching.set(key, launch);
    try {
      const session = await launch;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.launching.delete(key);
    }
  }

  /**
   * Runs one action. Cancelling the turn (Stop) closes the whole session so
   * nothing continues in the background.
   */
  private async act(
    key: string,
    signal: AbortSignal | undefined,
    create: boolean,
    countsAsAction: boolean,
    fn: (session: BrowserSession) => Promise<void>,
  ): Promise<BrowserPageState> {
    if (signal?.aborted) throw new BrowserSessionError('browsing was stopped', 'browser_cancelled');
    const session = await this.session(key, create, signal);
    const stopped = async () => {
      await session.close();
      return new BrowserSessionError('browsing was stopped', 'browser_cancelled');
    };
    const onAbort = () => { void session.close(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw await stopped();
      if (countsAsAction) session.consumeAction();
      await fn(session);
      if (signal?.aborted || session.isClosed) throw await stopped();
      session.touch();
      return await session.state();
    } catch (err) {
      if (signal?.aborted || session.isClosed) throw await stopped();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Records a user-approved site for this conversation, then opens the URL. */
  openSite(key: string, url: string, signal?: AbortSignal): Promise<BrowserPageState> {
    const target = resolvePublicWebUrl(url);
    if (!target.ok) return Promise.reject(new BrowserSessionError(target.reason, 'browser_navigation_blocked'));
    return this.act(key, signal, true, true, async (s) => {
      s.approvedSites.add(siteKey(target.host));
      await s.navigate(target.url);
    });
  }

  goto(key: string, url: string, signal?: AbortSignal): Promise<BrowserPageState> {
    const target = resolvePublicWebUrl(url);
    if (!target.ok) return Promise.reject(new BrowserSessionError(target.reason, 'browser_navigation_blocked'));
    return this.act(key, signal, false, true, async (s) => {
      if (!hostAllowed(target.host, s.approvedSites)) {
        throw new BrowserSessionError(
          `${target.host} is not an approved site in this session; call browser_open_site to ask the user`,
          'browser_site_not_approved',
        );
      }
      await s.navigate(target.url);
    });
  }

  click(key: string, target: { linkIndex?: number; locator?: PageLocator }, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, true, (s) => s.click(target));
  }

  scroll(key: string, direction: 'down' | 'up', signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, true, (s) => s.scroll(direction));
  }

  back(key: string, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, true, (s) => s.back());
  }

  read(key: string, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, false, async () => undefined);
  }

  async stop(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    if (!session) return false;
    await session.close();
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}

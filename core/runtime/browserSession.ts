/**
 * Persistent, bounded open-web browser sessions for the chat agent.
 *
 * One host browser per conversation, kept alive between tool calls so the
 * agent can navigate across pages. Every request the page makes passes a
 * Core-owned network guard (CDP Fetch interception):
 *   - only public http(s) URLs; all traffic leaves through the Core egress
 *     proxy, which resolves each host once and connects to the vetted public
 *     address, so a name that rebinds to a private address is refused;
 *   - a top-level navigation may only reach a site the user approved;
 *   - non-GET requests are refused, except one form submission the user
 *     approved separately through browser_submit.
 * Page content is returned as untrusted data, never as instructions.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
import { resolvePublicWebUrl, siteKey } from './browserHostPolicy';
import { EGRESS_CANARY_HOST, startEgressProxy, type EgressProxy } from './browserEgressProxy';
import type { PageLocator } from './pageLocator';

export const DEFAULT_MAX_BROWSER_ACTIONS = 15;
const IDLE_CLOSE_MS = 10 * 60_000;
const NAV_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 3_000;
const MAX_LINKS = 60;
const MAX_CONTROLS = 25;
const CANARY_TIMEOUT_MS = 5_000;
const SUBMIT_ARM_MS = 15_000;
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

/**
 * Browsers this process launched. They are killed when Core exits, so a
 * session never outlives the Core that governs its network guard.
 */
const liveBrowsers = new Set<ChildProcess>();

function killBrowserNow(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

let exitHookInstalled = false;

function trackLiveBrowser(child: ChildProcess): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const c of liveBrowsers) killBrowserNow(c); });
  }
  liveBrowsers.add(child);
  child.once('exit', () => liveBrowsers.delete(child));
}

function describeLocator(locator: PageLocator): string {
  const l = locator as Record<string, unknown>;
  return String(l.label ?? l.name ?? l.text ?? l.css ?? JSON.stringify(locator));
}

class BrowserSession {
  readonly approvedSites = new Set<string>();
  actionsUsed = 0;
  private blocked: string[] = [];
  /** Values the agent typed through browser_fill on the current page, by field. */
  readonly fills = new Map<string, string>();
  /** One approved form submission may pass the guard, to this site, until it expires. */
  private armedSubmit?: { site: string; until: number };
  private idleTimer?: NodeJS.Timeout;
  private closed = false;
  private mainFrameId = '';
  private lastGoodUrl = '';

  private constructor(
    private readonly child: ChildProcess,
    private readonly proxy: EgressProxy,
    private readonly cdp: CdpSession,
    private readonly sessionId: string,
    private readonly profileDir: string,
    readonly maxActions: number,
    private readonly onClosed: () => void,
  ) {}

  static async launch(browserBin: string, maxActions: number, onClosed: () => void, signal?: AbortSignal): Promise<BrowserSession> {
    const debugPort = await freePort();
    const proxy = await startEgressProxy();
    const profileDir = createBrowserProfileDir();
    const child = spawn(browserBin, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      // Every connection goes through the Core egress proxy (loopback too),
      // and nothing may bypass it over UDP.
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      ...(process.platform !== 'win32' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    trackLiveBrowser(child);
    try {
      const cdp = await connectCdp(await waitForDebugEndpoint(debugPort, signal));
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attached = await cdp.send('Target.attachToTarget', { targetId: String(created.targetId ?? ''), flatten: true });
      const sessionId = String(attached.sessionId ?? '');
      const session = new BrowserSession(child, proxy, cdp, sessionId, profileDir, maxActions, onClosed);
      await session.install();
      return session;
    } catch (err) {
      await proxy.close();
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
    await this.proveEgressProxy();
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  }

  /**
   * Fails closed unless the browser demonstrably sends its traffic through
   * the egress proxy: the canary host does not exist, so only the proxy can
   * have answered it.
   */
  private async proveEgressProxy(): Promise<void> {
    void this.cdp.send('Page.navigate', { url: `http://${EGRESS_CANARY_HOST}/` }, this.sessionId).catch(() => undefined);
    const deadline = Date.now() + CANARY_TIMEOUT_MS;
    while (!this.proxy.canarySeen && Date.now() < deadline) await sleep(50);
    if (!this.proxy.canarySeen) {
      throw new BrowserSessionError('the browser network guard could not be verified, so browsing stays off', 'browser_network_guard_unverified');
    }
    await this.cdp.send('Page.navigate', { url: 'about:blank' }, this.sessionId).catch(() => undefined);
  }

  private takeArmedSubmit(host: string): boolean {
    const armed = this.armedSubmit;
    if (!armed || Date.now() > armed.until || !hostAllowed(host, new Set([armed.site]))) return false;
    this.armedSubmit = undefined;
    return true;
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
    } else if (isTopNavigation && !hostAllowed(target.host, this.approvedSites)) {
      reason = `navigation to ${target.host} was stopped: that site is not approved yet (use browser_open_site)`;
    } else if (!SAFE_METHODS.has(method)) {
      if (!isTopNavigation) {
        reason = '';
      } else if (!this.takeArmedSubmit(target.host)) {
        reason = `form submission (${method}) to ${target.host} was not sent: it needs the user's approval through browser_submit`;
      }
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

  private async currentHost(): Promise<string> {
    const href = await evaluate(this.cdp, this.sessionId, 'location.href').catch(() => '');
    try {
      return new URL(String(href)).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  async fill(locator: PageLocator, value: string): Promise<void> {
    const host = await this.currentHost();
    if (!host || !hostAllowed(host, this.approvedSites)) {
      throw new BrowserSessionError('fields can only be filled on a page of an approved site', 'browser_site_not_approved');
    }
    await applyStep(this.cdp, this.sessionId, { action: 'fill', locator, value });
    this.fills.set(describeLocator(locator), value);
  }

  /**
   * Submits the current form after the user approved exactly these values.
   * Refuses when the typed values differ from what was approved.
   */
  async submit(locator: PageLocator, approvedFields: Record<string, string>): Promise<void> {
    const host = await this.currentHost();
    if (!host || !hostAllowed(host, this.approvedSites)) {
      throw new BrowserSessionError('a form can only be submitted on a page of an approved site', 'browser_site_not_approved');
    }
    const typed = Object.fromEntries(this.fills);
    const approved = Object.fromEntries(Object.entries(approvedFields).map(([k, v]) => [k, String(v)]));
    const same = Object.keys(typed).length > 0
      && Object.keys(typed).length === Object.keys(approved).length
      && Object.entries(typed).every(([k, v]) => approved[k] === v);
    if (!same) {
      throw new BrowserSessionError(
        `the approved values do not match what was typed (typed: ${JSON.stringify(typed)}); nothing was submitted`,
        'browser_submit_mismatch',
      );
    }
    this.armedSubmit = { site: siteKey(host), until: Date.now() + SUBMIT_ARM_MS };
    try {
      await applyStep(this.cdp, this.sessionId, { action: 'click', locator });
      await sleep(300);
      await this.waitForLoad();
    } finally {
      this.armedSubmit = undefined;
      this.fills.clear();
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
    if (/^https?:/.test(url)) {
      if (url !== this.lastGoodUrl) this.fills.clear();
      this.lastGoodUrl = url;
    }
    const blocked = [...this.blocked, ...this.proxy.drainRefusals()];
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

  /**
   * A small JPEG of what the page shows right now, for the user's workspace
   * view. Taken once per action, never polled, and scaled down so it stays
   * cheap to keep.
   */
  async screenshot(): Promise<Buffer | null> {
    if (this.closed) return null;
    const shot = await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 55,
      clip: { x: 0, y: 0, width: 1280, height: 900, scale: 0.625 },
    }, this.sessionId).catch(() => null);
    const data = typeof shot?.data === 'string' ? shot.data : '';
    return data ? Buffer.from(data, 'base64') : null;
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
    await this.proxy.close();
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

  fill(key: string, locator: PageLocator, value: string, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, true, (s) => s.fill(locator, value));
  }

  submit(key: string, locator: PageLocator, approvedFields: Record<string, string>, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, true, (s) => s.submit(locator, approvedFields));
  }

  read(key: string, signal?: AbortSignal): Promise<BrowserPageState> {
    return this.act(key, signal, false, false, async () => undefined);
  }

  /** The current page of a live session as a small JPEG, or null when there is none. */
  async screenshot(key: string): Promise<Buffer | null> {
    const session = this.sessions.get(key);
    if (!session || session.isClosed) return null;
    return session.screenshot();
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

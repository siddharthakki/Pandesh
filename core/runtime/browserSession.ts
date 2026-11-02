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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWindowsProcessIdentityProviderSync, type SyncProcessIdentityProvider } from './processOwnership';
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
import { PAGE_LOCATOR_RUNTIME, describeLocator as describeLocatorText, parsePageLocator, type PageLocator } from './pageLocator';

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
export interface PageControl { kind: string; label: string; name?: string; value?: string }

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

export interface BrowserProcessRecord {
  pid: number;
  corePid: number;
  sessionId: string;
  startedAt: string;
  /** Epoch ms taken just before spawn; compared with the OS creation time so a reused PID is never killed. */
  spawnedAtMs?: number;
}

function browserRecordFile(dataDir: string): string {
  return path.join(dataDir, 'browser-launched-processes.json');
}

function readBrowserRecords(dataDir: string): BrowserProcessRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(browserRecordFile(dataDir), 'utf8'));
    if (Array.isArray(parsed)) return parsed as BrowserProcessRecord[];
  } catch {}
  return [];
}

function writeBrowserRecords(dataDir: string, records: BrowserProcessRecord[]): void {
  try {
    fs.mkdirSync(path.dirname(browserRecordFile(dataDir)), { recursive: true });
    fs.writeFileSync(browserRecordFile(dataDir), JSON.stringify(records, null, 2), 'utf8');
  } catch {}
}

function recordBrowserLaunch(dataDir: string | undefined, child: ChildProcess, spawnedAtMs: number): void {
  if (!dataDir || !child.pid) return;
  const records = readBrowserRecords(dataDir);
  records.push({ pid: child.pid, corePid: process.pid, sessionId: '', startedAt: new Date().toISOString(), spawnedAtMs });
  writeBrowserRecords(dataDir, records);
}

function removeBrowserRecord(dataDir: string | undefined, pid: number): void {
  if (!dataDir) return;
  writeBrowserRecords(dataDir, readBrowserRecords(dataDir).filter((record) => record.pid !== pid));
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function killProcessByPid(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/** A browser's OS creation time must fall in this window around its recorded spawn time. */
const SPAWN_WINDOW_BEFORE_MS = 2_000;
const SPAWN_WINDOW_AFTER_MS = 15_000;

export interface ReapOptions {
  identity?: SyncProcessIdentityProvider;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
}

/**
 * Reaps browser processes left behind when a previous Core process crashed.
 * A record is orphaned when its launcher Core pid is neither this process nor
 * still alive. Before killing, the PID's OS creation time must match the
 * recorded spawn time: after a crash or reboot the PID may belong to an
 * unrelated process, which is dropped from the ledger and left alone. When the
 * OS cannot disclose a creation time, nothing is killed. Records belonging to a
 * live Core (this one or another) are kept.
 */
export function reapOrphanedBrowsers(dataDir: string, options: ReapOptions = {}): { reaped: number; errors: string[] } {
  const identityOf = options.identity ?? createWindowsProcessIdentityProviderSync();
  const alive = options.isAlive ?? isProcessAlive;
  const kill = options.kill ?? killProcessByPid;
  const errors: string[] = [];
  let reaped = 0;
  const selfPid = process.pid;
  const remaining: BrowserProcessRecord[] = [];
  for (const record of readBrowserRecords(dataDir)) {
    if (record.corePid === selfPid || alive(record.corePid)) {
      remaining.push(record);
      continue;
    }
    if (!Number.isInteger(record.pid) || record.pid <= 0) continue;
    try {
      const snapshot = identityOf(record.pid);
      if (!snapshot.alive) continue;
      const spawned = record.spawnedAtMs;
      const created = snapshot.creationTimeMs;
      if (typeof spawned !== 'number' || created === null) {
        errors.push(`pid ${record.pid}: identity unverifiable, not killed`);
        continue;
      }
      // A creation time outside the spawn window means the PID was reused.
      if (created < spawned - SPAWN_WINDOW_BEFORE_MS || created > spawned + SPAWN_WINDOW_AFTER_MS) continue;
      kill(record.pid);
      reaped += 1;
    } catch (err) {
      errors.push(String(err));
      remaining.push(record);
    }
  }
  writeBrowserRecords(dataDir, remaining);
  return { reaped, errors };
}

function describeLocator(locator: PageLocator): string {
  const l = locator as Record<string, unknown>;
  return String(l.label ?? l.name ?? l.text ?? l.css ?? JSON.stringify(locator));
}

/**
 * The locator a model meant, from the shapes small models actually send:
 * a bare string, `{name}` without a role, `{placeholder}`, `{id}` or
 * `{selector}`. Anything else goes through the strict parser unchanged.
 */
export function browserLocator(raw: unknown): PageLocator | undefined {
  if (typeof raw === 'string') return raw.trim() ? { label: raw.trim() } : undefined;
  const strict = parsePageLocator(raw);
  if (strict || !raw || typeof raw !== 'object') return strict;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const label = str(r.name) ?? str(r.placeholder) ?? str(r.field) ?? str(r.ariaLabel) ?? str(r.aria_label);
  if (label) return { label };
  const id = str(r.id);
  if (id) return { css: `#${id.replace(/[^\w-]/g, '')}` };
  const selector = str(r.selector);
  return selector ? { css: selector } : undefined;
}

class BrowserSession {
  readonly approvedSites = new Set<string>();
  actionsUsed = 0;
  private blocked: string[] = [];
  /** Values the agent typed through browser_fill on the current page, by field. */
  readonly fills = new Map<string, { value: string; name: string; asked: string }>();
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
    private readonly dataDir: string | undefined,
  ) {}

  static async launch(browserBin: string, maxActions: number, onClosed: () => void, signal?: AbortSignal, dataDir?: string): Promise<BrowserSession> {
    const debugPort = await freePort();
    const proxy = await startEgressProxy();
    const profileDir = createBrowserProfileDir();
    const spawnedAtMs = Date.now();
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
    recordBrowserLaunch(dataDir, child, spawnedAtMs);
    try {
      const cdp = await connectCdp(await waitForDebugEndpoint(debugPort, signal));
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const attached = await cdp.send('Target.attachToTarget', { targetId: String(created.targetId ?? ''), flatten: true });
      const sessionId = String(attached.sessionId ?? '');
      const session = new BrowserSession(child, proxy, cdp, sessionId, profileDir, maxActions, onClosed, dataDir);
      await session.install();
      return session;
    } catch (err) {
      if (child.pid !== undefined) removeBrowserRecord(dataDir, child.pid);
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

  async currentUrl(): Promise<string> {
    return String(await evaluate(this.cdp, this.sessionId, 'location.href').catch(() => ''));
  }

  async location(): Promise<{ url: string; title: string }> {
    const at = await evaluate(this.cdp, this.sessionId, '[location.href, document.title]').catch(() => ['', '']);
    const [url, title] = Array.isArray(at) ? at.map(String) : ['', ''];
    return { url, title };
  }

  private async currentHost(): Promise<string> {
    const href = await evaluate(this.cdp, this.sessionId, 'location.href').catch(() => '');
    try {
      return new URL(String(href)).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * Types into one field. The field is found by its exact locator first, then
   * — for a label, name or text — by the field's own label, name, id or
   * placeholder ignoring case and a trailing ":" or "*", but only when exactly
   * one field matches. A miss names the fields that do exist, so the next
   * attempt has something new to go on.
   */
  async fill(locator: PageLocator, value: string): Promise<void> {
    const host = await this.currentHost();
    if (!host || !hostAllowed(host, this.approvedSites)) {
      throw new BrowserSessionError('fields can only be filled on a page of an approved site', 'browser_site_not_approved');
    }
    const result = await evaluate(this.cdp, this.sessionId, `(function () {
      ${PAGE_LOCATOR_RUNTIME}
      const locator = ${JSON.stringify(locator)};
      const value = ${JSON.stringify(value)};
      const norm = (s) => kdkNorm(s).replace(/[\\s:*]+$/, '');
      const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter((f) => {
        const t = String(f.type || '').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(t) && !f.disabled && !f.readOnly;
      });
      let el = null;
      try { el = kdkFindByLocator(locator); } catch (err) { el = null; }
      if (el && el.tagName === 'LABEL' && el.control) el = el.control;
      if (el && !fields.includes(el)) el = null;
      const wanted = norm(locator.label || locator.name || locator.text || '');
      if (!el && wanted) {
        const keys = (f) => [kdkAccessibleName(f), f.name, f.id, f.getAttribute('placeholder')].map(norm).filter(Boolean);
        const exact = fields.filter((f) => keys(f).includes(wanted));
        const loose = exact.length ? exact : fields.filter((f) => keys(f).some((k) => k.length > 2 && (k.includes(wanted) || wanted.includes(k))));
        if (loose.length === 1) el = loose[0];
      }
      const describe = (f) => ({ label: kdkAccessibleName(f).replace(/[\\s:*]+$/, '').slice(0, 60), name: f.name || '' });
      if (!el) return { ok: false, fields: fields.slice(0, 20).map(describe) };
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      el.focus();
      const type = String(el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        el.checked = /^(1|true|yes|on|checked|selected)$/i.test(value.trim());
      } else if (el.tagName === 'SELECT') {
        const option = Array.from(el.options).find((o) => norm(o.value) === norm(value) || norm(o.text) === norm(value));
        if (!option) return { ok: false, options: Array.from(el.options).map((o) => o.text).slice(0, 20), field: describe(el) };
        el.value = option.value;
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, field: describe(el), value: type === 'checkbox' || type === 'radio' ? String(el.checked) : el.value };
    })()`) as { ok: boolean; field?: { label: string; name: string }; value?: string; fields?: Array<{ label: string; name: string }>; options?: string[] };
    if (!result?.ok) {
      if (result?.options) {
        throw new BrowserSessionError(
          `"${value}" is not one of the choices in "${result.field?.label}": ${result.options.join(', ')}`,
          'browser_target_missing',
        );
      }
      const known = (result?.fields ?? []).map((f) => `"${f.label || f.name}"${f.name ? ` (name=${f.name})` : ''}`).join(', ');
      throw new BrowserSessionError(
        `no single field on this page matches ${describeLocatorText(locator)}. ${known ? `Fields here: ${known}. Use {"label": "<one of these>"}.` : 'This page has no fillable fields.'}`,
        'browser_target_missing',
      );
    }
    if (result.value !== value && result.value !== 'true' && result.value !== 'false' && result.field) {
      throw new BrowserSessionError(`the field "${result.field.label}" kept "${String(result.value).slice(0, 80)}" instead of the value typed`, 'browser_action_failed');
    }
    const label = result.field?.label || result.field?.name || describeLocator(locator);
    this.fills.set(label, { value: result.value ?? value, name: result.field?.name ?? '', asked: describeLocator(locator) });
  }

  /** What was typed on this page, by field label: what a submission would send. */
  typedFields(): Record<string, string> {
    return Object.fromEntries([...this.fills].map(([label, fill]) => [label, fill.value]));
  }

  /** Where the form holding the typed fields would be sent. */
  async formDestination(): Promise<string> {
    const names = [...this.fills.values()].map((f) => f.name).filter(Boolean);
    const target = await evaluate(this.cdp, this.sessionId, `(function () {
      const names = ${JSON.stringify(names)};
      const field = names.map((n) => document.getElementsByName(n)[0]).find(Boolean);
      const form = (field && field.form) || document.forms[0];
      if (!form) return '';
      return (form.method || 'get').toUpperCase() + ' ' + form.action;
    })()`).catch(() => '');
    return String(target ?? '');
  }

  /**
   * Submits the current form after the user approved exactly these values.
   * Refuses when the typed values differ from what was approved. A field is
   * matched by its label, its name, or the locator text used to fill it,
   * ignoring case, spacing, "_" and a trailing ":".
   */
  async submit(locator: PageLocator, approvedFields: Record<string, string>): Promise<void> {
    const host = await this.currentHost();
    if (!host || !hostAllowed(host, this.approvedSites)) {
      throw new BrowserSessionError('a form can only be submitted on a page of an approved site', 'browser_site_not_approved');
    }
    const typed = this.typedFields();
    const key = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').replace(/^label "|"$/g, '').replace(/[\s:*]+$/, '').trim();
    const approved = new Map(Object.entries(approvedFields).map(([k, v]) => [key(k), String(v)]));
    const same = this.fills.size > 0
      && this.fills.size === approved.size
      && [...this.fills].every(([label, fill]) => {
        const match = [label, fill.name, fill.asked].map(key).find((k) => approved.has(k));
        return match !== undefined && approved.get(match) === fill.value;
      });
    if (!same) {
      throw new BrowserSessionError(
        `the values approved for submission do not match what was typed on this page; nothing was submitted`,
        'browser_submit_mismatch',
      );
    }
    // What is sent is what the page holds: refuse when the fields no longer
    // carry the approved values (the page reloaded, a script changed them).
    const held = await evaluate(this.cdp, this.sessionId, `(function () {
      const names = ${JSON.stringify([...this.fills.values()].map((f) => f.name))};
      return names.map((n) => { const el = n && document.getElementsByName(n)[0]; return el ? String(el.value) : null; });
    })()`) as Array<string | null>;
    const entries = [...this.fills.entries()];
    // Re-verify against what the page really holds right now, measured against
    // the values the user approved (the approval boundary), not against the
    // session's own memory of what was typed. A page that was reloaded or
    // changed by a script refuses the submission instead of sending stale data.
    for (let i = 0; i < entries.length; i++) {
      const [label, fill] = entries[i];
      if (!fill.name) continue;
      const match = [label, fill.name, fill.asked].map(key).find((k) => approved.has(k));
      const approvedValue = match !== undefined ? approved.get(match) : undefined;
      if (approvedValue !== undefined && held[i] !== approvedValue) {
        this.fills.clear();
        throw new BrowserSessionError('the page no longer holds the approved values (it was reloaded or changed); nothing was submitted. Fill the fields again before submitting', 'browser_submit_mismatch');
      }
    }
    this.armedSubmit = { site: siteKey(host), until: Date.now() + SUBMIT_ARM_MS };
    try {
      await this.clickLocator(locator);
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
    await this.clickLocator(target.locator);
    await this.waitForLoad();
  }

  /** Clicks an element; a miss names the buttons the page does have. */
  private async clickLocator(locator: PageLocator): Promise<void> {
    try {
      await applyStep(this.cdp, this.sessionId, { action: 'click', locator });
    } catch (err) {
      if (!/locator not found/.test(err instanceof Error ? err.message : String(err))) throw err;
      const buttons = await evaluate(this.cdp, this.sessionId, `Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'))
        .map((b) => String(b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 15)`).catch(() => []);
      const list = Array.isArray(buttons) && buttons.length ? ` Buttons here: ${buttons.map((b) => `"${String(b)}"`).join(', ')}; use {"text": "<one of these>"}, or a numbered link with linkIndex.` : '';
      throw new BrowserSessionError(`nothing on this page matches ${describeLocatorText(locator)}.${list}`, 'browser_target_missing');
    }
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
      // Reloading the page empties its fields: nothing typed is held any more.
      this.fills.clear();
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
      const kindOf = (el) => {
        const t = String(el.type || '').toLowerCase();
        if (el.tagName === 'BUTTON' || ['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
        if (el.tagName === 'TEXTAREA') return 'text area';
        if (el.tagName === 'SELECT') return 'choice list';
        if (t === 'checkbox' || t === 'radio') return t;
        return 'text field';
      };
      const controls = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select, button'))
        .map((el) => {
          const kind = kindOf(el);
          const t = String(el.type || '').toLowerCase();
          const value = kind === 'button' || t === 'password' ? '' : (t === 'checkbox' || t === 'radio' ? (el.checked ? 'checked' : '') : String(el.value || ''));
          return { kind,
            label: clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.innerText || el.value || el.name).replace(/[\\s:*]+$/, '').slice(0, 60),
            name: String(el.name || '').slice(0, 40),
            value: clean(value).slice(0, 60) };
        })
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
    // The clip is in page coordinates: follow the scroll so the picture is
    // what the viewport shows, not the top of the document.
    const at = await evaluate(this.cdp, this.sessionId, '[window.scrollX, window.scrollY]').catch(() => [0, 0]);
    const [x, y] = Array.isArray(at) ? at.map((n) => Math.max(0, Number(n) || 0)) : [0, 0];
    const shot = await this.cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x, y, width: 1280, height: 900, scale: 0.625 },
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
    if (this.child.pid !== undefined) removeBrowserRecord(this.dataDir, this.child.pid);
    this.cdp.close();
    await killProcessTree(this.child);
    await this.proxy.close();
    removeBrowserProfileDir(this.profileDir);
  }
}

export interface BrowserSessionManagerOptions {
  browserBin: () => string | null;
  maxActions?: number;
  dataDir?: string;
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
      this.options.dataDir,
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

  /** What was typed on the session's current page, and where its form would go. */
  async pendingForm(key: string): Promise<{ fields: Record<string, string>; destination: string; page: string } | null> {
    const session = this.sessions.get(key);
    if (!session || session.isClosed || session.fills.size === 0) return null;
    return { fields: session.typedFields(), destination: await session.formDestination(), page: await session.currentUrl() };
  }

  /** The address and title the live session shows, without spending an action. */
  async peek(key: string): Promise<{ url: string; title: string } | null> {
    const session = this.sessions.get(key);
    if (!session || session.isClosed) return null;
    return session.location();
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

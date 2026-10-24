import { randomUUID } from 'crypto';

export interface BrowserLaunchOptions {
  profileId: string;
  headless: boolean;
  viewport: { width: number; height: number };
}

export interface BrowserNavigationResult {
  url: string;
  status?: number;
  title?: string;
}

export interface BrowserAssertion {
  id: string;
  type: 'text' | 'visible' | 'hidden' | 'attribute' | 'url' | 'accessibility' | 'custom';
  selector?: string;
  expected?: unknown;
  description: string;
  required: boolean;
}

export interface BrowserAssertionResult extends BrowserAssertion {
  passed: boolean;
  actual?: unknown;
  error?: string;
}

export interface BrowserConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  timestamp: string;
}

export interface BrowserNetworkEntry {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
}

export interface AccessibilitySnapshot {
  role: string;
  name?: string;
  children?: AccessibilitySnapshot[];
  properties?: Record<string, unknown>;
}

export interface BrowserScreenshot {
  id: string;
  label: string;
  path?: string;
  dataHash?: string;
  width?: number;
  height?: number;
}

export interface BrowserDriver {
  launch(options: BrowserLaunchOptions, signal: AbortSignal): Promise<void>;
  navigate(url: string, signal: AbortSignal): Promise<BrowserNavigationResult>;
  assert(assertion: BrowserAssertion, signal: AbortSignal): Promise<{ passed: boolean; actual?: unknown; error?: string }>;
  screenshot(label: string, signal: AbortSignal): Promise<Omit<BrowserScreenshot, 'id' | 'label'>>;
  consoleEntries(signal: AbortSignal): Promise<BrowserConsoleEntry[]>;
  networkEntries(signal: AbortSignal): Promise<BrowserNetworkEntry[]>;
  accessibilitySnapshot(signal: AbortSignal): Promise<AccessibilitySnapshot | undefined>;
  close(): Promise<void>;
}

export interface BrowserVerificationRequest {
  verificationId: string;
  startUrl: string;
  allowedHosts: string[];
  assertions: BrowserAssertion[];
  screenshots?: string[];
  viewport?: { width: number; height: number };
  failOnConsoleError?: boolean;
  failOnNetworkError?: boolean;
  timeoutMs?: number;
}

export interface BrowserVerificationReport {
  schemaVersion: 1;
  verificationId: string;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  navigation?: BrowserNavigationResult;
  assertions: BrowserAssertionResult[];
  screenshots: BrowserScreenshot[];
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  accessibility?: AccessibilitySnapshot;
  cleanupPassed: boolean;
  error?: string;
}

export class BrowserVerificationRunner {
  private controller?: AbortController;

  constructor(private readonly driver: BrowserDriver) {}

  async verify(request: BrowserVerificationRequest): Promise<BrowserVerificationReport> {
    validateRequest(request);
    if (this.controller) throw new Error('Browser verification is already running.');
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const startedAt = new Date().toISOString();
    const assertions: BrowserAssertionResult[] = [];
    const screenshots: BrowserScreenshot[] = [];
    let navigation: BrowserNavigationResult | undefined;
    let consoleEntries: BrowserConsoleEntry[] = [];
    let networkEntries: BrowserNetworkEntry[] = [];
    let accessibility: AccessibilitySnapshot | undefined;
    let cleanupPassed = false;
    let errorMessage: string | undefined;
    const timer = setTimeout(() => this.controller?.abort(), request.timeoutMs ?? 60_000);

    try {
      await this.driver.launch({
        profileId: `oa-${request.verificationId}-${randomUUID()}`,
        headless: true,
        viewport: request.viewport ?? { width: 1440, height: 900 },
      }, signal);
      assertAllowedUrl(request.startUrl, request.allowedHosts);
      navigation = await this.driver.navigate(request.startUrl, signal);
      assertAllowedUrl(navigation.url, request.allowedHosts);

      for (const assertion of request.assertions) {
        if (signal.aborted) throw abortError();
        try {
          const result = await this.driver.assert({ ...assertion }, signal);
          assertions.push({ ...assertion, ...result });
        } catch (error) {
          assertions.push({
            ...assertion,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const label of request.screenshots ?? ['final']) {
        if (signal.aborted) throw abortError();
        screenshots.push({ id: randomUUID(), label, ...await this.driver.screenshot(label, signal) });
      }
      consoleEntries = sanitizeConsole(await this.driver.consoleEntries(signal));
      networkEntries = (await this.driver.networkEntries(signal)).map(entry => ({ ...entry }));
      for (const entry of networkEntries) assertAllowedUrl(entry.url, request.allowedHosts, true);
      accessibility = await this.driver.accessibilitySnapshot(signal);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      try {
        await this.driver.close();
        cleanupPassed = true;
      } catch (cleanupError) {
        cleanupPassed = false;
        errorMessage = errorMessage
          ? `${errorMessage}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          : `Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
      }
      this.controller = undefined;
    }

    const requiredAssertionsPassed = assertions.every(assertion => !assertion.required || assertion.passed);
    const consolePassed = !request.failOnConsoleError || !consoleEntries.some(entry => entry.level === 'error');
    const networkPassed = !request.failOnNetworkError || !networkEntries.some(entry => entry.failed || (entry.status !== undefined && entry.status >= 400));
    return {
      schemaVersion: 1,
      verificationId: request.verificationId,
      startedAt,
      completedAt: new Date().toISOString(),
      passed: !errorMessage && cleanupPassed && requiredAssertionsPassed && consolePassed && networkPassed,
      navigation,
      assertions,
      screenshots,
      console: consoleEntries,
      network: networkEntries,
      accessibility,
      cleanupPassed,
      error: errorMessage,
    };
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }
}

export interface VisualComparisonRequest {
  baselineHash: string;
  currentHash: string;
  changedPixels?: number;
  totalPixels?: number;
  thresholdRatio: number;
}

export interface VisualComparisonResult {
  passed: boolean;
  differenceRatio: number;
  baselineHash: string;
  currentHash: string;
}

export function compareVisualEvidence(request: VisualComparisonRequest): VisualComparisonResult {
  if (request.thresholdRatio < 0 || request.thresholdRatio > 1) throw new Error('Visual threshold must be between 0 and 1.');
  const differenceRatio = request.baselineHash === request.currentHash
    ? 0
    : request.changedPixels !== undefined && request.totalPixels && request.totalPixels > 0
      ? request.changedPixels / request.totalPixels
      : 1;
  return {
    passed: differenceRatio <= request.thresholdRatio,
    differenceRatio,
    baselineHash: request.baselineHash,
    currentHash: request.currentHash,
  };
}

function validateRequest(request: BrowserVerificationRequest): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(request.verificationId)) throw new Error('Invalid browser verification id.');
  if (request.allowedHosts.length === 0) throw new Error('Browser verification requires at least one allowed host.');
  assertAllowedUrl(request.startUrl, request.allowedHosts);
  const ids = new Set<string>();
  for (const assertion of request.assertions) {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(assertion.id)) throw new Error(`Invalid browser assertion id: ${assertion.id}`);
    if (ids.has(assertion.id)) throw new Error(`Duplicate browser assertion id: ${assertion.id}`);
    ids.add(assertion.id);
  }
}

function assertAllowedUrl(value: string, allowedHosts: string[], allowData = false): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid browser URL: ${value}`); }
  if (allowData && (parsed.protocol === 'data:' || parsed.protocol === 'blob:')) return;
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Browser URL protocol is not allowed: ${parsed.protocol}`);
  const allowed = allowedHosts.some(host => {
    const normalized = host.toLowerCase();
    return parsed.hostname.toLowerCase() === normalized || parsed.hostname.toLowerCase().endsWith(`.${normalized}`);
  });
  if (!allowed) throw new Error(`Browser URL host is not allowed: ${parsed.hostname}`);
}

function sanitizeConsole(entries: BrowserConsoleEntry[]): BrowserConsoleEntry[] {
  return entries.slice(0, 1000).map(entry => ({
    ...entry,
    message: redact(entry.message).slice(0, 4000),
  }));
}

function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)/ig, '$1[REDACTED]');
}

function abortError(): Error {
  const error = new Error('Browser verification cancelled or timed out.');
  error.name = 'AbortError';
  return error;
}

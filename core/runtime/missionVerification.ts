/**
 * Generic mission acceptance verification. Story-specific locators and
 * expected values live in the workspace plan, not here. Plans should use
 * role/name, label, or visible text for behavior the story describes.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recoverRepositoryPath } from './repositoryPathRecovery';
import { resolveHostBrowserBin } from './hostBrowserBin';
import {
  emptyElementProbe,
  runWorkspacePageScenario,
  type BrowserInspectStep,
  type PageElementProbe,
  type PageProbe,
} from './browserInspection';
import {
  describeLocator,
  locatorRef,
  resolveInspectLocator,
  type PageLocator,
} from './pageLocator';
import type { MissionObservation } from './missionObservations';

export const VERIFICATION_PLAN_PATH = '.karkedikha/verification-plan.json';

export type VerificationExpect =
  | { kind: 'text'; selector?: string; locator?: PageLocator; equals: string }
  | { kind: 'value'; selector?: string; locator?: PageLocator; equals: string }
  | { kind: 'visible'; selector?: string; locator?: PageLocator; visible: boolean }
  | { kind: 'focus'; selector?: string; locator?: PageLocator }
  | { kind: 'pressed'; selector?: string; locator?: PageLocator; pressed: boolean }
  | { kind: 'url'; unchanged: true };

export interface VerificationCheck {
  id: string;
  acceptance?: string;
  steps: BrowserInspectStep[];
  expect: VerificationExpect[];
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface VerificationPlan {
  version: 1;
  page: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  checks: VerificationCheck[];
}

export interface VerificationFailure {
  checkId: string;
  assertion: string;
  expected: string;
  actual: string;
}

export interface VerificationResult {
  required: boolean;
  ok: boolean;
  unavailable?: string;
  fingerprint?: string;
  failures: VerificationFailure[];
  summary: string;
}

export type PageScenarioRunner = (input: {
  workspaceRoot: string;
  relativePath: string;
  steps: BrowserInspectStep[];
  selectors: string[];
  viewportWidth?: number;
  viewportHeight?: number;
  signal?: AbortSignal;
}) => Promise<PageProbe>;

const VIEWPORT_WIDTH = { fallback: 1280, min: 320, max: 1920 } as const;
const VIEWPORT_HEIGHT = { fallback: 800, min: 480, max: 1200 } as const;

function resolveViewport(
  value: unknown,
  bounds: { fallback: number; min: number; max: number },
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return bounds.fallback;
  return Math.min(Math.max(n, bounds.min), bounds.max);
}

export function resolvePlanViewport(check: {
  viewportWidth?: unknown;
  viewportHeight?: unknown;
}): { viewportWidth?: number; viewportHeight?: number } {
  return {
    viewportWidth: resolveViewport(check.viewportWidth, VIEWPORT_WIDTH),
    viewportHeight: resolveViewport(check.viewportHeight, VIEWPORT_HEIGHT),
  };
}

export function verificationPlanFile(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ...VERIFICATION_PLAN_PATH.split('/'));
}

export function loadVerificationPlan(workspaceRoot: string): VerificationPlan | null {
  const file = verificationPlanFile(workspaceRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VerificationPlan>;
    if (raw.version !== 1 || typeof raw.page !== 'string' || !Array.isArray(raw.checks) || raw.checks.length === 0) {
      return null;
    }
    return {
      version: 1,
      page: raw.page,
      acceptanceCriteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.map(String) : [],
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      checks: raw.checks as VerificationCheck[],
    };
  } catch {
    return null;
  }
}

export function verificationIsRequired(workspaceRoot: string): boolean {
  return loadVerificationPlan(workspaceRoot) !== null;
}

export function fingerprintVerificationSources(workspaceRoot: string, dependsOn: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const relative of dependsOn) {
    const recovery = recoverRepositoryPath({
      workspaceRoot,
      requestedPath: relative,
      target: 'read',
    });
    const body = recovery.resolvedPath && fs.existsSync(recovery.resolvedPath)
      ? fs.readFileSync(recovery.resolvedPath)
      : Buffer.from(`missing:${relative}`);
    hash.update(relative);
    hash.update('\0');
    hash.update(body);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function isVisuallyHidden(element: PageElementProbe): boolean {
  if (!element.found) return true;
  if (element.display === 'none') return true;
  if (element.visibility === 'hidden' || element.visibility === 'collapse') return true;
  if (Number(element.opacity) === 0) return true;
  return false;
}

export function evaluateExpectations(
  check: VerificationCheck,
  probe: PageProbe,
  startedUrl: string,
): VerificationFailure[] {
  const failures: VerificationFailure[] = [];
  for (const assertion of check.expect) {
    if (assertion.kind === 'url') {
      const baseline = (probe.startedUrl ?? startedUrl).split('#')[0] ?? '';
      const actual = probe.url.split('#')[0] ?? '';
      const reloaded = probe.navigationType === 'reload'
        || (probe.loadMarkerAtStart != null && probe.loadMarker != null && probe.loadMarker !== probe.loadMarkerAtStart);
      if (actual !== baseline || reloaded) {
        failures.push({
          checkId: check.id,
          assertion: 'url unchanged / no reload',
          expected: baseline,
          actual: reloaded ? `reloaded ${probe.url}` : probe.url,
        });
      }
      continue;
    }
    const target = resolveAssertionLocator(assertion);
    if (!target) {
      failures.push({
        checkId: check.id,
        assertion: `${assertion.kind} locator`,
        expected: 'locator',
        actual: 'missing locator',
      });
      continue;
    }
    const key = locatorRef(target);
    const label = describeLocator(target);
    const element = probe.elements[key] ?? emptyElementProbe();
    if (assertion.kind === 'text') {
      if (element.text !== assertion.equals) {
        failures.push({
          checkId: check.id,
          assertion: `text ${label}`,
          expected: assertion.equals,
          actual: element.found ? element.text : 'locator not found',
        });
      }
      continue;
    }
    if (assertion.kind === 'value') {
      if (element.value !== assertion.equals) {
        failures.push({
          checkId: check.id,
          assertion: `value ${label}`,
          expected: assertion.equals,
          actual: element.found ? element.value : 'locator not found',
        });
      }
      continue;
    }
    if (assertion.kind === 'visible') {
      const visible = !isVisuallyHidden(element);
      if (visible !== assertion.visible) {
        failures.push({
          checkId: check.id,
          assertion: `visible ${label}`,
          expected: assertion.visible ? 'visually visible' : 'visually hidden',
          actual: element.found
            ? `display=${element.display}; visibility=${element.visibility}; hiddenAttr=${element.hiddenAttr}`
            : 'locator not found',
        });
      }
      continue;
    }
    if (assertion.kind === 'pressed') {
      const pressed = Boolean(element.pressed);
      if (pressed !== assertion.pressed) {
        failures.push({
          checkId: check.id,
          assertion: `pressed ${label}`,
          expected: assertion.pressed ? 'pressed' : 'not pressed',
          actual: element.found ? (pressed ? 'pressed' : 'not pressed') : 'locator not found',
        });
      }
      continue;
    }
    if (!element.focused) {
      failures.push({
        checkId: check.id,
        assertion: `focus ${label}`,
        expected: label,
        actual: probe.focusId ? `#${probe.focusId}` : 'no focused element',
      });
    }
  }
  return failures;
}

function resolveAssertionLocator(assertion: VerificationExpect): PageLocator | null {
  if (assertion.kind === 'url') return null;
  return resolveInspectLocator({
    selector: assertion.selector,
    locator: assertion.locator,
  });
}

function selectorsFor(plan: VerificationPlan): string[] {
  const selectors = new Set<string>();
  for (const check of plan.checks) {
    for (const step of check.steps) {
      const locator = resolveInspectLocator(step);
      if (locator) selectors.add(locatorRef(locator));
    }
    for (const assertion of check.expect) {
      const locator = resolveAssertionLocator(assertion);
      if (locator) selectors.add(locatorRef(locator));
    }
  }
  return [...selectors];
}

export function formatVerificationObservation(result: VerificationResult): MissionObservation {
  return {
    action: 'verify_acceptance',
    path: VERIFICATION_PLAN_PATH,
    resultCount: result.ok ? result.failures.length : Math.max(1, result.failures.length),
    truncated: false,
    fingerprint: result.fingerprint,
    ok: result.ok,
    output: result.summary,
  };
}

export async function runMissionVerification(input: {
  workspaceRoot: string;
  runner?: PageScenarioRunner;
  browserBin?: string | null;
  signal?: AbortSignal;
}): Promise<VerificationResult> {
  const plan = loadVerificationPlan(input.workspaceRoot);
  if (!plan) {
    return { required: false, ok: true, failures: [], summary: 'no workspace verification plan' };
  }
  const fingerprint = fingerprintVerificationSources(input.workspaceRoot, plan.dependsOn);
  const browserBin = input.browserBin === undefined ? resolveHostBrowserBin() : input.browserBin;
  if (!input.runner && !browserBin) {
    const summary = 'behavioral verification unavailable: no host browser binary; set KARKEDIKHA_BROWSER_BIN';
    return { required: true, ok: false, unavailable: summary, fingerprint, failures: [], summary };
  }
  const runner = input.runner ?? ((request) => runWorkspacePageScenario({
    ...request,
    browserBin,
    signal: input.signal,
  }));
  const selectors = selectorsFor(plan);
  const failures: VerificationFailure[] = [];
  try {
    for (const check of plan.checks) {
      const viewport = resolvePlanViewport(check);
      const probe = await runner({
        workspaceRoot: input.workspaceRoot,
        relativePath: plan.page,
        steps: check.steps,
        selectors,
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        signal: input.signal,
      });
      const startedUrl = probe.url;
      failures.push(...evaluateExpectations(check, probe, startedUrl));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = /no host browser|cancelled|debug port|fetch failed|econnrefused/i.test(message);
    return {
      required: true,
      ok: false,
      unavailable: unavailable ? message : undefined,
      fingerprint,
      failures: unavailable ? [] : [{
        checkId: 'runner',
        assertion: 'page scenario',
        expected: 'probe completed',
        actual: message,
      }],
      summary: unavailable
        ? `behavioral verification unavailable: ${message}`
        : `behavioral verification failed: ${message}`,
    };
  }
  if (failures.length === 0) {
    return {
      required: true,
      ok: true,
      fingerprint,
      failures: [],
      summary: `behavioral verification passed (${plan.checks.length} check(s))`,
    };
  }
  const first = failures[0];
  return {
    required: true,
    ok: false,
    fingerprint,
    failures,
    summary: [
      `behavioral verification failed: check ${first.checkId}`,
      `assertion ${first.assertion}`,
      `expected ${first.expected}`,
      `actual ${first.actual}`,
      failures.length > 1 ? `(${failures.length - 1} more)` : '',
    ].filter(Boolean).join('; '),
  };
}

export function applyVerificationResult<T extends {
  verificationRequired?: boolean;
  verificationPassed?: boolean;
  verificationFingerprint?: string;
  lastVerificationSummary?: string;
}>(evidence: T, result: VerificationResult): T {
  return {
    ...evidence,
    verificationRequired: result.required,
    verificationPassed: result.ok && !result.unavailable,
    verificationFingerprint: result.ok ? result.fingerprint : undefined,
    lastVerificationSummary: result.summary,
  };
}

export function invalidateVerification<T extends {
  verificationPassed?: boolean;
  verificationFingerprint?: string;
  lastVerificationSummary?: string;
}>(evidence: T): T {
  return {
    ...evidence,
    verificationPassed: false,
    verificationFingerprint: undefined,
    lastVerificationSummary: undefined,
  };
}

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { completionRefusal } from '../runtime/missionObservations';
import { executeMissionAction } from '../runtime/missionLoop';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import {
  applyVerificationResult,
  evaluateExpectations,
  fingerprintVerificationSources,
  invalidateVerification,
  isVisuallyHidden,
  loadVerificationPlan,
  resolvePlanViewport,
  runMissionVerification,
  type VerificationCheck,
  type VerificationPlan,
} from '../runtime/missionVerification';
import { locatorRef } from '../runtime/pageLocator';
import type { MissionEnvelope } from '../runtime/scopedCommand';
import type { PageProbe } from '../runtime/browserInspection';

const PLAN: VerificationPlan = {
  version: 1,
  page: 'index.html',
  acceptanceCriteria: [
    'Calculation displays 10 / 110 / 55',
    'Reset clears inputs and hides results',
    'Reset clears a displayed validation error',
    'Focus returns to the bill input',
    'Mouse and keyboard activate Reset',
    'No page reload',
  ],
  dependsOn: ['index.html', 'src/app.js', 'styles.css'],
  checks: [
    {
      id: 'calculate-split',
      steps: [
        { action: 'fill', selector: '#bill', value: '100' },
        { action: 'fill', selector: '#tip-percent', value: '10' },
        { action: 'fill', selector: '#people', value: '2' },
        { action: 'click', selector: 'button[type=submit]' },
      ],
      expect: [
        { kind: 'text', selector: '#tip-amount', equals: '$10.00' },
        { kind: 'text', selector: '#total', equals: '$110.00' },
        { kind: 'text', selector: '#per-person', equals: '$55.00' },
        { kind: 'visible', selector: '#results', visible: true },
      ],
    },
    {
      id: 'reset-mouse',
      steps: [
        { action: 'fill', selector: '#bill', value: '100' },
        { action: 'fill', selector: '#tip-percent', value: '10' },
        { action: 'fill', selector: '#people', value: '2' },
        { action: 'click', selector: 'button[type=submit]' },
        { action: 'click', selector: '#reset' },
      ],
      expect: [
        { kind: 'value', selector: '#bill', equals: '' },
        { kind: 'value', selector: '#tip-percent', equals: '' },
        { kind: 'value', selector: '#people', equals: '' },
        { kind: 'visible', selector: '#results', visible: false },
        { kind: 'focus', selector: '#bill' },
        { kind: 'url', unchanged: true },
      ],
    },
  ],
};

function writePlan(dir: string, plan: VerificationPlan = PLAN): void {
  fs.mkdirSync(path.join(dir, '.karkedikha'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.karkedikha', 'verification-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
}

function writeCalculator(dir: string, kind: 'html-only' | 'css-visible' | 'working'): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tip calculator</title>
<link rel="stylesheet" href="styles.css"></head>
<body>
<form id="tip-form">
<input id="bill" value="86.50">
<input id="tip-percent" value="18">
<input id="people" value="4">
<button type="submit">Calculate</button>
<button type="button" id="reset">Reset</button>
</form>
<p id="error" hidden></p>
<section id="results" hidden>
<div>Tip: <strong id="tip-amount"></strong></div>
<div>Total: <strong id="total"></strong></div>
<div>Per person: <strong id="per-person"></strong></div>
</section>
<script type="module" src="src/app.js"></script>
</body></html>
`);
  fs.writeFileSync(path.join(dir, 'styles.css'), kind === 'working'
    ? '#results { display: grid; } #results[hidden], #error[hidden] { display: none; }\n'
    : '#results { display: grid; }\n');
  const resetJs = kind === 'html-only' ? '' : `
const resetButton = document.getElementById('reset');
resetButton.addEventListener('click', () => {
  bill.value = '';
  tip.value = '';
  people.value = '';
  results.hidden = true;
  errorEl.textContent = '';
  errorEl.hidden = true;
  bill.focus();
});
`;
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), `
const form = document.getElementById('tip-form');
const errorEl = document.getElementById('error');
const results = document.getElementById('results');
const bill = document.getElementById('bill');
const tip = document.getElementById('tip-percent');
const people = document.getElementById('people');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!bill.value.trim()) {
    errorEl.textContent = 'Bill amount is required.';
    errorEl.hidden = false;
    results.hidden = true;
    return;
  }
  errorEl.hidden = true;
  document.getElementById('tip-amount').textContent = '$10.00';
  document.getElementById('total').textContent = '$110.00';
  document.getElementById('per-person').textContent = '$55.00';
  results.hidden = false;
});
${resetJs}
`);
  writePlan(dir);
}

describe('plan viewports', () => {
  it('runs each check at the viewport declared in the plan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-viewport-'));
    try {
      const seen: Array<{ width?: number; height?: number }> = [];
      writePlan(dir, {
        version: 1,
        page: 'index.html',
        acceptanceCriteria: ['Desktop and mobile widths'],
        dependsOn: ['index.html'],
        checks: [
          {
            id: 'desktop-width',
            viewportWidth: 1280,
            viewportHeight: 800,
            steps: [],
            expect: [{ kind: 'url', unchanged: true }],
          },
          {
            id: 'mobile-width',
            viewportWidth: 390,
            viewportHeight: 844,
            steps: [],
            expect: [{ kind: 'url', unchanged: true }],
          },
        ],
      });
      const result = await runMissionVerification({
        workspaceRoot: dir,
        runner: async (request) => {
          seen.push({ width: request.viewportWidth, height: request.viewportHeight });
          return {
            url: 'http://127.0.0.1:9/index.html',
            startedUrl: 'http://127.0.0.1:9/index.html',
            title: 'Workspace page',
            focusId: null,
            navigationType: 'navigate',
            loadMarker: 1,
            loadMarkerAtStart: 1,
            elements: {},
          };
        },
      });
      expect(result.ok).toBe(true);
      expect(seen).toEqual([
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses bounded defaults for invalid or unsafe viewport values', () => {
    expect(resolvePlanViewport({})).toEqual({});
    expect(resolvePlanViewport({ viewportWidth: 1280, viewportHeight: 800 })).toEqual({
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(resolvePlanViewport({ viewportWidth: 390, viewportHeight: 844 })).toEqual({
      viewportWidth: 390,
      viewportHeight: 844,
    });
    expect(resolvePlanViewport({ viewportWidth: 0, viewportHeight: Number.NaN })).toEqual({
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(resolvePlanViewport({ viewportWidth: -12, viewportHeight: Infinity })).toEqual({
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(resolvePlanViewport({ viewportWidth: 10, viewportHeight: 99999 })).toEqual({
      viewportWidth: 320,
      viewportHeight: 1200,
    });
  });
});

describe('behavioral verification assertions', () => {
  it('evaluates filter buttons by role and name instead of secret IDs', () => {
    const unread = locatorRef({ role: 'button', name: 'Unread' });
    const all = locatorRef({ role: 'button', name: 'All' });
    const check: VerificationCheck = {
      id: 'filters-visible',
      steps: [],
      expect: [
        { kind: 'text', locator: { role: 'button', name: 'All' }, equals: 'All' },
        { kind: 'text', locator: { role: 'button', name: 'Unread' }, equals: 'Unread' },
        { kind: 'visible', locator: { role: 'button', name: 'Unread' }, visible: true },
        { kind: 'pressed', locator: { role: 'button', name: 'Unread' }, pressed: true },
        { kind: 'pressed', locator: { role: 'button', name: 'All' }, pressed: false },
      ],
    };
    const probe: PageProbe = {
      url: 'http://127.0.0.1:9/index.html',
      startedUrl: 'http://127.0.0.1:9/index.html',
      title: 'Reading list',
      focusId: null,
      navigationType: 'navigate',
      loadMarker: 1,
      loadMarkerAtStart: 1,
      elements: {
        [all]: {
          found: true, value: '', text: 'All', hiddenAttr: false,
          display: 'inline-block', visibility: 'visible', opacity: '1', focused: false, pressed: false,
        },
        [unread]: {
          found: true, value: '', text: 'Unread', hiddenAttr: false,
          display: 'inline-block', visibility: 'visible', opacity: '1', focused: false, pressed: true,
        },
      },
    };
    expect(evaluateExpectations(check, probe, probe.startedUrl ?? probe.url)).toEqual([]);
  });

  it('does not treat a hidden attribute as hidden when CSS keeps the panel visible', () => {
    expect(isVisuallyHidden({
      found: true, value: '', text: 'Tip: $10.00', hiddenAttr: true,
      display: 'grid', visibility: 'visible', opacity: '1', focused: false,
    })).toBe(false);
    expect(isVisuallyHidden({
      found: true, value: '', text: '', hiddenAttr: true,
      display: 'none', visibility: 'visible', opacity: '1', focused: false,
    })).toBe(true);
  });

  it('rejects an HTML-only Reset that leaves inputs and results in place', () => {
    const probe: PageProbe = {
      url: 'http://127.0.0.1:9/index.html',
      startedUrl: 'http://127.0.0.1:9/index.html',
      title: 'Tip calculator',
      focusId: 'reset',
      navigationType: 'navigate',
      loadMarker: 1,
      loadMarkerAtStart: 1,
      elements: {
        '#bill': { found: true, value: '100', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
        '#tip-percent': { found: true, value: '10', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
        '#people': { found: true, value: '2', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
        '#results': { found: true, value: '', text: 'Tip: $10.00', hiddenAttr: false, display: 'grid', visibility: 'visible', opacity: '1', focused: false },
        '#tip-amount': { found: true, value: '', text: '$10.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
        '#total': { found: true, value: '', text: '$110.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
        '#per-person': { found: true, value: '', text: '$55.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
      },
    };
    const failures = evaluateExpectations(PLAN.checks[1], probe, probe.startedUrl ?? probe.url);
    expect(failures.some((item) => item.assertion.startsWith('value #bill'))).toBe(true);
    expect(failures.some((item) => item.assertion === 'visible #results')).toBe(true);
  });
});

describe('completion refuses missing behavioral verification', () => {
  it('refuses finish and commit when a plan exists and verification did not pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-gate-'));
    try {
      writeCalculator(dir, 'html-only');
      expect(loadVerificationPlan(dir)?.checks.length).toBeGreaterThan(0);
      const evidence = {
        approvedMutation: true,
        approvedPath: 'index.html',
        validationPassed: true,
        validationCommand: 'npm run test',
        validationExitCode: 0,
        verificationRequired: true,
        verificationPassed: false,
        lastVerificationSummary: 'behavioral verification failed: check reset-mouse; assertion value #bill; expected ; actual 100',
        diffReview: 'pass' as const,
        commitSha: 'abc1234',
        deliveryStatus: 'local_commit' as const,
      };
      expect(completionRefusal(evidence)).toMatch(/behavioral verification/);
      const envelope: MissionEnvelope = {
        workspaceRoot: dir, pushAuthorized: false, networkAuthorized: false, installAuthorized: false,
      };
      const finished = executeMissionAction({
        action: { action: 'finish', summary: 'Reset added and tests passed' },
        envelope,
        evidence: { ...evidence, commitSha: 'abc1234', deliveryStatus: 'local_commit' },
      });
      expect(finished.complete).toBeUndefined();
      expect(finished.observation.ok).toBe(false);
      expect(finished.observation.output).toMatch(/behavioral verification/);
      const committed = executeMissionAction({
        action: { action: 'run_check', check: 'commit' },
        envelope,
        evidence: { ...evidence, commitSha: undefined, deliveryStatus: undefined },
      });
      expect(committed.complete).toBeUndefined();
      expect(committed.observation.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidates verification evidence after a later edit fingerprint change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-fp-'));
    try {
      writeCalculator(dir, 'html-only');
      const before = fingerprintVerificationSources(dir, PLAN.dependsOn);
      fs.appendFileSync(path.join(dir, 'src', 'app.js'), '\n// edit\n');
      const after = fingerprintVerificationSources(dir, PLAN.dependsOn);
      expect(after).not.toBe(before);
      const cleared = invalidateVerification({
        verificationPassed: true,
        verificationFingerprint: before,
        lastVerificationSummary: 'passed',
      });
      expect(cleared.verificationPassed).toBe(false);
      expect(cleared.verificationFingerprint).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the failed check and actual result from a mocked HTML-only page', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-html-'));
    try {
      writeCalculator(dir, 'html-only');
      const result = await runMissionVerification({
        workspaceRoot: dir,
        runner: async ({ steps }) => {
          const resetClicked = steps.some((step) => step.action === 'click' && step.selector === '#reset');
          return {
            url: 'http://127.0.0.1:9/index.html',
            startedUrl: 'http://127.0.0.1:9/index.html',
            title: 'Tip calculator',
            focusId: resetClicked ? 'reset' : 'bill',
            navigationType: 'navigate',
            loadMarker: 1,
            loadMarkerAtStart: 1,
            elements: {
              '#bill': { found: true, value: '100', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
              '#tip-percent': { found: true, value: '10', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
              '#people': { found: true, value: '2', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
              '#results': { found: true, value: '', text: 'Tip: $10.00', hiddenAttr: false, display: 'grid', visibility: 'visible', opacity: '1', focused: false },
              '#tip-amount': { found: true, value: '', text: '$10.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
              '#total': { found: true, value: '', text: '$110.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
              '#per-person': { found: true, value: '', text: '$55.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
            },
          };
        },
      });
      expect(result.required).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/reset-mouse/);
      expect(result.summary).toMatch(/actual 100/);
      const evidence = applyVerificationResult({
        approvedMutation: true,
        validationPassed: true,
        diffReview: 'pass' as const,
      }, result);
      expect(completionRefusal({
        ...evidence,
        commitSha: 'deadbee',
        deliveryStatus: 'local_commit',
      })).toMatch(/behavioral verification/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a CSS-visible result panel as a failed visibility check', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-css-'));
    try {
      writeCalculator(dir, 'css-visible');
      const result = await runMissionVerification({
        workspaceRoot: dir,
        runner: async ({ steps }) => {
          const resetClicked = steps.some((step) => step.action === 'click' && step.selector === '#reset');
          return {
            url: 'http://127.0.0.1:9/index.html',
            startedUrl: 'http://127.0.0.1:9/index.html',
            title: 'Tip calculator',
            focusId: resetClicked ? 'bill' : 'bill',
            navigationType: 'navigate',
            loadMarker: 1,
            loadMarkerAtStart: 1,
            elements: {
              '#bill': { found: true, value: resetClicked ? '' : '100', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: resetClicked },
              '#tip-percent': { found: true, value: resetClicked ? '' : '10', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
              '#people': { found: true, value: resetClicked ? '' : '2', text: '', hiddenAttr: false, display: 'inline-block', visibility: 'visible', opacity: '1', focused: false },
              '#results': {
                found: true, value: '', text: 'Tip: $10.00', hiddenAttr: true,
                display: 'grid', visibility: 'visible', opacity: '1', focused: false,
              },
              '#tip-amount': { found: true, value: '', text: '$10.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
              '#total': { found: true, value: '', text: '$110.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
              '#per-person': { found: true, value: '', text: '$55.00', hiddenAttr: false, display: 'inline', visibility: 'visible', opacity: '1', focused: false },
            },
          };
        },
      });
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/visible #results/);
      expect(result.summary).toMatch(/display=grid/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live host browser negative cases', () => {
  const browserBin = resolveHostBrowserBin();

  it('fails HTML-only Reset against the current files', async () => {
    if (!browserBin) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-live-html-'));
    try {
      writeCalculator(dir, 'html-only');
      const tests = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', windowsHide: true });
      expect(tests.status === 0 || tests.status === 1).toBe(true);
      const result = await runMissionVerification({ workspaceRoot: dir, browserBin });
      if (result.unavailable) return;
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/reset-mouse|selector not found|value #bill/i);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser profile may still be unlocking */ }
    }
  }, 60_000);

  it('fails a Reset that only sets hidden while CSS keeps results visible', async () => {
    if (!browserBin) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-live-css-'));
    try {
      writeCalculator(dir, 'css-visible');
      const result = await runMissionVerification({ workspaceRoot: dir, browserBin });
      if (result.unavailable) return;
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/visible #results|display=grid/);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser profile may still be unlocking */ }
    }
  }, 60_000);

  it('finds filter buttons by role and visible name without secret IDs', async () => {
    if (!browserBin) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-verify-live-locators-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Reading list</title></head>
<body>
  <div class="filters">
    <button type="button" class="filter-btn" data-filter="all">All</button>
    <button type="button" class="filter-btn" data-filter="unread" aria-pressed="true">Unread</button>
    <button type="button" class="filter-btn" data-filter="read">Read</button>
  </div>
  <form id="book-form"><label for="book-input">Title</label><input id="book-input"><button type="submit">Add</button></form>
  <ul id="book-list"></ul>
</body></html>
`);
      writePlan(dir, {
        version: 1,
        page: 'index.html',
        acceptanceCriteria: ['All, Unread, and Read filters are visible'],
        dependsOn: ['index.html'],
        checks: [
          {
            id: 'filters-by-name',
            steps: [
              { action: 'click', locator: { role: 'button', name: 'Unread' } },
            ],
            expect: [
              { kind: 'text', locator: { role: 'button', name: 'All' }, equals: 'All' },
              { kind: 'text', locator: { role: 'button', name: 'Unread' }, equals: 'Unread' },
              { kind: 'text', locator: { role: 'button', name: 'Read' }, equals: 'Read' },
              { kind: 'visible', locator: { role: 'button', name: 'Unread' }, visible: true },
              { kind: 'pressed', locator: { role: 'button', name: 'Unread' }, pressed: true },
              { kind: 'value', selector: '#book-input', equals: '' },
            ],
          },
        ],
      });
      const result = await runMissionVerification({ workspaceRoot: dir, browserBin });
      if (result.unavailable) return;
      expect(result.ok).toBe(true);
      expect(result.summary).toMatch(/passed/);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser profile may still be unlocking */ }
    }
  }, 60_000);
});

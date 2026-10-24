// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { deriveValidationEnvelope } from '../../coding/ValidationFloor';
import { CodingValidationRunner } from '../../coding/ValidationRunner';
import { isTestPath } from '../../context/RepositoryIndex';
import { validationFailureFacts } from '../../autonomous/recovery/FailureClassifier';

const BUGGY = `from decimal import Decimal

def calculate_total(subtotal, coupon, loyalty_percent):
    subtotal = Decimal(str(subtotal))
    coupon = Decimal(str(coupon))
    loyalty_percent = Decimal(str(loyalty_percent))

    # BUG: loyalty is applied before coupon
    discounted = subtotal * (1 - loyalty_percent / 100)
    return discounted - coupon
`;
const FIXED = `from decimal import Decimal

def calculate_total(subtotal, coupon, loyalty_percent):
    subtotal = Decimal(str(subtotal))
    coupon = Decimal(str(coupon))
    loyalty_percent = Decimal(str(loyalty_percent))

    after_coupon = max(subtotal - coupon, Decimal("0"))
    return after_coupon * (1 - loyalty_percent / 100)
`;
const TESTS = `from decimal import Decimal
from pricing import calculate_total

def test_no_discounts():
    assert calculate_total(100, 0, 0) == Decimal("100")

def test_coupon_first():
    assert calculate_total(100, 10, 20) == Decimal("72")

def test_coupon_exceeds_subtotal():
    assert calculate_total(50, 100, 10) == Decimal("0")

def test_loyalty_only():
    assert calculate_total(100, 0, 20) == Decimal("80")
`;

describe('P1.1 defect 1: python validator selection', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'p11-pricing-'));
    await fs.writeFile(path.join(root, 'pricing.py'), BUGGY);
    await fs.writeFile(path.join(root, 'test_pricing.py'), TESTS);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('recognises test_*.py as a test path (root cause: the floor never saw test_pricing.py)', () => {
    expect(isTestPath('test_pricing.py')).toBe(true);
    expect(isTestPath('pkg/test_pricing.py')).toBe(true);
    expect(isTestPath('pricing.py')).toBe(false);
    expect(isTestPath('latest_pricing.py')).toBe(false);
  });

  it('floors pytest and drops the inapplicable npm test in a manifest-less Python workspace', async () => {
    const envelope = await deriveValidationEnvelope({
      workspaceRoot: root,
      changedPaths: ['pricing.py'],
      modelCommands: [{ kind: 'npm-test' }, { kind: 'git-diff-check' }],
    });
    expect(envelope.commands).toEqual([{ kind: 'pytest', args: ['test_pricing.py'] }, { kind: 'git-diff-check' }]);
    expect(envelope.inapplicableDropped).toEqual([{ kind: 'npm-test' }]);
    expect(envelope.reasons.join('\n')).toContain('package.json was not found in the workspace');
    expect(envelope.confidence).toBe('semantic');
  });

  it('falls back to the repo python tests when none is linked to the changed module', async () => {
    await fs.rename(path.join(root, 'test_pricing.py'), path.join(root, 'test_checks.py'));
    const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['pricing.py'], modelCommands: [] });
    expect(envelope.commands[0]).toEqual({ kind: 'pytest', args: ['test_checks.py'] });
  });

  it('keeps JavaScript validation: a declared npm test script is not dropped', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    await fs.writeFile(path.join(root, 'a.js'), 'module.exports = 1;\n');
    const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['a.js'], modelCommands: [{ kind: 'npm-test' }] });
    expect(envelope.commands.map(command => command.kind)).toEqual(['node-check', 'npm-test']);
    expect(envelope.inapplicableDropped).toEqual([]);
  });

  it('never weakens the floor: a model that only asks for npm test still gets pytest', async () => {
    const envelope = await deriveValidationEnvelope({ workspaceRoot: root, changedPaths: ['pricing.py'], modelCommands: [{ kind: 'npm-script', script: 'verify' }] });
    expect(envelope.commands.some(command => command.kind === 'pytest')).toBe(true);
  });

  it('really executes pytest: 2 failed before the fix, 4 passed after, recorded as real execution output', async () => {
    const runner = new CodingValidationRunner(root, 60_000);
    const before = await runner.runAll([{ kind: 'pytest', args: ['-q', 'test_pricing.py'] }]);
    expect(before[0].exitCode).not.toBe(0);
    expect(before[0].output).toContain('2 failed, 2 passed');
    await fs.writeFile(path.join(root, 'pricing.py'), FIXED);
    const after = await runner.runAll([{ kind: 'pytest', args: ['-q', 'test_pricing.py'] }]);
    expect(after[0].exitCode).toBe(0);
    expect(after[0].output).toContain('4 passed');
    expect(after[0].command).toBe('pytest -q test_pricing.py');
  }, 120_000);

  it('classifies missing tooling as an environment blocker, not a code defect', () => {
    const facts = validationFailureFacts([
      { command: 'pytest', exitCode: 1, durationMs: 1, timedOut: false, output: '/usr/bin/python: No module named pytest' },
      { command: 'pytest', exitCode: null, durationMs: 0, timedOut: false, output: 'validation-tool-unavailable: could not start pytest: spawn python ENOENT' },
    ]);
    expect(facts.map(fact => fact.kind)).toEqual(['environment', 'tool_failure']); // both route to environment_failure, never code_defect
  });
});

describe('P1.1 defect 2: supervision strip shows the frozen task policy', () => {
  const media = path.join(__dirname, '../../../media');
  const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
  const strip = () => document.getElementById('oc-supervision')!.textContent;

  beforeEach(async () => {
    const html = await fs.readFile(path.join(media, 'chat.html'), 'utf8');
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
    (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = { postMessage: () => undefined, getState: () => ({}), setState: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(await fs.readFile(path.join(media, 'chat-operator-context.js'), 'utf8'))();
  });

  it('a running Hands-off task is not displayed as Ask me after the composer resets', () => {
    const select = document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    select.value = 'supervised'; // the composer resets after submit
    post({ type: 'autonomousTaskStarted', taskId: 't1', autonomyMode: 'hands_off' });
    expect(strip()).toBe('Hands-off (running task) · next task: Ask me');
    post({ type: 'autonomousTaskStatus', taskId: 't1', state: 'running', autonomyMode: 'hands_off' });
    expect(strip()).toContain('Hands-off (running task)');
  });

  it('an Ask-me task is never shown as upgraded when the next selection is Hands-off', () => {
    const select = document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    post({ type: 'autonomousTaskStarted', taskId: 't2', autonomyMode: 'supervised' });
    select.value = 'hands_off';
    select.dispatchEvent(new Event('change'));
    expect(strip()).toBe('Ask me (running task) · next task: Hands-off');
  });

  it('agrees plainly when policies match and falls back to the selector once the task ends', () => {
    post({ type: 'autonomousTaskStarted', taskId: 't3', autonomyMode: 'supervised' });
    expect(strip()).toBe('Ask me');
    post({ type: 'autonomousTaskStarted', taskId: 't4', autonomyMode: 'hands_off' });
    post({ type: 'autonomousTaskStatus', taskId: 't4', state: 'completed', autonomyMode: 'hands_off' });
    expect(strip()).toBe('Ask me');
  });
});

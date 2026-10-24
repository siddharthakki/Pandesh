// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleAutonomousTaskResult, resolveUnderRoot, saathEvidenceFromDurableRecords, terminalOutcomeForResult, type AssemblableTask } from '../../ui/taskResultAssembly';
import { reconcileOutcome } from '../../../core/platform/artifacts/taskResult';

const media = path.join(__dirname, '../../../media');

describe('TaskResult assembly: success must match execution evidence', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-result-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const task = (over: Partial<AssemblableTask> = {}): AssemblableTask => ({
    taskId: 't1', attemptId: 'a1', state: 'completed', repositoryRoot: root,
    providerModelRoutingSnapshot: { provider: 'ollama', model: 'qwen3-coder' },
    mutationEvidence: { expectedPaths: ['dashboard.html'], changedPaths: ['dashboard.html'] },
    ...over,
  });

  it('G1: a created HTML file becomes a real artifact that points at the authoritative file', () => {
    fs.writeFileSync(path.join(root, 'dashboard.html'), '<h1>Hi</h1>');
    const result = assembleAutonomousTaskResult(task(), { workspaceRoot: root, proposedOperations: new Map([['dashboard.html', 'create_file']]) })!;
    expect(result.status).toBe('completed');
    expect(result.changes).toEqual({ created: ['dashboard.html'], modified: [], deleted: [] });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ type: 'html', path: 'dashboard.html', title: 'dashboard.html', sizeBytes: 11 });
    expect(result.artifacts[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifacts[0].content).toBeUndefined(); // reference, not a copy
    expect(result.actions.some(a => a.kind === 'open-file' && a.artifactId === result.artifacts[0].id)).toBe(true);
    expect(result.origin).toMatchObject({ taskId: 't1', attemptId: 'a1', model: 'qwen3-coder', provider: 'ollama' });
  });

  it('G4: the runtime says completed but the promised file does not exist => NOT completed, no fabricated artifact', () => {
    const result = assembleAutonomousTaskResult(task(), { workspaceRoot: root })!;
    expect(result.status).toBe('partial');
    expect(result.artifacts).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('Promised but not found: dashboard.html');
    expect(terminalOutcomeForResult(result).outcome).toBe('blocked');
  });

  it('G2: failed validation is not green, and the produced file stays distinguishable from a validated one', () => {
    fs.writeFileSync(path.join(root, 'dashboard.html'), '<h1>Hi</h1>');
    const failing = assembleAutonomousTaskResult(task({ deliveryValidation: { status: 'failed', results: [{ command: 'npm test', exitCode: 1, timedOut: false }] } }), { workspaceRoot: root })!;
    expect(failing.status).toBe('partial');
    expect(failing.validationStatus).toBe('failed');
    expect(failing.artifacts).toHaveLength(1);
    expect(failing.commands).toEqual(['npm test']);
    expect(terminalOutcomeForResult(failing).outcome).toBe('failed');

    const passing = assembleAutonomousTaskResult(task({ deliveryValidation: { status: 'passed', results: [{ command: 'npm test', exitCode: 0, timedOut: false }] } }), { workspaceRoot: root })!;
    expect(passing.status).toBe('completed');
    expect(passing.validationStatus).toBe('passed');
    expect(terminalOutcomeForResult(passing).outcome).toBe('completed');
  });

  it('a validation failure record with no captured label or exit code still counts as a failed validation (never throws)', () => {
    fs.writeFileSync(path.join(root, 'dashboard.html'), 'x');
    const result = assembleAutonomousTaskResult(task({ validationFailure: { message: 'verify-fails exited 1' } as never }), { workspaceRoot: root })!;
    expect(result.validationStatus).toBe('failed');
    expect(result.status).toBe('partial');
  });

  it('blocked before mutation is distinct from a successful change; a failure is never upgraded by evidence', () => {
    const blocked = assembleAutonomousTaskResult(task({ state: 'blocked', mutationEvidence: undefined, failure: { classification: 'x', message: 'Could not start' } }), { workspaceRoot: root })!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.changes).toEqual({ created: [], modified: [], deleted: [] });
    expect(blocked.artifacts).toEqual([]);
    fs.writeFileSync(path.join(root, 'dashboard.html'), 'x');
    const failed = assembleAutonomousTaskResult(task({ state: 'failed' }), { workspaceRoot: root })!;
    expect(failed.status).toBe('failed');
  });

  it('a still-running task has no result; a recorded change whose file is missing is not claimed as an artifact', () => {
    expect(assembleAutonomousTaskResult(task({ state: 'running' }), { workspaceRoot: root })).toBeUndefined();
    const result = assembleAutonomousTaskResult(task({ mutationEvidence: { expectedPaths: [], changedPaths: ['ghost.md'] } }), { workspaceRoot: root })!;
    expect(result.artifacts).toEqual([]);
    expect(result.changes?.modified).toEqual([]);
  });

  it('delete operations are recorded as deletions when the file is really gone', () => {
    const result = assembleAutonomousTaskResult(task({ mutationEvidence: { expectedPaths: [], changedPaths: ['old.txt'] } }), { workspaceRoot: root, proposedOperations: new Map([['old.txt', 'delete_file']]) })!;
    expect(result.changes?.deleted).toEqual(['old.txt']);
    expect(result.status).toBe('completed');
  });

  it('paths cannot escape the workspace root', () => {
    expect(resolveUnderRoot(root, '../secret.txt')).toBeUndefined();
    expect(resolveUnderRoot(root, 'C:\\Windows\\win.ini')).toBeUndefined();
    expect(resolveUnderRoot(root, '/etc/passwd')).toBeUndefined();
    expect(resolveUnderRoot(root, 'src/a.ts')).toBe(path.resolve(root, 'src/a.ts'));
  });

  it('reconcileOutcome never upgrades a non-completed claim', () => {
    expect(reconcileOutcome({ claimed: 'failed', promisedPaths: [], exists: () => true, validationStatus: 'passed', mutated: true }).status).toBe('failed');
    expect(reconcileOutcome({ claimed: 'completed', promisedPaths: [], exists: () => true, validationStatus: 'none_recorded', mutated: false }).warnings).toContain('No file changes were made.');
  });
});

describe('artifact card (webview)', () => {
  it('renders status, validation, the artifact path and Open/Reveal/Copy actions that carry only ids', () => {
    document.body.innerHTML = '<div id="messages"></div>';
    const posted: Array<Record<string, any>> = [];
    (window as any).__ollamaAgentVsCodeApi = { postMessage: (m: Record<string, any>) => posted.push(m), getState: () => ({}), setState: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(fs.readFileSync(path.join(media, 'chat-result-card.js'), 'utf8'))();
    const result = {
      status: 'partial', summary: 'Incomplete: Validation failed.', validationStatus: 'failed', warnings: ['Validation failed.'],
      artifacts: [{ id: 'art-1', type: 'html', title: 'dashboard.html', path: 'dashboard.html', sizeBytes: 11, evidenceIds: [] }],
      validations: [{ id: 'v', ok: false, summary: 'npm test → exit 1' }], commands: ['npm test'], changes: { created: ['dashboard.html'], modified: [], deleted: [] },
    };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'autonomousTaskStatus', taskId: 't1', taskResult: result } }));
    const card = document.querySelector('.kd-result-card')!;
    // G3: rendering a (historical or live) result is inert - it posts nothing and starts nothing.
    expect(posted).toEqual([]);
    expect(card.textContent).toContain('Incomplete');
    expect(card.textContent).toContain('Validation failed');
    expect(card.textContent).toContain('dashboard.html');
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Open', 'Preview', 'Open in browser', 'Reveal', 'Copy path']);
    buttons[0].click();
    expect(posted).toEqual([{ type: 'taskResultAction', action: 'open', taskId: 't1', artifactId: 'art-1' }]);
    // Re-delivery of the same status replaces the card in place (idempotent, quiet).
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'autonomousTaskStatus', taskId: 't1', taskResult: result } }));
    expect(document.querySelectorAll('.kd-result-card')).toHaveLength(1);
  });
});

describe('Saath Kar evidence re-derived from durable Core records', () => {
  const action = (requestedAt: string, filePath: string, outcome = 'succeeded', baseline = 'absent') => ({
    toolName: 'propose_file_change', outcome, requestedAt, arguments: { path: filePath },
    presentation: { kind: 'write_file_diff', path: filePath, baseline },
  });

  it('only counts actions inside the turn window (the anchor attempt is shared by every turn of the conversation)', () => {
    const evidence = saathEvidenceFromDurableRecords({
      attemptId: 'att_2', outcome: 'completed',
      actions: [action('2026-10-06T10:00:00.000Z', 'old.html'), action('2026-10-06T11:00:30.000Z', 'new.html', 'succeeded', 'present')],
      invocations: [],
      window: { from: '2026-10-06T11:00:00.000Z', to: '2026-10-06T11:01:00.000Z' },
    });
    expect(evidence.mutations).toEqual([{ path: 'new.html', ok: true, operation: 'modify_file' }]);
  });

  it('maps validation and the static structure check exactly as the live path does, and a failed action stays failed', () => {
    const evidence = saathEvidenceFromDurableRecords({
      attemptId: 'a', outcome: 'completed',
      actions: [action('2026-10-06T11:00:10.000Z', 'x.html', 'failed')],
      invocations: [
        { toolName: 'workspace_validation', status: 'failed', exitCode: 1, argsSummary: { gates: ['npm test'] } },
        { toolName: 'static_html_check', status: 'succeeded', exitCode: 0, argsSummary: { path: 'x.html' }, evidence: { output: 'ok\nmore' } },
      ],
      window: { from: '2026-10-06T11:00:00.000Z', to: null },
    });
    expect(evidence.mutations).toEqual([expect.objectContaining({ path: 'x.html', ok: false })]);
    expect(evidence.validations).toEqual([{ command: 'npm test', ok: false, exitCode: 1 }]);
    expect(evidence.structuralChecks).toEqual([{ path: 'x.html', ok: true, summary: 'ok' }]);
  });
});
